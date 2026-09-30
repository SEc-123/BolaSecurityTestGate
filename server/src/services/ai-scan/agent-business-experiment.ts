import { createHash, randomUUID } from 'node:crypto';
import { dbAll, dbRun } from '../../db/sql-helpers.js';
import { parseRawRequest } from '../execution-utils.js';
import { evaluateStepAssertions, executeWorkflowRun } from '../workflow-runner.js';
import { getTraceByRunId, type DebugTrace } from '../debug-trace.js';
import type { AgentToolContext } from '../../agent/tool-types.js';
import type { Workflow, WorkflowStep } from '../../types/index.js';
import { assertScanActive } from './run-control.js';
import {
  getAgentExperimentPlan,
  getAgentExperimentResult,
  getBusinessFlow,
  latestBusinessArtifact,
  saveAgentExperimentPlan,
  saveAgentExperimentResult,
  saveBusinessFlow,
  validateExperimentAssertions,
  type AgentExperimentPlan,
  type AgentExperimentResult,
  type BusinessAssertion,
  type RequestPatch,
} from './agent-business-contract.js';

type RequestLocation = RequestPatch['location'];

interface ExperimentCompilation {
  plan_id: string;
  plan_revision: number;
  flow_id: string;
  source_flow_revision: number;
  source_workflow_id: string;
  control_workflow_id: string;
  experiment_workflow_id: string;
  control_role: string;
  control_account_id?: string;
  normal_account_id?: string;
  /** Accounts loaded only for the mutated workflow and its explicit role
   * overlays. The control has its own single identity below. */
  experiment_account_ids: string[];
  selected_step_orders: number[];
  applied_patches: Array<Record<string, any>>;
  bindings: Array<Record<string, any>>;
  mutation_profile: Record<string, any>;
  created_at: string;
}

const MAX_PATCHES = 24;
const MAX_BINDINGS = 24;
const MAX_REPEAT = 12;
const MAX_CONCURRENCY = 12;
const forbiddenHeader = /^(host|cookie|authorization|proxy-authorization|content-length|connection)$/i;
const secretField = /(?:password|passwd|secret|authorization|cookie|(?:^|[_-])(token|csrf|ticket|otp|passcode|session)(?:$|[_-]))/i;
const sha = (value: unknown) => createHash('sha256').update(String(value ?? '')).digest('hex');

function plainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown, label: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be a nonempty string of at most ${max} characters.`);
  return value.trim();
}

function safeScalar(value: unknown, label: string): string {
  if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 4000) {
    throw new Error(`${label} must be a bounded string, number, or boolean.`);
  }
  return String(value);
}

function jsonPathParts(path: string): string[] {
  if (!/^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\d+))*$/.test(path)) throw new Error('JSON field paths must address an observed dotted field path.');
  return path.split('.');
}

function locateJson(root: any, path: string): { parent: Record<string, any> | any[]; key: string; value: any } {
  const parts = jsonPathParts(path);
  let current: any = root;
  for (const part of parts.slice(0, -1)) {
    if (!plainObject(current) && !Array.isArray(current)) throw new Error(`Request JSON path "${path}" was not observed.`);
    current = (current as any)[part];
    if (current === undefined || current === null) throw new Error(`Request JSON path "${path}" was not observed.`);
  }
  const key = parts.at(-1)!;
  if ((!plainObject(current) && !Array.isArray(current)) || !Object.prototype.hasOwnProperty.call(current, key)) {
    throw new Error(`Request JSON path "${path}" was not observed.`);
  }
  return { parent: current as any, key, value: (current as any)[key] };
}

function serializeRawRequest(request: { method: string; path: string; headers: Record<string, string>; body?: string }): string {
  const headers = Object.entries(request.headers)
    .filter(([name]) => !/^host$/i.test(name))
    .map(([name, value]) => `${name}: ${value}`);
  return [`${request.method} ${request.path} HTTP/1.1`, ...headers, '', request.body || ''].join('\r\n');
}

function patchRawRequest(raw: string, patch: RequestPatch): { raw: string; report: Record<string, any> } {
  if (patch.value_ref) throw new Error('Raw artifact value references are not supported in model experiments. Bind an observed response through a workflow mapping instead.');
  const path = asText(patch.path, 'Patch path', 300);
  const request = parseRawRequest(raw);
  if (!request) throw new Error('The recorded request snapshot cannot be parsed.');
  if (!['set', 'delete', 'append'].includes(patch.operation)) throw new Error('Unsupported patch operation.');
  if (!['query', 'header', 'json_body', 'form_body', 'path'].includes(patch.location)) throw new Error('Unsupported patch location.');
  if (patch.operation !== 'delete' && patch.value === undefined) throw new Error('A set or append patch requires a value.');
  const value = patch.operation === 'delete' ? '' : safeScalar(patch.value, 'Patch value');
  let before: unknown;

  if (patch.location === 'query') {
    const url = new URL(request.path, 'http://bstg.local');
    if (!url.searchParams.has(path)) throw new Error(`Query field "${path}" was not observed in this request.`);
    before = url.searchParams.get(path) || '';
    if (patch.operation === 'delete') url.searchParams.delete(path);
    else url.searchParams.set(path, patch.operation === 'append' ? `${before}${value}` : value);
    request.path = `${url.pathname}${url.search}`;
  } else if (patch.location === 'header') {
    if (forbiddenHeader.test(path)) throw new Error('Identity, host, and transport headers are bound by the native account/session executor and cannot be patched directly.');
    const key = Object.keys(request.headers).find(item => item.toLowerCase() === path.toLowerCase());
    if (!key) throw new Error(`Header "${path}" was not observed in this request.`);
    before = request.headers[key];
    if (patch.operation === 'delete') delete request.headers[key];
    else request.headers[key] = patch.operation === 'append' ? `${before}${value}` : value;
  } else if (patch.location === 'json_body') {
    if (!request.body) throw new Error(`JSON field "${path}" was not observed because the request has no body.`);
    let body: any;
    try { body = JSON.parse(request.body); } catch { throw new Error('The request body is not JSON; use form_body or a supported observed request type.'); }
    const node = locateJson(body, path); before = node.value;
    const parent = node.parent as any;
    if (patch.operation === 'delete') delete parent[node.key];
    else if (patch.operation === 'append') parent[node.key] = `${String(node.value)}${value}`;
    else if (typeof node.value === 'number' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) parent[node.key] = Number(value);
    else if (typeof node.value === 'boolean' && ['true', 'false'].includes(value)) parent[node.key] = value === 'true';
    else parent[node.key] = value;
    request.body = JSON.stringify(body);
  } else if (patch.location === 'form_body') {
    if (!request.body) throw new Error(`Form field "${path}" was not observed because the request has no body.`);
    const params = new URLSearchParams(request.body);
    if (!params.has(path)) throw new Error(`Form field "${path}" was not observed in this request.`);
    before = params.get(path) || '';
    if (patch.operation === 'delete') params.delete(path);
    else params.set(path, patch.operation === 'append' ? `${before}${value}` : value);
    request.body = params.toString();
  } else {
    const match = path.match(/^(?:segment\.|__bstg_segment_)(\d+)$/);
    if (!match) throw new Error('Path patches must use an observed segment.N or __bstg_segment_N location.');
    const index = Number(match[1]);
    const queryAt = request.path.indexOf('?');
    const pathOnly = queryAt < 0 ? request.path : request.path.slice(0, queryAt);
    const segments = pathOnly.split('/');
    if (!Number.isInteger(index) || index < 1 || index >= segments.length || !segments[index]) throw new Error(`Path segment ${index} was not observed.`);
    before = decodeURIComponent(segments[index]);
    if (patch.operation === 'delete') throw new Error('Deleting a path segment is not supported because it changes request routing; choose an observed field mutation instead.');
    segments[index] = encodeURIComponent(patch.operation === 'append' ? `${before}${value}` : value);
    request.path = segments.join('/') + (queryAt < 0 ? '' : request.path.slice(queryAt));
  }
  return { raw: serializeRawRequest(request), report: {
    location: patch.location, operation: patch.operation, path,
    before_sha256: sha(before), after_sha256: sha(patch.operation === 'delete' ? '' : value),
    sensitive_field: secretField.test(path),
  } };
}

function locationToMapping(location: RequestLocation): string {
  return location === 'header' ? 'request.header' : location === 'query' ? 'request.query' :
    location === 'path' ? 'request.path' : 'request.body';
}

function requestPathForLocation(location: RequestLocation, path: string): string {
  if (location === 'header') return path;
  if (location === 'query' || location === 'json_body' || location === 'form_body') return path;
  const match = path.match(/^(?:segment\.|__bstg_segment_)(\d+)$/);
  if (!match) throw new Error('Path binding must use an observed segment.N or __bstg_segment_N location.');
  return `[${Math.max(0, Number(match[1]) - 1)}]`;
}

function rawForStep(step: WorkflowStep): string {
  const raw = step.request_snapshot_raw || '';
  if (!raw.trim()) throw new Error(`Source workflow step ${step.step_order} has no immutable request snapshot.`);
  return raw;
}

function noId(value: Record<string, any>): Record<string, any> {
  const { id: _id, created_at: _created, updated_at: _updated, ...rest } = value;
  return rest;
}

async function cloneWorkflow(context: AgentToolContext, source: Workflow, name: string, input: {
  mode: 'control' | 'experiment';
  normalAccountId?: string;
  assertions: BusinessAssertion[];
  selectedStepOrders: Set<number>;
  patches?: Map<string, RequestPatch[]>;
  bindings?: AgentExperimentPlan['bindings'];
}): Promise<{ workflow: Workflow; steps: WorkflowStep[]; appliedPatches: Array<Record<string, any>> }> {
  const copied = await context.db.repos.workflows.create({
    ...noId(source as any), name, description: `Model-directed ${input.mode} snapshot of ${source.id}`,
    workflow_type: 'baseline', base_workflow_id: undefined, mutation_profile: undefined,
    template_mode: 'snapshot', assertion_strategy: 'all_steps_pass', critical_step_orders: [],
    account_binding_strategy: 'anchor_attacker', attacker_account_id: input.normalAccountId,
    enable_baseline: false, baseline_config: { capture_replay_only: true, agent_business_experiment: true },
  } as any);
  const sourceSteps = (await context.db.repos.workflowSteps.findAll({ where: { workflow_id: source.id } as any }))
    .sort((a, b) => a.step_order - b.step_order);
  const appliedPatches: Array<Record<string, any>> = [];
  const copiedSteps: WorkflowStep[] = [];
  for (const sourceStep of sourceSteps) {
    let raw = rawForStep(sourceStep);
    if (input.mode === 'experiment') {
      for (const patch of input.patches?.get(sourceStep.id) || []) {
        const changed = patchRawRequest(raw, patch);
        raw = changed.raw;
        appliedPatches.push({ step_id: sourceStep.id, step_order: sourceStep.step_order, ...changed.report });
      }
    }
    const stepAssertions = input.assertions.filter(item => item.step_order === sourceStep.step_order).map(item => ({ ...item, missing_behavior: 'fail' }));
    const step = await context.db.repos.workflowSteps.create({
      ...noId(sourceStep as any), workflow_id: copied.id, request_snapshot_raw: raw,
      step_assertions: stepAssertions, assertions_mode: 'all', snapshot_created_at: new Date().toISOString(),
    } as any);
    copiedSteps.push(step);
  }
  for (const repository of [context.db.repos.workflowVariableConfigs, context.db.repos.workflowExtractors] as const) {
    for (const row of await repository.findAll({ where: { workflow_id: source.id } as any })) {
      await repository.create({ ...noId(row as any), workflow_id: copied.id } as any);
    }
  }
  for (const table of ['workflow_variables', 'workflow_mappings']) {
    for (const row of await dbAll<Record<string, any>>(context.db, `SELECT * FROM ${table} WHERE workflow_id = ?`, [source.id])) {
      const fields = noId(row); const payload = { ...fields, id: randomUUID(), workflow_id: copied.id };
      const keys = Object.keys(payload);
      await dbRun(context.db, `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, Object.values(payload));
    }
  }
  if (input.mode === 'experiment' && input.bindings?.length) {
    await addExperimentBindings(context, copied.id, sourceSteps, input.bindings, input.selectedStepOrders);
  }
  return { workflow: copied, steps: copiedSteps, appliedPatches };
}

function responseMappingLocation(location: string): 'response.body' | 'response.header' {
  if (location === 'response.body') return 'response.body';
  if (location === 'response.header') return 'response.header';
  throw new Error('Bindings may source only an observed response.body or response.header value.');
}

async function addExperimentBindings(context: AgentToolContext, workflowId: string, sourceSteps: WorkflowStep[],
  bindings: NonNullable<AgentExperimentPlan['bindings']>, selected: Set<number>): Promise<void> {
  const ids = new Set(sourceSteps.map(step => step.id));
  const orderById = new Map(sourceSteps.map(step => [step.id, step.step_order]));
  for (const binding of bindings) {
    if (!ids.has(binding.from_step_id) || !ids.has(binding.to_step_id)) throw new Error('A binding must refer to an observed source workflow step.');
    const fromOrder = orderById.get(binding.from_step_id)!;
    const toOrder = orderById.get(binding.to_step_id)!;
    if (!selected.has(fromOrder) || !selected.has(toOrder) || fromOrder >= toOrder) throw new Error('A binding must flow from an earlier selected step to a later selected step.');
    const sourceLocation = responseMappingLocation(binding.from_location);
    const targetLocation = binding.to_location as RequestLocation;
    if (!['query', 'header', 'json_body', 'form_body', 'path'].includes(targetLocation)) throw new Error('A binding target location is unsupported.');
    if (targetLocation === 'header' && forbiddenHeader.test(binding.to_path)) throw new Error('A binding cannot write identity, host, or transport headers.');
    const variable = asText(binding.variable_name, 'Binding variable name', 100);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(variable)) throw new Error('Binding variable names must be simple identifiers.');
    const fromPath = asText(binding.from_path, 'Binding source path', 300);
    const toPath = requestPathForLocation(targetLocation, asText(binding.to_path, 'Binding target path', 300));
    await dbRun(context.db, `INSERT OR IGNORE INTO workflow_variables (id, workflow_id, name, type, source, write_policy, is_locked, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), workflowId, variable, 'GENERIC', 'extracted', 'overwrite', 0,
      `Model-selected observed binding from step ${fromOrder} to step ${toOrder}`]);
    await dbRun(context.db, `INSERT INTO workflow_mappings
      (id, workflow_id, from_step_order, from_location, from_path, to_step_order, to_location, to_path, variable_name, confidence, reason, is_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), workflowId, fromOrder, sourceLocation, fromPath, toOrder,
      locationToMapping(targetLocation), toPath, variable, 1, 'manual', 1]);
  }
}

async function resolveAccounts(context: AgentToolContext, source: Workflow, requestedRoles: string[]): Promise<{ normalAccountId?: string; accountIds: string[]; roles: Map<string, string> }> {
  const accounts = (await context.db.repos.accounts.findAll()).filter(account => (account.tags || []).includes(`scan:${context.scanRunId}`));
  const session = source.source_recording_session_id ? await context.db.repos.recordingSessions.findById(source.source_recording_session_id) : undefined;
  const normalAccountId = session?.account_id || undefined;
  const roles = new Map<string, string>();
  if (normalAccountId) roles.set('normal', normalAccountId);
  for (const role of ['attacker', 'victim', 'admin']) {
    const account = accounts.find(item => (item.tags || []).includes(`role:${role}`));
    if (account) roles.set(role, account.id);
  }
  for (const role of requestedRoles) {
    if (role.startsWith('account:')) {
      const id = role.slice('account:'.length);
      if (!accounts.some(account => account.id === id)) throw new Error(`Selected account ${id} is not owned by this assessment.`);
      roles.set(role, id);
    }
  }
  const missing = [...new Set(requestedRoles.filter(role => role !== 'normal' && !roles.get(role)))];
  if (missing.length) throw new Error(`The experiment needs prepared scan identities for: ${missing.join(', ')}.`);
  return { normalAccountId, accountIds: [...new Set([normalAccountId, ...requestedRoles.map(role => roles.get(role))].filter((id): id is string => Boolean(id)))], roles };
}

function roleForStep(role: unknown): string {
  const value = role === undefined || role === null || role === '' ? 'normal' : String(role);
  if (!['normal', 'attacker', 'victim', 'admin'].includes(value) && !/^account:[0-9a-f-]{8,}$/i.test(value)) {
    throw new Error('Step roles must be normal, attacker, victim, admin, or account:<assessment-account-id>.');
  }
  return value;
}

function validatePlanInput(context: AgentToolContext, flow: Awaited<ReturnType<typeof getBusinessFlow>>, sourceSteps: WorkflowStep[], input: Record<string, any>): AgentExperimentPlan {
  if (flow.status !== 'verified' || flow.assertions_verified !== true || !flow.normal_run_id || !flow.workflow_id) {
    throw new Error('Only a fresh, native-verified normal business flow may enter a model experiment.');
  }
  const stepsInput = Array.isArray(input.steps) ? input.steps : [];
  if (!stepsInput.length || stepsInput.length > sourceSteps.length) throw new Error('List every intended observed source step for this experiment.');
  const sourceById = new Map(sourceSteps.map(step => [step.id, step]));
  const chosen = new Set<string>();
  const steps = stepsInput.map((item: any) => {
    const id = asText(item?.id, 'Experiment step id', 200);
    const source = sourceById.get(id);
    if (!source || Number(item?.source_step_order) !== source.step_order || chosen.has(id)) throw new Error('Each experiment step must name a distinct actual source workflow step and its actual order.');
    chosen.add(id);
    return { id, source_step_order: source.step_order, role: roleForStep(item?.role) };
  }).sort((a, b) => a.source_step_order - b.source_step_order);
  const patchesInput = Array.isArray(input.patches) ? input.patches : [];
  if (patchesInput.length > MAX_PATCHES) throw new Error(`At most ${MAX_PATCHES} exact request patches are allowed per experiment.`);
  const patches = patchesInput.map((patch: any) => {
    const stepId = asText(patch?.step_id, 'Patch step id', 200);
    if (!chosen.has(stepId)) throw new Error('A request patch must target a selected observed step.');
    const location = String(patch?.location || '') as RequestLocation;
    const operation = String(patch?.operation || '') as RequestPatch['operation'];
    if (!['query', 'header', 'json_body', 'form_body', 'path'].includes(location) || !['set', 'delete', 'append'].includes(operation)) throw new Error('Patch location or operation is invalid.');
    return { step_id: stepId, location, operation, path: asText(patch?.path, 'Patch path', 300),
      ...(operation === 'delete' ? {} : { value: safeScalar(patch?.value, 'Patch value') }), ...(patch?.value_ref ? { value_ref: patch.value_ref } : {}) };
  });
  const bindingsInput = Array.isArray(input.bindings) ? input.bindings : [];
  if (bindingsInput.length > MAX_BINDINGS) throw new Error(`At most ${MAX_BINDINGS} observed response bindings are allowed per experiment.`);
  const bindings = bindingsInput.map((binding: any) => ({
    from_step_id: asText(binding?.from_step_id, 'Binding source step id', 200), from_location: asText(binding?.from_location, 'Binding source location', 40),
    from_path: asText(binding?.from_path, 'Binding source path', 300), to_step_id: asText(binding?.to_step_id, 'Binding target step id', 200),
    to_location: asText(binding?.to_location, 'Binding target location', 40), to_path: asText(binding?.to_path, 'Binding target path', 300),
    variable_name: asText(binding?.variable_name, 'Binding variable name', 100),
  }));
  const repeatsInput = Array.isArray(input.repeats) ? input.repeats : [];
  if (repeatsInput.length > steps.length) throw new Error('Each selected step can appear in repeats once.');
  const repeats = repeatsInput.map((item: any) => {
    const step_id = asText(item?.step_id, 'Repeat step id', 200), count = Number(item?.count);
    if (!chosen.has(step_id) || !Number.isInteger(count) || count < 1 || count > MAX_REPEAT) throw new Error(`Repeat count must be an integer from 1 to ${MAX_REPEAT} for a selected step.`);
    return { step_id, count };
  });
  if (new Set(repeats.map(item => item.step_id)).size !== repeats.length) throw new Error('A step may have only one repeat directive.');
  let concurrency: AgentExperimentPlan['concurrency'];
  if (input.concurrency !== undefined) {
    const step_id = asText(input.concurrency?.step_id, 'Concurrent step id', 200), count = Number(input.concurrency?.count);
    if (!chosen.has(step_id) || !Number.isInteger(count) || count < 2 || count > MAX_CONCURRENCY) throw new Error(`Concurrency must select one observed step and an integer count from 2 to ${MAX_CONCURRENCY}.`);
    concurrency = { step_id, count };
  }
  const parallelInput = Array.isArray(input.parallel) ? input.parallel : [];
  if (parallelInput.length > 6) throw new Error('At most six parallel groups are allowed.');
  const parallel = parallelInput.map((item: any) => {
    const anchor_step_id = asText(item?.anchor_step_id, 'Parallel anchor step id', 200);
    const extra_step_ids: string[] = Array.isArray(item?.extra_step_ids) ? item.extra_step_ids.map((id: unknown) => asText(id, 'Parallel extra step id', 200)) : [];
    if (!chosen.has(anchor_step_id) || !extra_step_ids.length || extra_step_ids.length > 6 || extra_step_ids.some(id => !chosen.has(id))) throw new Error('A parallel group must name one selected anchor and selected observed extra steps.');
    if (new Set(extra_step_ids).size !== extra_step_ids.length || extra_step_ids.includes(anchor_step_id)) throw new Error('Parallel extras must be distinct from the anchor.');
    return { anchor_step_id, extra_step_ids };
  });
  const assertions = validateExperimentAssertions(input.assertions, 'impact');
  const controlAssertions = validateExperimentAssertions(input.control_assertions, 'control');
  const changedRole = steps.some(step => step.role !== 'normal');
  if (!patches.length && !changedRole && !repeats.length && !concurrency && !parallel.length) throw new Error('An experiment must change a request, identity, sequence, replay count, concurrency, or parallel execution.');
  const id = input.plan_id ? asText(input.plan_id, 'Plan id', 200) : randomUUID();
  return {
    id, revision: 0, flow_id: flow.id, source_flow_revision: flow.revision, name: asText(input.name, 'Experiment name', 200),
    hypothesis: asText(input.hypothesis, 'Experiment hypothesis', 2000), category: typeof input.category === 'string' ? input.category.slice(0, 100) : undefined,
    steps, patches, bindings, repeats, concurrency, parallel, assertions, control_assertions: controlAssertions,
    control_role: roleForStep(input.control_role), rationale: asText(input.rationale, 'Experiment rationale', 3000),
    status: 'planned', parent_plan_id: input.parent_plan_id ? asText(input.parent_plan_id, 'Parent plan id', 200) : undefined, evidence_artifact_ids: [],
  } as AgentExperimentPlan;
}

export async function planBusinessExperiment(context: AgentToolContext, input: Record<string, any>): Promise<Record<string, any>> {
  assertScanActive();
  const flow = await getBusinessFlow(context.repo, context.scanRunId, asText(input.flow_id, 'Flow id', 200));
  if (!flow.workflow_id) throw new Error('This business flow has no native workflow to use as an experiment source.');
  const sourceSteps = (await context.db.repos.workflowSteps.findAll({ where: { workflow_id: flow.workflow_id } as any })).sort((a, b) => a.step_order - b.step_order);
  if (!sourceSteps.length) throw new Error('The verified normal business workflow has no steps.');
  const plan = validatePlanInput(context, flow, sourceSteps, input);
  if (input.plan_id) {
    const previous = await getAgentExperimentPlan(context.repo, context.scanRunId, plan.id);
    if (previous.flow_id !== flow.id) throw new Error('A revised plan must stay attached to its original business flow.');
  }
  if (plan.parent_plan_id) await getAgentExperimentPlan(context.repo, context.scanRunId, plan.parent_plan_id);
  const artifact = await saveAgentExperimentPlan(context.repo, context.scanRunId, context.taskId, plan);
  const saved = artifact.content_json as AgentExperimentPlan;
  return { plan_id: saved.id, plan_revision: saved.revision, flow_id: saved.flow_id, source_flow_revision: saved.source_flow_revision,
    status: saved.status, selected_step_orders: saved.steps.map(step => step.source_step_order), request_patch_count: saved.patches.length,
    binding_count: saved.bindings?.length || 0, repeat_count: saved.repeats?.length || 0, has_concurrency: Boolean(saved.concurrency), parallel_groups: saved.parallel?.length || 0,
    summary: 'The model experiment plan is recorded. Compile it into immutable native snapshots before execution.' };
}

function requiredRoles(plan: AgentExperimentPlan): string[] {
  return [...new Set([...plan.steps.map(step => step.role || 'normal'), plan.control_role || 'normal'])];
}

function mutationProfileFor(plan: AgentExperimentPlan, sourceSteps: WorkflowStep[], roles: Map<string, string>): Record<string, any> {
  const sourceOrders = new Set(sourceSteps.map(step => step.step_order));
  const selectedOrders = new Set(plan.steps.map(step => step.source_step_order));
  const byId = new Map(sourceSteps.map(step => [step.id, step]));
  const swap: Record<number, string> = {};
  for (const step of plan.steps) {
    if (step.role && step.role !== 'normal') swap[step.source_step_order] = roles.get(step.role)!;
  }
  const repeats: Record<number, number> = {};
  for (const repeat of plan.repeats || []) repeats[byId.get(repeat.step_id)!.step_order] = repeat.count;
  const profile: Record<string, any> = {
    model_directed: true, plan_id: plan.id, plan_revision: plan.revision,
    skip_steps: [...sourceOrders].filter(order => !selectedOrders.has(order)),
    ...(Object.keys(swap).length ? { swap_account_at_steps: swap } : {}),
    ...(Object.keys(repeats).length ? { repeat_steps: repeats } : {}),
  };
  if (plan.concurrency) profile.concurrent_replay = { step_order: byId.get(plan.concurrency.step_id)!.step_order, concurrency: plan.concurrency.count, barrier: true, pick_primary: 'first_success' };
  if (plan.parallel?.length) {
    profile.parallel_groups = plan.parallel.map(group => {
      const anchor = byId.get(group.anchor_step_id)!;
      const anchorRole = plan.steps.find(step => step.id === group.anchor_step_id)?.role || 'normal';
      const extras = group.extra_step_ids.map(id => {
        const source = byId.get(id)!;
        const extraRole = plan.steps.find(step => step.id === id)?.role || 'normal';
        if (extraRole !== anchorRole) throw new Error('The native parallel executor cannot silently substitute a different identity for an extra request. Use a separate model experiment for cross-identity parallel packets.');
        if (plan.patches.some(patch => patch.step_id === id) || (plan.bindings || []).some(binding => binding.to_step_id === id)) {
          throw new Error('A parallel extra with a model patch or dynamic binding is not yet representable by the native parallel executor. Split it into a separate experiment rather than silently replaying the unmodified request.');
        }
        return { kind: 'extra', name: `model_parallel_step_${source.step_order}`, snapshot_template_id: source.snapshot_template_id || source.api_template_id,
          snapshot_template_name: source.snapshot_template_name || `step ${source.step_order}`, request_snapshot_raw: rawForStep(source), repeat: 1 };
      });
      return { anchor_step_order: anchor.step_order, barrier: true, timeout_ms: 5000, extras, pick_primary: 'anchor_first_success', writeback_policy: 'primary_only' };
    });
  }
  return profile;
}

async function createMutationWorkflow(context: AgentToolContext, base: Workflow, name: string, anchorAccountId: string | undefined,
  profile: Record<string, any>): Promise<Workflow> {
  return context.db.repos.workflows.create({
    name, description: `Native model-directed execution of ${base.id}`, is_active: true, assertion_strategy: 'all_steps_pass', critical_step_orders: [],
    account_binding_strategy: 'anchor_attacker', attacker_account_id: anchorAccountId, enable_baseline: false,
    baseline_config: { capture_replay_only: true, agent_business_experiment: true }, enable_extractor: base.enable_extractor,
    enable_session_jar: base.enable_session_jar, session_jar_config: base.session_jar_config || { cookie_mode: true }, workflow_type: 'mutation',
    base_workflow_id: base.id, learning_status: base.learning_status, learning_version: base.learning_version, template_mode: 'snapshot', mutation_profile: profile,
    source_recording_session_id: base.source_recording_session_id,
  } as any);
}

export async function compileBusinessExperiment(context: AgentToolContext, input: { plan_id: string }): Promise<Record<string, any>> {
  assertScanActive();
  const plan = await getAgentExperimentPlan(context.repo, context.scanRunId, asText(input.plan_id, 'Plan id', 200));
  const flow = await getBusinessFlow(context.repo, context.scanRunId, plan.flow_id);
  if (flow.revision !== plan.source_flow_revision || flow.status !== 'verified' || flow.assertions_verified !== true || !flow.workflow_id) {
    throw new Error('The normal flow changed or is no longer verified. Replan from its latest native evidence.');
  }
  const source = await context.db.repos.workflows.findById(flow.workflow_id);
  if (!source) throw new Error('The verified source workflow no longer exists.');
  const sourceSteps = (await context.db.repos.workflowSteps.findAll({ where: { workflow_id: source.id } as any })).sort((a, b) => a.step_order - b.step_order);
  const selected = new Set(plan.steps.map(step => step.source_step_order));
  // Compilation is the one append-only transition for this exact plan. Keep
  // every generated native asset tied to that resulting revision; execution
  // and assessment add result artifacts rather than silently changing it.
  const compiledPlan: AgentExperimentPlan = { ...plan, revision: plan.revision + 1, status: 'compiled' };
  const roles = await resolveAccounts(context, source, requiredRoles(plan));
  const controlRole = plan.control_role || 'normal';
  const controlAccountId = roles.roles.get(controlRole);
  const experimentRoles = [...new Set(plan.steps.map(step => step.role || 'normal'))];
  const experimentAccountIds = [...new Set(experimentRoles.map(role => roles.roles.get(role)).filter((id): id is string => Boolean(id)))];
  const patches = new Map<string, RequestPatch[]>();
  for (const patch of plan.patches) patches.set(patch.step_id, [...(patches.get(patch.step_id) || []), patch]);
  const controlBase = await cloneWorkflow(context, source, `${source.name} · 模型实验对照 ${plan.id.slice(0, 8)}`, {
    mode: 'control', normalAccountId: controlAccountId, assertions: compiledPlan.control_assertions, selectedStepOrders: selected,
  });
  const experimentBase = await cloneWorkflow(context, source, `${source.name} · 模型实验变体 ${plan.id.slice(0, 8)}`, {
    mode: 'experiment', normalAccountId: roles.normalAccountId, assertions: compiledPlan.assertions, selectedStepOrders: selected, patches, bindings: compiledPlan.bindings,
  });
  const controlProfile = { model_directed: true, plan_id: plan.id, plan_revision: compiledPlan.revision,
    skip_steps: sourceSteps.filter(step => !selected.has(step.step_order)).map(step => step.step_order) };
  const experimentProfile = mutationProfileFor(compiledPlan, sourceSteps, roles.roles);
  const control = await createMutationWorkflow(context, controlBase.workflow, `${source.name} · 模型实验对照执行`, controlAccountId, controlProfile);
  const experiment = await createMutationWorkflow(context, experimentBase.workflow, `${source.name} · 模型实验执行`, roles.normalAccountId, experimentProfile);
  const compilation: ExperimentCompilation = {
    plan_id: plan.id, plan_revision: compiledPlan.revision, flow_id: flow.id, source_flow_revision: flow.revision, source_workflow_id: source.id,
    control_workflow_id: control.id, experiment_workflow_id: experiment.id, control_role: controlRole, control_account_id: controlAccountId,
    normal_account_id: roles.normalAccountId, experiment_account_ids: experimentAccountIds,
    selected_step_orders: [...selected].sort((a, b) => a - b), applied_patches: experimentBase.appliedPatches,
    bindings: (compiledPlan.bindings || []).map(binding => ({ ...binding, source_path_sha256: sha(binding.from_path), target_path_sha256: sha(binding.to_path) })),
    mutation_profile: experimentProfile, created_at: new Date().toISOString(),
  };
  const artifact = await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'agent_experiment_compilation',
    title: '模型实验原生编译清单', source_ref: plan.id, content_json: { ...compilation, private: true } });
  const planArtifact = await saveAgentExperimentPlan(context.repo, context.scanRunId, context.taskId, { ...plan, status: 'compiled', evidence_artifact_ids: [...new Set([...plan.evidence_artifact_ids, artifact.id])] });
  const savedPlan = planArtifact.content_json as AgentExperimentPlan;
  if (savedPlan.revision !== compilation.plan_revision) throw new Error('The plan changed while native compilation was being created. Inspect the latest plan and compile again.');
  return { plan_id: plan.id, plan_revision: savedPlan.revision, flow_id: flow.id, status: 'compiled', native_assets: {
      control_workflow_id: control.id, experiment_workflow_id: experiment.id, selected_step_orders: compilation.selected_step_orders,
      request_patch_count: compilation.applied_patches.length, binding_count: plan.bindings?.length || 0,
      control_role: controlRole, uses_identity_overlays: Boolean(experimentProfile.swap_account_at_steps), concurrency: experimentProfile.concurrent_replay?.concurrency || 0,
      parallel_groups: experimentProfile.parallel_groups?.length || 0 },
    summary: 'The exact model plan was compiled into new immutable native Workflow snapshots. No preset vulnerability strategy was substituted.' };
}

async function getCompilation(context: AgentToolContext, plan: AgentExperimentPlan): Promise<ExperimentCompilation> {
  const artifact = latestBusinessArtifact(await context.repo.listArtifacts(context.scanRunId), 'agent_experiment_compilation', plan.id);
  const compilation = artifact?.content_json as ExperimentCompilation | undefined;
  if (!compilation || compilation.plan_revision !== plan.revision) throw new Error('This plan has not been compiled at its current revision. Compile it before execution.');
  return compilation;
}

function traceFacts(trace: DebugTrace | null | undefined, assertions: BusinessAssertion[], requestedOrders: number[], concurrentStepOrder?: number): {
  complete: boolean; checks: Array<BusinessAssertion & { passed: boolean }>; execution: Array<Record<string, any>>; concurrentSuccess?: number;
} {
  const records = trace?.records || [];
  const execution = records.map(record => ({ step_order: Number(record.meta?.step_order || 0) || undefined, status: record.response?.status || 0,
    executed: !record.error && Boolean(record.response), error: record.error ? String(record.error).slice(0, 400) : undefined,
    concurrent_success_count: (record as any).concurrent_results?.success_count, parallel_extra_count: (record as any).parallel_results?.extras?.length }));
  const complete = requestedOrders.every(order => execution.some(item => item.step_order === order && item.executed && item.status > 0));
  const checks = assertions.map(assertion => {
    const matching = records.filter(record => Number(record.meta?.step_order) === assertion.step_order && !record.error && record.response);
    const passed = matching.length > 0 && matching.every(record => evaluateStepAssertions([{
      left: assertion.left, op: assertion.op, right: assertion.right, missing_behavior: 'fail',
    }], 'all', { status: record.response!.status, headers: record.response!.headers, body: record.response!.body || '' }, {},
    { extractedValues: {}, cookies: {}, sessionFields: {} }).passed);
    return { ...assertion, passed };
  });
  const concurrentSuccess = concurrentStepOrder === undefined ? undefined : records.filter(record =>
    Number(record.meta?.step_order) === concurrentStepOrder && record.meta?.label === 'concurrent' && !record.error &&
    Boolean(record.response) && Number(record.response?.status || 0) >= 200 && Number(record.response?.status || 0) < 300
  ).length;
  return { complete, checks, execution, concurrentSuccess };
}

async function createExperimentTestRun(context: AgentToolContext, name: string, workflowId: string, compilation: ExperimentCompilation,
  kind: 'control' | 'experiment', accountIds: string[]) {
  const run = await context.repo.getRun(context.scanRunId);
  if (!run) throw new Error('Assessment not found.');
  const environment = await context.db.repos.environments.create({ name: `${kind === 'control' ? '模型实验对照' : '模型实验'} ${compilation.plan_id.slice(0, 8)}`,
    base_url: run.base_url, is_active: true } as any);
  return context.db.repos.testRuns.create({ name, status: 'pending', execution_type: 'workflow', trigger_type: 'ai_scan', workflow_id: workflowId,
    account_ids: accountIds, environment_id: environment.id, rule_ids: [], progress_percent: 0,
    execution_params: { ai_scan_task_id: context.taskId, scan_run_id: context.scanRunId, plan_id: compilation.plan_id,
      plan_revision: compilation.plan_revision, model_directed: true, kind,
      ...(kind === 'control' ? { control_role: compilation.control_role } : {}) } } as any);
}

export async function executeBusinessExperiment(context: AgentToolContext, input: { plan_id: string }): Promise<Record<string, any>> {
  assertScanActive();
  const plan = await getAgentExperimentPlan(context.repo, context.scanRunId, asText(input.plan_id, 'Plan id', 200));
  const flow = await getBusinessFlow(context.repo, context.scanRunId, plan.flow_id);
  if (flow.revision !== plan.source_flow_revision || flow.status !== 'verified') throw new Error('The normal business baseline changed. Replan and compile from its latest evidence.');
  const compilation = await getCompilation(context, plan);
  const controlAccountIds = compilation.control_account_id ? [compilation.control_account_id] : [];
  const controlRun = await createExperimentTestRun(context, `模型实验对照 ${plan.name}`, compilation.control_workflow_id, compilation, 'control', controlAccountIds);
  const controlExecution = await executeWorkflowRun({ test_run_id: controlRun.id, workflow_id: compilation.control_workflow_id, account_ids: controlAccountIds,
    environment_id: controlRun.environment_id, evidence_only: true });
  const controlTrace = getTraceByRunId('workflow', controlRun.id);
  const experimentRun = await createExperimentTestRun(context, `模型实验 ${plan.name}`, compilation.experiment_workflow_id, compilation, 'experiment', compilation.experiment_account_ids);
  const experimentExecution = await executeWorkflowRun({ test_run_id: experimentRun.id, workflow_id: compilation.experiment_workflow_id, account_ids: compilation.experiment_account_ids,
    environment_id: experimentRun.environment_id, evidence_only: true });
  const experimentTrace = getTraceByRunId('workflow', experimentRun.id);
  const controlFacts = traceFacts(controlTrace, plan.control_assertions, compilation.selected_step_orders);
  const experimentFacts = traceFacts(experimentTrace, plan.assertions, compilation.selected_step_orders,
    Number(compilation.mutation_profile.concurrent_replay?.step_order || 0) || undefined);
  const controlVerified = controlFacts.complete && !controlExecution.has_execution_error && controlFacts.checks.every(item => item.passed);
  const executionVerified = experimentFacts.complete && !experimentExecution.has_execution_error && experimentFacts.checks.every(item => item.passed);
  const experimentRoles = [...new Set(plan.steps.map(step => step.role || 'normal').filter(role => role !== 'normal'))];
  const identityValues = new Set(Object.values(compilation.mutation_profile.swap_account_at_steps || {}).filter((id): id is string => typeof id === 'string'));
  const distinctIdentity = experimentRoles.length === 0 || (Boolean(compilation.normal_account_id) && [...identityValues].some(id => id !== compilation.normal_account_id));
  const requiresIdentityProof = experimentRoles.length > 0;
  const hasIdentityAssertion = plan.assertions.some(item => item.purpose === 'identity');
  const invariantVerified = executionVerified && controlVerified && plan.assertions.some(item => item.purpose === 'impact') &&
    plan.control_assertions.length > 0 && (!requiresIdentityProof || (distinctIdentity && hasIdentityAssertion));
  const missing: string[] = [];
  if (!controlFacts.complete) missing.push('对照流程没有完整执行所有模型选择的业务步骤。');
  if (!controlVerified) missing.push('对照业务断言未通过，无法确认实验差异。');
  if (!experimentFacts.complete) missing.push('实验流程没有完整执行所有模型选择的业务步骤。');
  if (!executionVerified) missing.push('实验影响断言未由原生执行证据满足。');
  if (requiresIdentityProof && !distinctIdentity) missing.push('实验要求跨身份，但没有不同且已准备的身份绑定。');
  if (requiresIdentityProof && !hasIdentityAssertion) missing.push('跨身份实验缺少可执行的身份结果断言。');
  if (plan.concurrency && (experimentFacts.concurrentSuccess || 0) < 2) missing.push('并发实验没有取得至少两个原生请求结果。');
  const traceArtifacts = await Promise.all([
    context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'agent_experiment_native_trace', source_ref: controlRun.id,
      title: '模型实验对照原生轨迹', content_json: { plan_id: plan.id, plan_revision: plan.revision, kind: 'control', test_run_id: controlRun.id, trace: controlTrace, private: true } }),
    context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'agent_experiment_native_trace', source_ref: experimentRun.id,
      title: '模型实验原生轨迹', content_json: { plan_id: plan.id, plan_revision: plan.revision, kind: 'experiment', test_run_id: experimentRun.id, trace: experimentTrace, private: true } }),
  ]);
  const status: AgentExperimentResult['status'] = controlFacts.complete && experimentFacts.complete ? 'executed'
    : (controlExecution.has_execution_error || experimentExecution.has_execution_error ? 'failed' : 'blocked');
  const counterexampleVerified = status === 'executed' && controlVerified && !executionVerified && !invariantVerified;
  const result: AgentExperimentResult = {
    id: randomUUID(), revision: 0, plan_id: plan.id, plan_revision: plan.revision, flow_id: plan.flow_id, source_flow_revision: plan.source_flow_revision,
    // In evidence-only mode a failed impact assertion is a useful negative
    // experiment result, not an execution failure. Reserve failed/blocked for
    // a missing or transport-broken native trace.
    status,
    native_test_run_ids: [controlRun.id, experimentRun.id], control_test_run_id: controlRun.id, experiment_test_run_id: experimentRun.id,
    execution_verified: executionVerified, control_verified: controlVerified, business_invariant_verified: invariantVerified,
    counterexample_verified: counterexampleVerified,
    distinct_identity_verified: distinctIdentity, evidence_ready: invariantVerified && missing.length === 0, missing_evidence: missing,
    control_assertions: controlFacts.checks, assertions: experimentFacts.checks, evidence_artifact_ids: traceArtifacts.map(artifact => artifact.id),
  };
  const resultArtifact = await saveAgentExperimentResult(context.repo, context.scanRunId, context.taskId, result);
  const saved = resultArtifact.content_json as AgentExperimentResult;
  return { plan_id: plan.id, plan_revision: plan.revision, result_revision: saved.revision, status: saved.status,
    native_test_run_ids: saved.native_test_run_ids, execution_verified: saved.execution_verified, control_verified: saved.control_verified,
    business_invariant_verified: saved.business_invariant_verified, distinct_identity_verified: saved.distinct_identity_verified,
    counterexample_verified: saved.counterexample_verified,
    evidence_ready: saved.evidence_ready, missing_evidence: saved.missing_evidence,
    control_assertions: saved.control_assertions.map(item => ({ id: item.id, step_order: item.step_order, purpose: item.purpose, passed: item.passed })),
    assertions: saved.assertions.map(item => ({ id: item.id, step_order: item.step_order, purpose: item.purpose, passed: item.passed })),
    concurrency_success_count: experimentFacts.concurrentSuccess, summary: saved.evidence_ready
      ? '原生对照与实验均已完成，模型可根据受限的执行事实作出判断。'
      : '原生执行已返回不充分或反驳实验假设的事实；模型应调整计划、补充控制或记录未证实结果。' };
}

export async function inspectBusinessExperiment(context: AgentToolContext, planId: string): Promise<Record<string, any>> {
  const plan = await getAgentExperimentPlan(context.repo, context.scanRunId, asText(planId, 'Plan id', 200));
  const result = await getAgentExperimentResult(context.repo, context.scanRunId, plan.id);
  return { plan_id: plan.id, plan_revision: plan.revision, flow_id: plan.flow_id, source_flow_revision: plan.source_flow_revision,
    status: plan.status, hypothesis: plan.hypothesis, selected_step_orders: plan.steps.map(step => step.source_step_order),
    request_patch_count: plan.patches.length, binding_count: plan.bindings?.length || 0, parent_plan_id: plan.parent_plan_id,
    ...(result ? { result_revision: result.revision, result_status: result.status, execution_verified: result.execution_verified,
      control_verified: result.control_verified, business_invariant_verified: result.business_invariant_verified,
      counterexample_verified: result.counterexample_verified,
      distinct_identity_verified: result.distinct_identity_verified, evidence_ready: result.evidence_ready, missing_evidence: result.missing_evidence,
      assertions: result.assertions.map(item => ({ id: item.id, step_order: item.step_order, purpose: item.purpose, passed: item.passed })),
      control_assertions: result.control_assertions.map(item => ({ id: item.id, step_order: item.step_order, purpose: item.purpose, passed: item.passed })) } : {}),
    notice: 'This view deliberately excludes raw request/response bodies, credentials, cookies, and private native traces.' };
}

export async function assessBusinessExperiment(context: AgentToolContext, input: Record<string, any>): Promise<Record<string, any>> {
  const plan = await getAgentExperimentPlan(context.repo, context.scanRunId, asText(input.plan_id, 'Plan id', 200));
  const result = await getAgentExperimentResult(context.repo, context.scanRunId, plan.id);
  if (!result || result.plan_revision !== plan.revision || result.status !== 'executed') throw new Error('Execute the current plan completely before assessing it.');
  if (input.result_revision !== undefined && Number(input.result_revision) !== result.revision) throw new Error('The supplied result revision is stale; inspect the latest execution facts.');
  const requestedVerdict = String(input.verdict || 'inconclusive');
  if (!['vulnerable', 'not_vulnerable', 'inconclusive'].includes(requestedVerdict)) throw new Error('Verdict must be vulnerable, not_vulnerable, or inconclusive.');
  const title = asText(input.title, 'Assessment title', 300);
  const reason = asText(input.reason, 'Assessment reason', 3000);
  const businessImpact = asText(input.business_impact, 'Business impact', 3000);
  const severity = ['critical', 'high', 'medium', 'low', 'info'].includes(String(input.severity)) ? String(input.severity) : 'info';
  const confirmed = requestedVerdict === 'vulnerable' && result.evidence_ready && result.execution_verified && result.control_verified && result.business_invariant_verified;
  const counterexampleVerified = requestedVerdict === 'not_vulnerable' && result.counterexample_verified === true;
  const verdict = confirmed ? 'vulnerable' : counterexampleVerified ? 'not_vulnerable' : 'inconclusive';
  const gate = { verdict: confirmed ? 'confirmed' : counterexampleVerified ? 'counterexample' : 'insufficient', plan_id: plan.id, plan_revision: plan.revision,
    source_flow_revision: plan.source_flow_revision, verified: result.business_invariant_verified, result_revision: result.revision,
    execution_verified: result.execution_verified, control_verified: result.control_verified, business_invariant_verified: result.business_invariant_verified,
    counterexample_verified: result.counterexample_verified,
    distinct_identity_verified: result.distinct_identity_verified, native_test_run_ids: result.native_test_run_ids,
    evidence_artifact_ids: result.evidence_artifact_ids, missing_evidence: result.missing_evidence };
  const proof = await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'business_state_proof', source_ref: plan.id,
    title: '模型实验业务证据门槛', content_json: { flow_id: plan.flow_id, ...gate } });
  const assessment = await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'agent_experiment_assessment', source_ref: plan.id,
    title, content_json: { plan_id: plan.id, plan_revision: plan.revision, result_revision: result.revision, requested_verdict: requestedVerdict,
      verdict, title, severity, reason, business_impact: businessImpact, native_evidence_gate: { ...gate, evidence_artifact_ids: [...gate.evidence_artifact_ids, proof.id] } } });
  const judgement = await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'ai_judgement', source_ref: plan.id,
    title, content_json: { verdict, title, business_title: title, severity, reason, business_impact: businessImpact, plan_id: plan.id,
      experiment_id: plan.id, flow_id: plan.flow_id, native_evidence_gate: { ...gate, evidence_artifact_ids: [...gate.evidence_artifact_ids, proof.id, assessment.id] } } });
  const flow = await getBusinessFlow(context.repo, context.scanRunId, plan.flow_id);
  await saveBusinessFlow(context.repo, context.scanRunId, context.taskId, { ...flow, evidence_artifact_ids: [...new Set([...flow.evidence_artifact_ids, proof.id, assessment.id, judgement.id])] });
  return { plan_id: plan.id, result_revision: result.revision, requested_verdict: requestedVerdict, verdict, confirmed,
    counterexample_verified: result.counterexample_verified,
    evidence_ready: result.evidence_ready, missing_evidence: result.missing_evidence,
    summary: confirmed ? '模型判断已通过原生实验、对照和业务影响证据门槛。' : requestedVerdict === 'vulnerable'
      ? '模型提出了风险判断，但原生证据门槛尚未满足；结果被记录为未证实，不能作为确认漏洞。'
      : requestedVerdict === 'not_vulnerable'
        ? '模型请求记录安全结论，但尚无完整对照和反证；结果被保留为未定论。'
        : '模型判断和原生证据状态已记录。' };
}
