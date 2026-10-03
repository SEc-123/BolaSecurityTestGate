import { createHash, randomUUID } from 'node:crypto';
import { dbAll, dbRun } from '../../db/sql-helpers.js';
import { parseRawRequest } from '../execution-utils.js';
import { applyNativeRequestPatch } from '../native-request-patch.js';
import { evaluateStepAssertions, executeWorkflowRun } from '../workflow-runner.js';
import { getTraceByRunId, type DebugTrace } from '../debug-trace.js';
import type { AgentToolContext } from '../../agent/tool-types.js';
import { BUSINESS_EXPERIMENT_INTENT, businessExperimentNegativeCounterexampleAttempts, MIN_NEGATIVE_COUNTEREXAMPLE_ATTEMPTS } from '../../agent/business-task-lifecycle.js';
import type { Workflow, WorkflowStep } from '../../types/index.js';
import { assertScanActive } from './run-control.js';
import { resolveBusinessObjectHandle, type BusinessObjectHandle, type BusinessObjectHandleScope } from './business-object-handles.js';
import { evaluateBusinessProof } from './business-proof.js';
import {
  accountAuthContextFingerprint,
  buildTrustedAccountIdentityRequirement,
  verifyTrustedAccountIdentityProbe,
  type TrustedAccountIdentityEvidence,
  type TrustedAccountIdentityRequirement,
} from './business-identity-binding.js';
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
  /** Safe provenance only. Values are resolved from private normal traces at
   * compilation/execution time and never copied into the model plan. */
  object_handles: Array<{handle_id:string;flow_id:string;flow_revision:number;normal_run_id:string;normal_workflow_id:string;owner_role:string;owner_account_id?:string;owner_subject_sha256?:string;selector_kind:'resource_id';producer_step_order:number;response_path:string;value_type:string}>;
  role_account_ids: Record<string,string>;
  /** Server-provisioned and server-executed account probes. Never derived
   * from a model assertion or role label. */
  identity_requirements: TrustedAccountIdentityRequirement[];
  mutation_profile: Record<string, any>;
  created_at: string;
}

type ResolvedRequestPatch = RequestPatch & { resolved_handle_id?: string };

interface ResolvedPlanReferences {
  patches: ResolvedRequestPatch[];
  assertions: BusinessAssertion[];
  controlAssertions: BusinessAssertion[];
  handles: BusinessObjectHandle[];
  opaqueValues: Record<string,string>;
}

const MAX_PATCHES = 24;
const MAX_BINDINGS = 24;
const MAX_REPEAT = 12;
const MAX_CONCURRENCY = 12;
const forbiddenHeader = /^(host|cookie|authorization|proxy-authorization|content-length|connection)$/i;
const secretField = /(?:password|passwd|secret|authorization|cookie|(?:^|[_-])(token|csrf|ticket|otp|passcode|session)(?:$|[_-]))/i;
const sha = (value: unknown) => createHash('sha256').update(String(value ?? '')).digest('hex');

/** Return observed response locations without copying any response values to
 * model context. This is shared by Workflow inspection and compiler guards so
 * the model can author only bindings grounded in the verified normal trace. */
export function observedResponseBindingShape(trace: DebugTrace | null | undefined): Record<number, {
  body_fields: Array<{ path: string; type: string; sensitive: boolean }>;
  header_names: Array<{ name: string; sensitive: boolean }>;
}> {
  const output: Record<number, { body_fields: Array<{ path: string; type: string; sensitive: boolean }>; header_names: Array<{ name: string; sensitive: boolean }> }> = {};
  const addBodyFields = (value: unknown, prefix = '', key = '', depth = 0, result: Array<{ path: string; type: string; sensitive: boolean }> = []) => {
    if (result.length >= 120 || depth > 10) return result;
    if (value === null || typeof value !== 'object') {
      if (prefix) result.push({ path: prefix, type: value === null ? 'null' : typeof value, sensitive: secretField.test(key) });
      return result;
    }
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item, index) => addBodyFields(item, `${prefix}${prefix ? '.' : ''}${index}`, key, depth + 1, result));
      return result;
    }
    for (const [name, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      addBodyFields(item, `${prefix}${prefix ? '.' : ''}${name}`, name, depth + 1, result);
    }
    return result;
  };
  for (const record of trace?.records || []) {
    const stepOrder = Number(record.meta?.step_order || 0);
    if (!Number.isInteger(stepOrder) || stepOrder < 1 || record.error || !record.response) continue;
    const entry = output[stepOrder] ||= { body_fields: [], header_names: [] };
    const body = record.response.body || '';
    if (!record.response.truncated_body && body.trim()) {
      try { entry.body_fields.push(...addBodyFields(JSON.parse(body))); }
      catch { /* Non-JSON response bodies are not exposed as binding paths. */ }
    }
    for (const [name, value] of Object.entries(record.response.headers || {})) {
      if (String(value) === '[REDACTED]' || /^(set-cookie|cookie|authorization|proxy-authorization)$/i.test(name)) continue;
      entry.header_names.push({ name, sensitive: secretField.test(name) });
    }
  }
  for (const entry of Object.values(output)) {
    entry.body_fields = [...new Map(entry.body_fields.map(field => [field.path, field])).values()].slice(0, 120);
    entry.header_names = [...new Map(entry.header_names.map(header => [header.name.toLowerCase(), header])).values()].slice(0, 80);
  }
  return output;
}

export async function verifiedNormalRunTrace(context: AgentToolContext, flow: Record<string, any>): Promise<DebugTrace | null> {
  const runId = String(flow.normal_run_id || '');
  if (!runId) return null;
  const live = getTraceByRunId('workflow', runId);
  if (live?.run_meta?.run_id === runId) return live;
  const artifact = (await context.repo.listArtifacts(context.scanRunId)).find(item =>
    item.artifact_type === 'business_native_trace' && item.source_ref === runId && item.content_json?.private === true &&
    item.content_json?.flow_id === flow.id && item.content_json?.test_run_id === runId && item.content_json?.workflow_id === flow.workflow_id);
  const trace = artifact?.content_json?.trace as DebugTrace | undefined;
  return trace?.run_meta?.run_id === runId ? trace : null;
}

function plainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown, label: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be a nonempty string of at most ${max} characters.`);
  return value.trim();
}

/**
 * The business-flow graph and native Workflow both contain ordered `steps`
 * with opaque IDs. A model can therefore make a plausible but invalid plan by
 * using the graph ID in place of the native WorkflowStep ID. Keep this
 * recovery contract value-free: invocation inputs and private native assets
 * stay out of the retry guidance.
 */
export const WORKFLOW_STEP_BINDING_MISMATCH_STATUS = 'workflow_step_binding_mismatch';

export class WorkflowStepBindingMismatchError extends Error {
  readonly safe_data = {
    status: WORKFLOW_STEP_BINDING_MISMATCH_STATUS,
    retryable: true,
    summary: 'No plan was saved. Reinspect the current native Workflow and use only exact workflow_step_order values from bstg.workflow.inspect.steps[].step_order for every plan step and step reference. BSTG resolves these orders to the current native steps.',
  };

  constructor() {
    super('The selected native Workflow step order does not match the current workflow.');
    this.name = 'WorkflowStepBindingMismatchError';
  }
}

export class ExperimentCompileRecoveryProtocolError extends Error {
  readonly safe_data: Record<string, unknown>;

  constructor(status: 'experiment_compile_reinspection_required' | 'experiment_compile_parent_required') {
    const summary = status === 'experiment_compile_reinspection_required'
      ? 'No revised plan was saved. Inspect the failed plan and its safe compile_feedback, then create a fresh child plan with parent_plan_id set to that plan. Do not compile the same plan again.'
      : 'No revised plan was saved. The latest failed compilation must be inspected first, then the revised plan must set parent_plan_id to that failed plan.';
    super(summary);
    this.name = 'ExperimentCompileRecoveryProtocolError';
    this.safe_data = { status, retryable: true, summary };
  }
}

export class ExperimentBlockProtocolError extends Error {
  readonly safe_data:Record<string,unknown>;

  constructor(failure_code:'authoritative_readback_available'|'experiment_block_evidence_missing'|'unsupported_experiment_block_code'|'negative_counterexample_attempts_incomplete',retryable=false){
    const summaries:Record<string,string>={
      authoritative_readback_available:'The verified Workflow has an observed read-back step after the selected write. Revise the child plan to select that step and prove the same state in control and experiment.',
      experiment_block_evidence_missing:'A model experiment may be blocked only after a persisted inconclusive native result proves the requested evidence gap.',
      unsupported_experiment_block_code:'This block code is not supported for the current model experiment.',
      negative_counterexample_attempts_incomplete:`The same server-owned negative-counterexample proof gap must appear in at least ${MIN_NEGATIVE_COUNTEREXAMPLE_ATTEMPTS} distinct completed, control-verified native experiment plans before the Agent may stop for human follow-up.`,
    };
    super(summaries[failure_code]);
    this.name='ExperimentBlockProtocolError';
    this.safe_data={status:'experiment_block_rejected',retryable,failure_code,summary:summaries[failure_code]};
  }
}

export class ExperimentRevisionProtocolError extends Error{
  readonly safe_data:Record<string,unknown>;
  constructor(){
    const summary='No child plan was saved. The verified Workflow has no observed GET/HEAD read-back after this state-changing request; call bstg.test_plan.block with reason_code authoritative_readback_unavailable, or choose a non-writing experiment supported by the observed steps.';
    super(summary);this.name='ExperimentRevisionProtocolError';
    this.safe_data={status:'experiment_plan_revision_rejected',retryable:false,failure_code:'authoritative_readback_unavailable',summary};
  }
}

/** Turn only a small set of known, model-correctable compilation rejections
 * into a safe recovery receipt. Raw exception text can include private paths,
 * account references, or implementation details, so it is never returned. */
export function safeExperimentCompileFeedback(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : '';
  let failure_code = 'compiler_internal_failure';
  let retryable = false;

  if (/normal flow changed|no longer verified|baseline changed|latest evidence/i.test(message)) {
    failure_code = 'verified_baseline_changed';
  } else if (/binding|response\.body|response\.header/i.test(message)) {
    failure_code = 'dynamic_binding_not_supported';
    retryable = true;
  } else if (/was not observed|observed segment|observed dotted field|observed response|request has no body|not JSON|unsupported patch|patch location|header .* observed|field .* observed/i.test(message)) {
    failure_code = 'mutation_field_not_observed';
    retryable = true;
  } else if (/prepared (?:scan )?(?:identity|account)|needs prepared|cross-identity|identity for .* unavailable/i.test(message)) {
    failure_code = 'identity_not_available';
    retryable = true;
  } else if (/object selector|opaque object selector|object-selection|object handle/i.test(message)) {
    failure_code = 'object_handle_proof_incomplete';
    retryable = true;
  } else if (/parallel|concurren|repeat directive|execution shape|experiment must change/i.test(message)) {
    failure_code = 'unsupported_execution_shape';
    retryable = true;
  } else if (/plan changed while native compilation|plan changed while/i.test(message)) {
    failure_code = 'plan_changed_during_compilation';
  }

  const summaries: Record<string, string> = {
    mutation_field_not_observed: 'The chosen mutation does not match an observed request field. Reinspect the native Workflow and select only a field present in the selected request; identity and transport headers remain server-bound.',
    dynamic_binding_not_supported: 'The response binding is not supported by the native executor. Use an observed earlier response field and a supported field in a later selected request, or remove the binding.',
    identity_not_available: 'The selected identity is not prepared for this assessment. Use an already prepared identity or keep the plan on the verified normal identity; do not invent account IDs or roles.',
    object_handle_proof_incomplete: 'The object-handle mutation lacks the required observed selector and authoritative readbacks. Add the supported control and experiment proof or remove the handle-based mutation.',
    unsupported_execution_shape: 'The requested execution shape is not represented by the native executor. Simplify it to selected observed steps and supported repeat, concurrency, or parallel operations.',
    verified_baseline_changed: 'The verified normal-flow baseline is stale. Revalidate the normal flow before starting another experiment.',
    plan_changed_during_compilation: 'The plan changed during compilation. Inspect the latest persisted plan and stop if its native state is ambiguous.',
    compiler_internal_failure: 'The native compiler failed for an unclassified internal reason. Do not repeat this plan; report the experiment as failed for review.',
  };

  return {
    status: retryable ? 'experiment_compile_requires_revision' : 'experiment_compile_failed',
    retryable,
    failure_code,
    summary: summaries[failure_code],
  };
}

/** Resolve the model-facing stable order contract against the current,
 * task-bound native Workflow snapshot. Persisted experiment plans continue to
 * use the existing native step IDs; the model never has to copy those opaque
 * handles through a generated tool call. */
function bindModelWorkflowStepOrders(input: Record<string, any>, sourceSteps: WorkflowStep[]): Record<string, any> {
  const modelSteps = Array.isArray(input.steps) ? input.steps : [];
  const usesModelOrderContract = modelSteps.some((item: any) =>
    Boolean(item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'workflow_step_order')));
  if (!usesModelOrderContract) return input;

  const sourceByOrder = new Map(sourceSteps.map(step => [step.step_order, step]));
  const resolveOrder = (order: unknown): { id: string; order: number } => {
    if (!Number.isInteger(order)) throw new WorkflowStepBindingMismatchError();
    const source = sourceByOrder.get(Number(order));
    if (!source) throw new WorkflowStepBindingMismatchError();
    return { id: source.id, order: source.step_order };
  };
  const mapArray = (value: unknown, convert: (item: Record<string, any>) => Record<string, any>): unknown =>
    Array.isArray(value) ? value.map(item => convert(item && typeof item === 'object' ? item as Record<string, any> : {})) : value;

  return {
    ...input,
    steps: mapArray(input.steps, ({ workflow_step_order, ...item }) => {
      const source = resolveOrder(workflow_step_order);
      return { ...item, id: source.id, source_step_order: source.order };
    }),
    patches: mapArray(input.patches, ({ workflow_step_order, ...item }) => ({
      ...item, step_id: resolveOrder(workflow_step_order).id,
    })),
    bindings: mapArray(input.bindings, ({ from_workflow_step_order, to_workflow_step_order, ...item }) => ({
      ...item,
      from_step_id: resolveOrder(from_workflow_step_order).id,
      to_step_id: resolveOrder(to_workflow_step_order).id,
    })),
    repeats: mapArray(input.repeats, ({ workflow_step_order, ...item }) => ({
      ...item, step_id: resolveOrder(workflow_step_order).id,
    })),
    concurrency: input.concurrency && typeof input.concurrency === 'object'
      ? (({ workflow_step_order, ...item }) => ({ ...item, step_id: resolveOrder(workflow_step_order).id }))(input.concurrency)
      : input.concurrency,
    parallel: mapArray(input.parallel, ({ anchor_workflow_step_order, extra_workflow_step_orders, ...item }) => ({
      ...item,
      anchor_step_id: resolveOrder(anchor_workflow_step_order).id,
      extra_step_ids: Array.isArray(extra_workflow_step_orders)
        ? extra_workflow_step_orders.map((order: unknown) => resolveOrder(order).id)
        : extra_workflow_step_orders,
    })),
  };
}

/** Security-experiment tasks may use only their scheduler-bound normal flow.
 * Scan ownership is not enough: sibling flows can have different identities,
 * object handles, and native evidence lifecycles. */
async function currentBusinessExperimentFlowId(context:AgentToolContext):Promise<string>{
  const taskId=String(context.taskId||'');
  if(!taskId)throw new Error('A security experiment requires an owned current task.');
  const task=await context.repo.getTask(taskId);
  const flowId=String(task?.execution_plan?.flow_id||'');
  if(!task||task.execution_plan?.intent!==BUSINESS_EXPERIMENT_INTENT||!flowId){
    throw new Error('Business experiment operations belong only to the current security-experiment task flow.');
  }
  return flowId;
}

export async function requireCurrentBusinessExperimentFlow(context:AgentToolContext,flowId:string){
  const current=await currentBusinessExperimentFlow(context);
  if(current.id!==flowId){
    throw new Error('Business experiment operations may not use a different task flow.');
  }
  return current;
}

export async function currentBusinessExperimentFlow(context:AgentToolContext){
  return getBusinessFlow(context.repo,context.scanRunId,await currentBusinessExperimentFlowId(context));
}

async function requireCurrentBusinessExperimentPlan(context:AgentToolContext,planId:string):Promise<{plan:AgentExperimentPlan;flow:Awaited<ReturnType<typeof getBusinessFlow>>}>{
  const plan=await getAgentExperimentPlan(context.repo,context.scanRunId,planId);
  const flow=await requireCurrentBusinessExperimentFlow(context,plan.flow_id);
  return {plan,flow};
}

export async function requireCurrentBusinessExperimentWorkflow(context:AgentToolContext,workflowId:string):Promise<void>{
  const flow=await getBusinessFlow(context.repo,context.scanRunId,await currentBusinessExperimentFlowId(context));
  if(flow.workflow_id!==workflowId)throw new Error('Security experiments may inspect only the current task flow workflow.');
}

function safeScalar(value: unknown, label: string): string {
  if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 4000) {
    throw new Error(`${label} must be a bounded string, number, or boolean.`);
  }
  return String(value);
}

function serializeRawRequest(request: { method: string; path: string; headers: Record<string, string>; body?: string }): string {
  const headers = Object.entries(request.headers)
    .filter(([name]) => !/^host$/i.test(name))
    .map(([name, value]) => `${name}: ${value}`);
  return [`${request.method} ${request.path} HTTP/1.1`, ...headers, '', request.body || ''].join('\r\n');
}

function patchRawRequest(raw: string, patch: ResolvedRequestPatch): { raw: string; report: Record<string, any> } {
  const path = asText(patch.path, 'Patch path', 300);
  const request = parseRawRequest(raw);
  if (!request) throw new Error('The recorded request snapshot cannot be parsed.');

  const before = applyNativeRequestPatch(request, { ...patch, path });
  const value = patch.operation === 'delete' ? '' : safeScalar(patch.value, 'Patch value');
  return { raw: serializeRawRequest(request), report: {
    location: patch.location, operation: patch.operation, path,
    before_sha256: sha(before), after_sha256: sha(patch.operation === 'delete' ? '' : value),
    ...(patch.resolved_handle_id ? { value_ref_handle_id: patch.resolved_handle_id } : {}),
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
  patches?: Map<string, ResolvedRequestPatch[]>;
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
        // Keep the captured snapshot immutable. The native runner applies the
        // model patch after dynamic Workflow variables/session bindings so a
        // copied mapping cannot silently undo the model's selected mutation.
        // A value_ref is the exception: replace the source scalar with its
        // opaque placeholder in the stored snapshot as well as at dispatch.
        if (patch.resolved_handle_id) raw = changed.raw;
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

function opaqueHandleId(value:unknown,label:string):string{
  if(!plainObject(value)||typeof value.handle_id!=='string'||!/^[-0-9a-f]{16,}$/i.test(value.handle_id)){
    throw new Error(`${label} must name a scan-owned opaque handle_id from bstg.business.object_handles.inspect.`);
  }
  return value.handle_id;
}

function opaqueHandlePlaceholder(handleId:string):string { return `__BSTG_OBJECT_HANDLE_${handleId}__`; }

async function resolvePlanReferences(context:AgentToolContext,plan:AgentExperimentPlan,scope:BusinessObjectHandleScope):Promise<ResolvedPlanReferences>{
  const handles=new Map<string,BusinessObjectHandle>();
  const opaqueValues:Record<string,string>={};
  const resolve=async(handleId:string)=>{
    const resolved=await resolveBusinessObjectHandle(context.repo,context.scanRunId,handleId,scope);
    handles.set(resolved.handle.id,resolved.handle);
    opaqueValues[resolved.handle.id]=String(resolved.value);
    return resolved;
  };
  const patches:ResolvedRequestPatch[]=[];
  for(const patch of plan.patches){
    if(!patch.value_ref){patches.push(patch);continue;}
    const resolved=await resolve(opaqueHandleId(patch.value_ref,'Patch value_ref'));
    patches.push({...patch,value:opaqueHandlePlaceholder(resolved.handle.id),resolved_handle_id:resolved.handle.id});
  }
  const assertions=await Promise.all(plan.assertions.map(async assertion=>{
    if(assertion.right.type!=='value_ref')return assertion;
    const resolved=await resolve(opaqueHandleId(assertion.right,'Assertion value_ref'));
    return {...assertion,right:{type:'literal' as const,value:opaqueHandlePlaceholder(resolved.handle.id)}};
  }));
  const controlAssertions=await Promise.all(plan.control_assertions.map(async assertion=>{
    if(assertion.right.type!=='value_ref')return assertion;
    const resolved=await resolve(opaqueHandleId(assertion.right,'Control assertion value_ref'));
    return {...assertion,right:{type:'literal' as const,value:opaqueHandlePlaceholder(resolved.handle.id)}};
  }));
  return {patches,assertions,controlAssertions,handles:[...handles.values()],opaqueValues};
}

function preservePlanAssertionFacts(original:BusinessAssertion[],resolved:Array<BusinessAssertion&{passed:boolean}>):Array<BusinessAssertion&{passed:boolean}>{
  const originals=new Map(original.map(assertion=>[assertion.id,assertion]));
  return resolved.map(fact=>({...((originals.get(fact.id)||fact) as BusinessAssertion),passed:fact.passed}));
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
    if (!source || Number(item?.source_step_order) !== source.step_order) throw new WorkflowStepBindingMismatchError();
    if (chosen.has(id)) throw new Error('Each experiment step must name a distinct actual source workflow step and its actual order.');
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
    const hasValue=patch?.value!==undefined;
    const hasReference=patch?.value_ref!==undefined;
    if(operation==='delete'){
      if(hasValue||hasReference)throw new Error('A delete patch cannot carry a value or opaque value_ref.');
      return {step_id:stepId,location,operation,path:asText(patch?.path,'Patch path',300)};
    }
    if(hasValue===hasReference)throw new Error('A set or append patch must provide exactly one literal value or scan-owned opaque value_ref.');
    return { step_id: stepId, location, operation, path: asText(patch?.path, 'Patch path', 300),
      ...(hasValue ? { value: safeScalar(patch?.value, 'Patch value') } : {value_ref:{handle_id:opaqueHandleId(patch.value_ref,'Patch value_ref')}}) };
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
  const flow = await requireCurrentBusinessExperimentFlow(context,asText(input.flow_id, 'Flow id', 200));
  const invocations = await context.repo.listToolInvocations(context.scanRunId, context.taskId);
  const failedCompile = invocations.filter(invocation => invocation.tool_name === 'bstg.test_plan.compile' &&
    invocation.status === 'failed' && invocation.output_json?.status === 'experiment_compile_requires_revision').at(-1);
  let recoveryParentPlanId:string|undefined;
  if (failedCompile) {
    const taskId = String(context.taskId || '');
    const task = taskId ? await context.repo.getTask(taskId) : undefined;
    // The runtime sets this phase only after a successful exact-plan inspect.
    // Invocation timestamps can share a millisecond, so task lifecycle state
    // is the authoritative ordering receipt here.
    const compileRecoveryPhases = ['experiment_compile_requires_inspection', 'experiment_compile_reinspection_completed',
      'experiment_workflow_step_binding_reinspection_completed'];
    if (compileRecoveryPhases.includes(String(task?.phase || ''))) {
      const failedPlanId = String(failedCompile.input_json?.plan_id || '');
      if (task?.phase !== 'experiment_compile_reinspection_completed' &&
          task?.phase !== 'experiment_workflow_step_binding_reinspection_completed') {
        throw new ExperimentCompileRecoveryProtocolError('experiment_compile_reinspection_required');
      }
      if (!failedPlanId) throw new ExperimentCompileRecoveryProtocolError('experiment_compile_parent_required');
      // The runtime phase proves the latest compiler rejection was inspected.
      // Bind the lineage to that exact plan server-side so a stale model-held
      // parent ID cannot strand an otherwise valid corrected experiment.
      recoveryParentPlanId=failedPlanId;
    }
  }
  if (!flow.workflow_id) throw new Error('This business flow has no native workflow to use as an experiment source.');
  const sourceSteps = (await context.db.repos.workflowSteps.findAll({ where: { workflow_id: flow.workflow_id } as any })).sort((a, b) => a.step_order - b.step_order);
  if (!sourceSteps.length) throw new Error('The verified normal business workflow has no steps.');
  const planInput=recoveryParentPlanId?{...input,parent_plan_id:recoveryParentPlanId}:input;
  const plan = validatePlanInput(context, flow, sourceSteps, bindModelWorkflowStepOrders(planInput, sourceSteps));
  if(plan.parent_plan_id){
    const parentResult=await getAgentExperimentResult(context.repo,context.scanRunId,plan.parent_plan_id).catch(()=>undefined);
    const parentLacksReadback=(parentResult?.business_proof?.evidence_gaps||[]).some((gap:any)=>gap?.failure_code==='authoritative_readback_unavailable');
    if(parentLacksReadback){
      const selectedIds=new Set(plan.steps.map(step=>step.id));
      const selectedWrites=sourceSteps.filter(step=>selectedIds.has(step.id))
        .filter(step=>!['GET','HEAD','OPTIONS'].includes(parseRawRequest(rawForStep(step))?.method.toUpperCase()||''))
        .map(step=>step.step_order);
      const lastWriteOrder=selectedWrites.length?Math.max(...selectedWrites):0;
      const sourceHasReadback=lastWriteOrder>0&&sourceSteps.some(step=>step.step_order>=lastWriteOrder&&
        ['GET','HEAD'].includes(parseRawRequest(rawForStep(step))?.method.toUpperCase()||''));
      if(lastWriteOrder>0&&!sourceHasReadback)throw new ExperimentRevisionProtocolError();
    }
  }
  if (input.plan_id) {
    const previous = await getAgentExperimentPlan(context.repo, context.scanRunId, plan.id);
    if (previous.flow_id !== flow.id) throw new Error('A revised plan must stay attached to its original business flow.');
  }
  if (plan.parent_plan_id) {
    const parent=await getAgentExperimentPlan(context.repo,context.scanRunId,plan.parent_plan_id);
    if(parent.flow_id!==flow.id)throw new Error('A revised plan must stay attached to the current security-experiment task flow.');
  }
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

function requiresTrustedIdentity(plan:AgentExperimentPlan):boolean {
  return requiredRoles(plan).some(role=>role!=='normal');
}

async function createTrustedIdentityProbeWorkflow(context:AgentToolContext,source:Workflow,sourceSteps:WorkflowStep[],requirement:TrustedAccountIdentityRequirement):Promise<Workflow>{
  const sourceStep=sourceSteps.find(step=>step.step_order===requirement.probe_source_step_order);
  if(!sourceStep)throw new Error('The server-provisioned identity probe source step is no longer available.');
  const workflow=await context.db.repos.workflows.create({
    name:`身份探针 · ${requirement.role} · ${source.name}`.slice(0,240),description:`Server-forced account identity probe for ${source.id}`,
    is_active:true,assertion_strategy:'all_steps_pass',critical_step_orders:[],account_binding_strategy:'anchor_attacker',attacker_account_id:requirement.account_id,
    enable_baseline:false,baseline_config:{capture_replay_only:true,agent_business_identity_probe:true},enable_extractor:false,enable_session_jar:false,
    session_jar_config:{cookie_mode:false},workflow_type:'baseline',learning_status:'learned',learning_version:source.learning_version,
    template_mode:'snapshot',source_recording_session_id:source.source_recording_session_id,
  } as any);
  await context.db.repos.workflowSteps.create({...noId(sourceStep as any),workflow_id:workflow.id,request_snapshot_raw:rawForStep(sourceStep),
    step_assertions:[],assertions_mode:'all',failure_patterns_override:[],snapshot_created_at:new Date().toISOString()} as any);
  return workflow;
}

async function createTrustedIdentityRequirements(context:AgentToolContext,source:Workflow,sourceSteps:WorkflowStep[],plan:AgentExperimentPlan,
  roles:Map<string,string>):Promise<TrustedAccountIdentityRequirement[]>{
  if(!requiresTrustedIdentity(plan))return [];
  const output:TrustedAccountIdentityRequirement[]=[];
  const accountRole=new Map<string,string>();
  for(const role of requiredRoles(plan)){
    const accountId=roles.get(role);
    if(!accountId)throw new Error(`Cross-identity execution needs a prepared account for ${role}.`);
    const previousRole=accountRole.get(accountId);
    if(previousRole&&previousRole!==role)throw new Error(`Cross-identity execution cannot reuse prepared account ${accountId} for both ${previousRole} and ${role}.`);
    accountRole.set(accountId,role);
    const account=await context.db.repos.accounts.findById(accountId);
    if(!account)throw new Error(`The prepared identity for ${role} is unavailable.`);
    const requirement=buildTrustedAccountIdentityRequirement({role,account,sourceWorkflowId:source.id,sourceSteps});
    const probe=await createTrustedIdentityProbeWorkflow(context,source,sourceSteps,requirement);
    output.push({...requirement,probe_workflow_id:probe.id});
  }
  return output;
}

function selectorPatchForHandle(plan:AgentExperimentPlan,handleId:string):boolean {
  const terminal=(value:string)=>value.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().split('.').at(-1) || '';
  return plan.patches.some(patch=>patch.value_ref?.handle_id===handleId&&(
    patch.location==='path'&&/^(?:segment\.|__bstg_segment_)\d+$/.test(patch.path)||
    patch.location==='query'&&/(?:^|_)(?:id|uuid|guid)(?:$|_)/.test(terminal(patch.path))||
    ['json_body','form_body'].includes(patch.location)&&/(?:^|_)(?:id|uuid|guid)(?:$|_)/.test(terminal(patch.path))
  ));
}

function matchingHandleReadback(plan:AgentExperimentPlan,handleId:string,selectedSteps:Map<string,WorkflowStep>):boolean {
  const writes=plan.patches.filter(patch=>patch.value_ref?.handle_id===handleId).map(patch=>selectedSteps.get(patch.step_id)?.step_order||0);
  const lastWrite=Math.max(0,...writes);
  return plan.assertions.some(assertion=>assertion.right.type==='value_ref'&&assertion.right.handle_id===handleId&&assertion.left.path.startsWith('body.')&&assertion.step_order>=lastWrite);
}

function enforceObjectHandleCompilation(plan:AgentExperimentPlan,references:ResolvedPlanReferences,requirements:TrustedAccountIdentityRequirement[],sourceSteps:WorkflowStep[]):void {
  if(!references.handles.length)return;
  const controlRole=plan.control_role||'normal';
  const control=requirements.find(item=>item.role===controlRole);
  const identityBound=requiresTrustedIdentity(plan);
  if(identityBound&&!control)throw new Error('A plan using an object selector across identities requires a server-provisioned control identity binding.');
  const selected=new Map(sourceSteps.map(step=>[step.id,step]));
  for(const handle of references.handles){
    if(identityBound&&(handle.owner_role!==controlRole||!handle.owner_account_id||!handle.owner_subject_sha256||handle.owner_account_id!==control!.account_id||handle.owner_subject_sha256!==control!.expected_subject_sha256)){
      throw new Error('The object selector does not belong to the current verified control identity.');
    }
    if(!selectorPatchForHandle(plan,handle.id))throw new Error('An opaque object selector may only patch an observed resource-selection path, query key, or body selector field.');
    if(!matchingHandleReadback(plan,handle.id,selected)||!plan.control_assertions.some(assertion=>assertion.right.type==='value_ref'&&assertion.right.handle_id===handle.id&&assertion.left.path.startsWith('body.'))){
      throw new Error('An object-selector experiment requires control and experimental authoritative response readbacks that match the same opaque selector after the write.');
    }
  }
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
  const {plan,flow}=await requireCurrentBusinessExperimentPlan(context,asText(input.plan_id, 'Plan id', 200));
  if (flow.revision !== plan.source_flow_revision || flow.status !== 'verified' || flow.assertions_verified !== true || !flow.workflow_id || !flow.normal_run_id) {
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
  const handleScope:BusinessObjectHandleScope={flow_id:flow.id,flow_revision:flow.revision,normal_run_id:flow.normal_run_id,normal_workflow_id:flow.workflow_id};
  const roles = await resolveAccounts(context, source, requiredRoles(plan));
  const references=await resolvePlanReferences(context,compiledPlan,handleScope);
  // Validate every model-selected request mutation before creating cloned
  // workflows or server-side identity probes. A rejected plan must not leave
  // partially compiled native assets behind for the next child-plan retry.
  for (const patch of references.patches) {
    const sourceStep = sourceSteps.find(step => step.id === patch.step_id);
    if (!sourceStep) throw new Error('A request patch must target a selected observed step.');
    patchRawRequest(rawForStep(sourceStep), patch);
  }
  const planBindings = compiledPlan.bindings || [];
  if (planBindings.length) {
    const responseShape = observedResponseBindingShape(await verifiedNormalRunTrace(context, flow));
    const stepByOrder = new Map(sourceSteps.map(step => [step.step_order, step]));
    for (const binding of planBindings) {
      const fromOrder = sourceSteps.find(step => step.id === binding.from_step_id)?.step_order;
      const toOrder = sourceSteps.find(step => step.id === binding.to_step_id)?.step_order;
      if (!fromOrder || !toOrder || !selected.has(fromOrder) || !selected.has(toOrder) || fromOrder >= toOrder) {
        throw new Error('A response binding must connect earlier and later selected steps in the verified normal Workflow.');
      }
      const shape = responseShape[fromOrder];
      const observedSource = binding.from_location === 'response.body'
        ? shape?.body_fields.some(field => field.path === binding.from_path)
        : binding.from_location === 'response.header'
          ? shape?.header_names.some(header => header.name.toLowerCase() === binding.from_path.toLowerCase())
          : false;
      if (!observedSource) throw new Error(`The ${binding.from_location} binding source was not observed in the verified normal response for step ${fromOrder}.`);
      const targetStep = stepByOrder.get(toOrder);
      if (!targetStep) throw new Error('The response binding target step was not observed in the verified normal Workflow.');
      if (!['query', 'header', 'json_body', 'form_body', 'path'].includes(binding.to_location)) {
        throw new Error('The response binding target location is not supported by the native executor.');
      }
      patchRawRequest(rawForStep(targetStep), { step_id: targetStep.id, location: binding.to_location as RequestLocation, operation: 'set', path: binding.to_path, value: 'bstg-observed-binding-check' });
    }
  }
  const identityRequirements=await createTrustedIdentityRequirements(context,source,sourceSteps,compiledPlan,roles.roles);
  enforceObjectHandleCompilation(compiledPlan,references,identityRequirements,sourceSteps);
  const controlRole = plan.control_role || 'normal';
  const controlAccountId = roles.roles.get(controlRole);
  const experimentRoles = [...new Set(plan.steps.map(step => step.role || 'normal'))];
  const experimentAccountIds = [...new Set(experimentRoles.map(role => roles.roles.get(role)).filter((id): id is string => Boolean(id)))];
  const patches = new Map<string, ResolvedRequestPatch[]>();
  for (const patch of references.patches) patches.set(patch.step_id, [...(patches.get(patch.step_id) || []), patch]);
  const controlBase = await cloneWorkflow(context, source, `${source.name} · 模型实验对照 ${plan.id.slice(0, 8)}`, {
    mode: 'control', normalAccountId: controlAccountId, assertions: references.controlAssertions, selectedStepOrders: selected,
  });
  const experimentBase = await cloneWorkflow(context, source, `${source.name} · 模型实验变体 ${plan.id.slice(0, 8)}`, {
    mode: 'experiment', normalAccountId: roles.normalAccountId, assertions: references.assertions, selectedStepOrders: selected, patches, bindings: compiledPlan.bindings,
  });
  const controlProfile = { model_directed: true, plan_id: plan.id, plan_revision: compiledPlan.revision,
    skip_steps: sourceSteps.filter(step => !selected.has(step.step_order)).map(step => step.step_order) };
  const experimentProfile = mutationProfileFor(compiledPlan, sourceSteps, roles.roles);
  experimentProfile.model_request_patches = references.patches.map(patch => ({
    step_order: sourceSteps.find(step => step.id === patch.step_id)!.step_order,
    location: patch.location,
    operation: patch.operation,
    path: patch.path,
    ...(patch.value === undefined ? {} : { value: patch.value }),
  }));
  const control = await createMutationWorkflow(context, controlBase.workflow, `${source.name} · 模型实验对照执行`, controlAccountId, controlProfile);
  const experiment = await createMutationWorkflow(context, experimentBase.workflow, `${source.name} · 模型实验执行`, roles.normalAccountId, experimentProfile);
  const compilation: ExperimentCompilation = {
    plan_id: plan.id, plan_revision: compiledPlan.revision, flow_id: flow.id, source_flow_revision: flow.revision, source_workflow_id: source.id,
    control_workflow_id: control.id, experiment_workflow_id: experiment.id, control_role: controlRole, control_account_id: controlAccountId,
    normal_account_id: roles.normalAccountId, experiment_account_ids: experimentAccountIds,
    selected_step_orders: [...selected].sort((a, b) => a - b), applied_patches: experimentBase.appliedPatches,
    bindings: (compiledPlan.bindings || []).map(binding => ({ ...binding, source_path_sha256: sha(binding.from_path), target_path_sha256: sha(binding.to_path) })),
    object_handles:references.handles.map(handle=>({handle_id:handle.id,flow_id:handle.flow_id,flow_revision:handle.flow_revision,normal_run_id:handle.normal_run_id,
      normal_workflow_id:handle.normal_workflow_id,owner_role:handle.owner_role,owner_account_id:handle.owner_account_id,owner_subject_sha256:handle.owner_subject_sha256,
      selector_kind:handle.selector_kind,producer_step_order:handle.producer_step_order,response_path:handle.response_path,value_type:handle.value_type})),
    role_account_ids:Object.fromEntries(roles.roles.entries()),
    identity_requirements:identityRequirements,
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
      parallel_groups: experimentProfile.parallel_groups?.length || 0, object_handle_count:compilation.object_handles.length },
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

async function executeTrustedIdentityProbe(context:AgentToolContext,requirement:TrustedAccountIdentityRequirement,executionKind:'control'|'experiment',phase:'pre'|'post'):Promise<TrustedAccountIdentityEvidence>{
  const base={role:requirement.role,account_id:requirement.account_id,auth_context_generation:requirement.auth_context_generation,
    auth_context_fingerprint:requirement.auth_context_fingerprint,source_workflow_id:requirement.source_workflow_id,
    probe_source_step_order:requirement.probe_source_step_order,probe_workflow_id:requirement.probe_workflow_id,execution_kind:executionKind,phase};
  const account=await context.db.repos.accounts.findById(requirement.account_id);
  if(!account||accountAuthContextFingerprint(account)!==requirement.auth_context_fingerprint){
    return {...base,verified:false,diagnostic:'The prepared account authentication context changed after compilation.'};
  }
  if(!requirement.probe_workflow_id)return {...base,verified:false,diagnostic:'The server-forced identity probe workflow is unavailable.'};
  const scan=await context.repo.getRun(context.scanRunId);
  if(!scan)return {...base,verified:false,diagnostic:'The assessment is unavailable.'};
  const environment=await context.db.repos.environments.create({name:`身份探针 ${executionKind} ${phase} ${requirement.role}`.slice(0,240),base_url:scan.base_url,is_active:true} as any);
  const run=await context.db.repos.testRuns.create({name:`身份探针 ${executionKind} ${phase} ${requirement.role}`.slice(0,240),status:'pending',execution_type:'workflow',trigger_type:'ai_scan',
    workflow_id:requirement.probe_workflow_id,account_ids:[requirement.account_id],environment_id:environment.id,rule_ids:[],progress_percent:0,
    execution_params:{ai_scan_task_id:context.taskId,scan_run_id:context.scanRunId,identity_probe:true,role:requirement.role,execution_kind:executionKind,phase,
      auth_context_generation:requirement.auth_context_generation}} as any);
  const execution=await executeWorkflowRun({test_run_id:run.id,workflow_id:requirement.probe_workflow_id,account_ids:[requirement.account_id],environment_id:environment.id,
    evidence_only:true,identity_context_generations:{[requirement.account_id]:requirement.auth_context_generation}});
  const trace=getTraceByRunId('workflow',run.id);
  const verified=verifyTrustedAccountIdentityProbe(requirement,trace);
  const artifact=await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:context.taskId,artifact_type:'agent_identity_probe_native_trace',source_ref:run.id,
    title:`服务端身份探针 ${executionKind} ${phase} ${requirement.role}`,content_json:{...base,test_run_id:run.id,execution:{success:execution.success,has_execution_error:execution.has_execution_error},
      verified:verified.verified,subject_sha256:verified.subject_sha256,tenant_sha256:verified.tenant_sha256,role_sha256:verified.role_sha256,trace,private:true}});
  return {...base,...verified,probe_test_run_id:run.id,trace_artifact_id:artifact.id};
}

function identityGenerations(requirements:TrustedAccountIdentityRequirement[]):Record<string,string>{
  const result:Record<string,string>={};
  for(const requirement of requirements){
    if(result[requirement.account_id]&&result[requirement.account_id]!==requirement.auth_context_generation)throw new Error('The same account cannot receive multiple identity generations in one experiment.');
    result[requirement.account_id]=requirement.auth_context_generation;
  }
  return result;
}

function materializeOpaqueAssertions(assertions:BusinessAssertion[],opaqueValues:Record<string,string>):BusinessAssertion[]{
  const token=/__BSTG_OBJECT_HANDLE_([0-9a-f-]{16,})__/gi;
  const replace=(value:string)=>value.replace(token,(_whole,id:string)=>{
    if(opaqueValues[id]===undefined)throw new Error('An opaque object selector is unavailable while evaluating native evidence.');
    return opaqueValues[id];
  });
  return assertions.map(assertion=>({...assertion,right:{...assertion.right,...(typeof assertion.right.value==='string'?{value:replace(assertion.right.value)}:{})}}));
}

export async function executeBusinessExperiment(context: AgentToolContext, input: { plan_id: string }): Promise<Record<string, any>> {
  assertScanActive();
  const {plan,flow}=await requireCurrentBusinessExperimentPlan(context,asText(input.plan_id, 'Plan id', 200));
  if (flow.revision !== plan.source_flow_revision || flow.status !== 'verified') throw new Error('The normal business baseline changed. Replan and compile from its latest evidence.');
  const compilation = await getCompilation(context, plan);
  if(!flow.workflow_id||!flow.normal_run_id)throw new Error('The verified normal business baseline is incomplete. Revalidate before execution.');
  const references=await resolvePlanReferences(context,plan,{flow_id:flow.id,flow_revision:flow.revision,normal_run_id:flow.normal_run_id,normal_workflow_id:flow.workflow_id});
  const experimentRoles=[...new Set(plan.steps.map(step=>step.role||'normal'))];
  const trustedIdentityRequired=requiresTrustedIdentity(plan);
  const identityRequirements=Array.isArray(compilation.identity_requirements)?compilation.identity_requirements:[];
  if(trustedIdentityRequired&&identityRequirements.length!==requiredRoles(plan).length)throw new Error('This cross-identity plan lacks its server-forced account probes. Recompile it from the current verified flow.');
  const identityGenerationsByAccount=identityGenerations(identityRequirements);
  const identityEvidence:TrustedAccountIdentityEvidence[]=[];
  if(trustedIdentityRequired){
    const controlRequirement=identityRequirements.find(item=>item.role===compilation.control_role);
    if(!controlRequirement)throw new Error('The compiled control identity has no server-forced probe requirement.');
    identityEvidence.push(await executeTrustedIdentityProbe(context,controlRequirement,'control','pre'));
  }
  const controlAccountIds = compilation.control_account_id ? [compilation.control_account_id] : [];
  const controlRun = await createExperimentTestRun(context, `模型实验对照 ${plan.name}`, compilation.control_workflow_id, compilation, 'control', controlAccountIds);
  const controlExecution = await executeWorkflowRun({ test_run_id: controlRun.id, workflow_id: compilation.control_workflow_id, account_ids: controlAccountIds,
    environment_id: controlRun.environment_id, evidence_only: true, opaque_value_refs: references.opaqueValues,identity_context_generations:identityGenerationsByAccount });
  const controlTrace = getTraceByRunId('workflow', controlRun.id);
  if(trustedIdentityRequired){
    const controlRequirement=identityRequirements.find(item=>item.role===compilation.control_role)!;
    identityEvidence.push(await executeTrustedIdentityProbe(context,controlRequirement,'control','post'));
    for(const requirement of identityRequirements.filter(item=>experimentRoles.includes(item.role)))identityEvidence.push(await executeTrustedIdentityProbe(context,requirement,'experiment','pre'));
  }
  const experimentRun = await createExperimentTestRun(context, `模型实验 ${plan.name}`, compilation.experiment_workflow_id, compilation, 'experiment', compilation.experiment_account_ids);
  const experimentExecution = await executeWorkflowRun({ test_run_id: experimentRun.id, workflow_id: compilation.experiment_workflow_id, account_ids: compilation.experiment_account_ids,
    environment_id: experimentRun.environment_id, evidence_only: true, opaque_value_refs: references.opaqueValues,identity_context_generations:identityGenerationsByAccount });
  const experimentTrace = getTraceByRunId('workflow', experimentRun.id);
  if(trustedIdentityRequired)for(const requirement of identityRequirements.filter(item=>experimentRoles.includes(item.role)))identityEvidence.push(await executeTrustedIdentityProbe(context,requirement,'experiment','post'));
  const controlFacts = traceFacts(controlTrace, materializeOpaqueAssertions(references.controlAssertions,references.opaqueValues), compilation.selected_step_orders);
  const experimentFacts = traceFacts(experimentTrace, materializeOpaqueAssertions(references.assertions,references.opaqueValues), compilation.selected_step_orders,
    Number(compilation.mutation_profile.concurrent_replay?.step_order || 0) || undefined);
  const controlVerified = controlFacts.complete && !controlExecution.has_execution_error && controlFacts.checks.every(item => item.passed);
  const executionVerified = experimentFacts.complete && !experimentExecution.has_execution_error && experimentFacts.checks.every(item => item.passed);
  const sourceSteps=(await context.db.repos.workflowSteps.findAll({where:{workflow_id:flow.workflow_id} as any})).sort((left,right)=>left.step_order-right.step_order);
  const proof=evaluateBusinessProof({plan,compilation,sourceSteps,controlAssertions:preservePlanAssertionFacts(plan.control_assertions,controlFacts.checks),
    experimentAssertions:preservePlanAssertionFacts(plan.assertions,experimentFacts.checks),controlVerified,executionVerified,concurrentSuccess:experimentFacts.concurrentSuccess,
    identity_evidence:identityEvidence,control_trace:controlTrace,experiment_trace:experimentTrace});
  const distinctIdentity=!trustedIdentityRequired||proof.authentication.verified;
  const invariantVerified = executionVerified && controlVerified && proof.verified && plan.assertions.some(item => item.purpose === 'impact') &&
    plan.control_assertions.length > 0 && (!trustedIdentityRequired || distinctIdentity);
  const missing: string[] = [];
  if (!controlFacts.complete) missing.push('对照流程没有完整执行所有模型选择的业务步骤。');
  if (!controlVerified) missing.push('对照业务断言未通过，无法确认实验差异。');
  if (!experimentFacts.complete) missing.push('实验流程没有完整执行所有模型选择的业务步骤。');
  if (!executionVerified) missing.push('实验影响断言未由原生执行证据满足。');
  if (trustedIdentityRequired && !distinctIdentity) missing.push('跨身份实验缺少服务端探针验证的不同主体与同一认证代际。');
  if (plan.concurrency && (experimentFacts.concurrentSuccess || 0) < 2) missing.push('并发实验没有取得至少两个原生请求结果。');
  missing.push(...proof.missing_evidence);
  const traceArtifacts = await Promise.all([
    context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'agent_experiment_native_trace', source_ref: controlRun.id,
      title: '模型实验对照原生轨迹', content_json: { plan_id: plan.id, plan_revision: plan.revision, kind: 'control', test_run_id: controlRun.id, trace: controlTrace, private: true } }),
    context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'agent_experiment_native_trace', source_ref: experimentRun.id,
      title: '模型实验原生轨迹', content_json: { plan_id: plan.id, plan_revision: plan.revision, kind: 'experiment', test_run_id: experimentRun.id, trace: experimentTrace, private: true } }),
  ]);
  const status: AgentExperimentResult['status'] = controlFacts.complete && experimentFacts.complete ? 'executed'
    : (controlExecution.has_execution_error || experimentExecution.has_execution_error ? 'failed' : 'blocked');
  const counterexampleVerified = status === 'executed' && proof.negative_proof?.verified === true;
  const result: AgentExperimentResult = {
    id: randomUUID(), revision: 0, plan_id: plan.id, plan_revision: plan.revision, flow_id: plan.flow_id, source_flow_revision: plan.source_flow_revision,
    // In evidence-only mode a failed impact assertion is a useful negative
    // experiment result, not an execution failure. Reserve failed/blocked for
    // a missing or transport-broken native trace.
    status,
    native_test_run_ids: [controlRun.id, experimentRun.id], control_test_run_id: controlRun.id, experiment_test_run_id: experimentRun.id,
    execution_verified: executionVerified, control_verified: controlVerified, business_invariant_verified: invariantVerified,
    counterexample_verified: counterexampleVerified,
    distinct_identity_verified: distinctIdentity,business_proof:proof, evidence_ready: invariantVerified && missing.length === 0, missing_evidence: [...new Set(missing)],
    control_assertions: preservePlanAssertionFacts(plan.control_assertions,controlFacts.checks),
    assertions: preservePlanAssertionFacts(plan.assertions,experimentFacts.checks), evidence_artifact_ids: [...traceArtifacts.map(artifact => artifact.id),...identityEvidence.map(item=>item.trace_artifact_id).filter((id):id is string=>Boolean(id))],
  };
  const resultArtifact = await saveAgentExperimentResult(context.repo, context.scanRunId, context.taskId, result);
  const saved = resultArtifact.content_json as AgentExperimentResult;
  return { plan_id: plan.id, plan_revision: plan.revision, result_revision: saved.revision, status: saved.status,
    native_test_run_ids: saved.native_test_run_ids, execution_verified: saved.execution_verified, control_verified: saved.control_verified,
    business_invariant_verified: saved.business_invariant_verified, distinct_identity_verified: saved.distinct_identity_verified,
    business_proof:saved.business_proof,
    counterexample_verified: saved.counterexample_verified,
    evidence_ready: saved.evidence_ready, missing_evidence: saved.missing_evidence,
    control_assertions: saved.control_assertions.map(item => ({ id: item.id, step_order: item.step_order, purpose: item.purpose, passed: item.passed })),
    assertions: saved.assertions.map(item => ({ id: item.id, step_order: item.step_order, purpose: item.purpose, passed: item.passed })),
    concurrency_success_count: experimentFacts.concurrentSuccess, summary: saved.evidence_ready
      ? '原生对照与实验均已完成，模型可根据受限的执行事实作出判断。'
      : '原生执行已返回不充分或反驳实验假设的事实；模型应调整计划、补充控制或记录未证实结果。' };
}

export async function inspectBusinessExperiment(context: AgentToolContext, planId: string): Promise<Record<string, any>> {
  const {plan}=await requireCurrentBusinessExperimentPlan(context,asText(planId, 'Plan id', 200));
  const result = await getAgentExperimentResult(context.repo, context.scanRunId, plan.id);
  const invocations = await context.repo.listToolInvocations(context.scanRunId, context.taskId);
  const compileFailure = invocations.find(invocation => invocation.tool_name === 'bstg.test_plan.compile' &&
    String(invocation.input_json?.plan_id || '') === plan.id && invocation.status === 'failed' &&
    ['experiment_compile_requires_revision', 'experiment_compile_failed'].includes(String(invocation.output_json?.status || '')));
  const compileFeedback = compileFailure?.output_json;
  return { plan_id: plan.id, plan_revision: plan.revision, flow_id: plan.flow_id, source_flow_revision: plan.source_flow_revision,
    status: plan.status, hypothesis: plan.hypothesis, selected_step_orders: plan.steps.map(step => step.source_step_order),
    request_patch_count: plan.patches.length, binding_count: plan.bindings?.length || 0, parent_plan_id: plan.parent_plan_id,
    ...(compileFeedback ? { compile_feedback: { status: compileFeedback.status, retryable: compileFeedback.retryable === true,
      failure_code: compileFeedback.failure_code, summary: compileFeedback.summary } } : {}),
    ...(result ? { result_revision: result.revision, result_status: result.status, execution_verified: result.execution_verified,
      control_verified: result.control_verified, business_invariant_verified: result.business_invariant_verified,
      counterexample_verified: result.counterexample_verified,
      distinct_identity_verified: result.distinct_identity_verified, evidence_ready: result.evidence_ready, missing_evidence: result.missing_evidence,
      business_proof:result.business_proof,
      assertions: result.assertions.map(item => ({ id: item.id, step_order: item.step_order, purpose: item.purpose, passed: item.passed })),
      control_assertions: result.control_assertions.map(item => ({ id: item.id, step_order: item.step_order, purpose: item.purpose, passed: item.passed })) } : {}),
    notice: 'This view deliberately excludes raw request/response bodies, credentials, cookies, and private native traces.' };
}

export async function assessBusinessExperiment(context: AgentToolContext, input: Record<string, any>): Promise<Record<string, any>> {
  const {plan,flow}=await requireCurrentBusinessExperimentPlan(context,asText(input.plan_id, 'Plan id', 200));
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
  const counterexampleVerified = requestedVerdict === 'not_vulnerable' && result.business_proof?.negative_proof?.verified === true;
  const verdict = confirmed ? 'vulnerable' : counterexampleVerified ? 'not_vulnerable' : 'inconclusive';
  const gate = { verdict: confirmed ? 'confirmed' : counterexampleVerified ? 'counterexample' : 'insufficient', plan_id: plan.id, plan_revision: plan.revision,
    source_flow_revision: plan.source_flow_revision, verified: result.business_invariant_verified, result_revision: result.revision,
    execution_verified: result.execution_verified, control_verified: result.control_verified, business_invariant_verified: result.business_invariant_verified,
    counterexample_verified: result.counterexample_verified,
    distinct_identity_verified: result.distinct_identity_verified, native_test_run_ids: result.native_test_run_ids,
    evidence_artifact_ids: result.evidence_artifact_ids, missing_evidence: result.missing_evidence,business_proof:result.business_proof };
  const proof = await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'business_state_proof', source_ref: plan.id,
    title: '模型实验业务证据门槛', content_json: { flow_id: plan.flow_id, ...gate } });
  const assessment = await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'agent_experiment_assessment', source_ref: plan.id,
    title, content_json: { plan_id: plan.id, plan_revision: plan.revision, result_revision: result.revision, requested_verdict: requestedVerdict,
      verdict, title, severity, reason, business_impact: businessImpact, native_evidence_gate: { ...gate, evidence_artifact_ids: [...gate.evidence_artifact_ids, proof.id] } } });
  const judgement = await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'ai_judgement', source_ref: plan.id,
    title, content_json: { verdict, title, business_title: title, severity, reason, business_impact: businessImpact, plan_id: plan.id,
      experiment_id: plan.id, flow_id: plan.flow_id, native_evidence_gate: { ...gate, evidence_artifact_ids: [...gate.evidence_artifact_ids, proof.id, assessment.id] } } });
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

/** Persist a non-finding terminal only when native evidence proves that the
 * current verified Workflow lacks the source read-back required to assess a
 * state-changing experiment. This prevents the model from repeatedly replaying
 * writes that cannot produce a business-state conclusion. */
export async function blockBusinessExperiment(context:AgentToolContext,input:Record<string,any>):Promise<Record<string,any>>{
  assertScanActive();
  const {plan,flow}=await requireCurrentBusinessExperimentPlan(context,asText(input.plan_id,'Plan id',200));
  const reasonCode=String(input.reason_code||'');
  if(!['authoritative_readback_unavailable','negative_counterexample_proof_missing'].includes(reasonCode))throw new ExperimentBlockProtocolError('unsupported_experiment_block_code');

  const result=await getAgentExperimentResult(context.repo,context.scanRunId,plan.id);
  const artifacts=await context.repo.listArtifacts(context.scanRunId);
  const taskArtifacts=artifacts.filter(artifact=>artifact.task_id===context.taskId);
  const resultArtifact=taskArtifacts.filter(artifact=>artifact.artifact_type==='agent_experiment_result'&&artifact.content_json?.plan_id===plan.id&&
    Number(artifact.content_json?.plan_revision)===Number(plan.revision)&&Number(artifact.content_json?.revision)===Number(result?.revision))
    .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
  const assessmentArtifact=taskArtifacts.filter(artifact=>artifact.artifact_type==='agent_experiment_assessment'&&artifact.content_json?.plan_id===plan.id&&
    Number(artifact.content_json?.plan_revision)===Number(plan.revision)&&Number(artifact.content_json?.result_revision)===Number(result?.revision))
    .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
  const planArtifact=taskArtifacts.filter(artifact=>artifact.artifact_type==='agent_experiment_plan'&&artifact.content_json?.id===plan.id&&
    Number(artifact.content_json?.revision)===Number(plan.revision)).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
  const gapIsPersisted=(result?.business_proof?.evidence_gaps||[]).some((gap:any)=>gap?.failure_code===reasonCode);
  if(!result||result.status!=='executed'||result.evidence_ready||!gapIsPersisted||!assessmentArtifact||
      assessmentArtifact.source_ref!==plan.id||String(assessmentArtifact.content_json?.verdict||'')!=='inconclusive'||
      String(assessmentArtifact.content_json?.native_evidence_gate?.verdict||'')!=='insufficient'||!resultArtifact||!planArtifact){
    throw new ExperimentBlockProtocolError('experiment_block_evidence_missing');
  }

  let blockedReason:string;
  let evidenceArtifactIds:string[];
  let title:string;
  if(reasonCode==='authoritative_readback_unavailable'){
    const sourceSteps=(await context.db.repos.workflowSteps.findAll({where:{workflow_id:flow.workflow_id} as any})).sort((a,b)=>a.step_order-b.step_order);
    const selectedOrders=new Set(plan.steps.map(step=>Number(step.source_step_order)));
    const selectedWrites=sourceSteps.filter(step=>selectedOrders.has(step.step_order))
      .filter(step=>!['GET','HEAD','OPTIONS'].includes(parseRawRequest(step.request_snapshot_raw||'')?.method.toUpperCase()||''))
      .map(step=>step.step_order);
    const lastWriteOrder=selectedWrites.length?Math.max(...selectedWrites):0;
    const hasReadback=lastWriteOrder>0&&sourceSteps.some(step=>step.step_order>=lastWriteOrder&&
      ['GET','HEAD'].includes(parseRawRequest(step.request_snapshot_raw||'')?.method.toUpperCase()||''));
    if(hasReadback)throw new ExperimentBlockProtocolError('authoritative_readback_available');
    if(lastWriteOrder===0)throw new ExperimentBlockProtocolError('experiment_block_evidence_missing');
    blockedReason='The verified normal Workflow has no observed GET/HEAD read-back after its state-changing request. Extend and revalidate the normal Flow before running another state-changing experiment.';
    title='模型实验阻塞：缺少权威状态读回';
    evidenceArtifactIds=[planArtifact.id,resultArtifact.id,assessmentArtifact.id,...(result.evidence_artifact_ids||[])];
  }else{
    const task=await context.repo.getTask(String(context.taskId||''));
    const qualifyingAttempts=task?businessExperimentNegativeCounterexampleAttempts(task,artifacts,plan.id):[];
    if(qualifyingAttempts.length<MIN_NEGATIVE_COUNTEREXAMPLE_ATTEMPTS){
      throw new ExperimentBlockProtocolError('negative_counterexample_attempts_incomplete',true);
    }
    blockedReason=`The same negative-counterexample evidence gap persisted across ${qualifyingAttempts.length} distinct completed, control-verified native experiment plans. No security conclusion is available; add or verify a server-owned unchanged-state oracle before continuing.`;
    title='模型实验受阻：缺少服务端负向状态证明';
    evidenceArtifactIds=[planArtifact.id,resultArtifact.id,assessmentArtifact.id,...(result.evidence_artifact_ids||[])];
    for(const attempt of qualifyingAttempts)evidenceArtifactIds.push(attempt.planArtifact.id,attempt.resultArtifact.id,attempt.assessmentArtifact.id,...attempt.traceArtifacts.map(artifact=>artifact.id));
  }
  const existingBlock=taskArtifacts.find(artifact=>artifact.artifact_type==='agent_experiment_block'&&artifact.content_json?.plan_id===plan.id&&
    Number(artifact.content_json?.plan_revision)===Number(plan.revision)&&Number(artifact.content_json?.result_revision)===Number(result.revision));
  if(existingBlock)return {status:'blocked',reason_code:reasonCode,plan_id:plan.id,plan_revision:plan.revision,result_revision:result.revision,
    artifact_id:existingBlock.id,evidence_artifact_count:Array.isArray(existingBlock.content_json?.evidence_artifact_ids)?existingBlock.content_json.evidence_artifact_ids.length:0,
    summary:blockedReason};
  const artifact=await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:context.taskId,artifact_type:'agent_experiment_block',
    source_ref:plan.id,title,content_json:{status:'blocked',plan_id:plan.id,plan_revision:plan.revision,
      result_revision:result.revision,flow_id:flow.id,reason_code:reasonCode,blocked_reason:blockedReason,
      evidence_artifact_ids:[...new Set(evidenceArtifactIds)]}});
  return {status:'blocked',reason_code:reasonCode,plan_id:plan.id,plan_revision:plan.revision,result_revision:result.revision,
    artifact_id:artifact.id,evidence_artifact_count:new Set(evidenceArtifactIds).size,summary:blockedReason};
}
