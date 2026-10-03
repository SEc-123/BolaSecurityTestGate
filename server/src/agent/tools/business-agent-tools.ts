import type { AgentToolContext, AgentToolResult, AgentToolSpec } from '../tool-types.js';
import { getBusinessFlow, newBusinessFlow, saveBusinessFlow } from '../../services/ai-scan/agent-business-contract.js';
import { configuredIdentityAccounts } from '../../services/ai-scan/identity-material.js';
import { resolvePreparedBrowserIdentity } from '../../services/ai-scan/browser/prepared-identity.js';
import { listBusinessObjectHandles, publicBusinessObjectHandle } from '../../services/ai-scan/business-object-handles.js';
import {
  assessBusinessExperiment,
  blockBusinessExperiment,
  compileBusinessExperiment,
  executeBusinessExperiment,
  inspectBusinessExperiment,
  planBusinessExperiment,
  requireCurrentBusinessExperimentFlow,
  safeExperimentCompileFeedback,
  ExperimentBlockProtocolError,
  ExperimentCompileRecoveryProtocolError,
  ExperimentRevisionProtocolError,
  WorkflowStepBindingMismatchError,
} from '../../services/ai-scan/agent-business-experiment.js';
import { BUSINESS_EXPERIMENT_INTENT } from '../business-task-lifecycle.js';
import { normalObjectiveForTask, requiresNormalObjectiveManifest, type NormalBusinessObjective } from '../normal-business-objectives.js';

const id = { type: 'string', minLength: 1, maxLength: 200 };
const scalar = { anyOf: [{ type: 'string', maxLength: 4000 }, { type: 'number' }, { type: 'boolean' }] };
const executableIdentityKeyMaxLength = 100;
const anonymousIdentityKey = 'anonymous';
const assertion = {
  type: 'object', required: ['step_order', 'description', 'purpose', 'left', 'op', 'right'], additionalProperties: false,
  properties: {
    id, step_order: { type: 'integer', minimum: 1 }, description: { type: 'string', minLength: 1, maxLength: 1000 },
    purpose: { enum: ['goal', 'identity', 'state', 'control', 'impact'] },
    left: { type: 'object', required: ['type', 'path'], additionalProperties: false,
      properties: { type: { const: 'response' }, path: { type: 'string', minLength: 1, maxLength: 400 } } },
    op: { enum: ['equals', 'not_equals', 'contains', 'not_contains', 'regex', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal'] },
    right: { oneOf: [
      { type: 'object', required: ['type', 'value'], additionalProperties: false,
        properties: { type: { const: 'literal' }, value: { type: 'string', maxLength: 4000 } } },
      { type: 'object', required: ['type', 'handle_id'], additionalProperties: false,
        properties: { type: { const: 'value_ref' }, handle_id: id } },
    ] },
    missing_behavior: { const: 'fail' },
  },
};

function tool(name: string, description: string, properties: Record<string, any>, required: string[],
  invoke: (input: Record<string, any>, context: AgentToolContext) => Promise<Record<string, any>>, effects: string[] = []): AgentToolSpec {
  return {
    name, description, input_schema: { type: 'object', properties, required, additionalProperties: false }, side_effects: effects,
    handler: async (input, context): Promise<AgentToolResult> => {
      if (context.signal?.aborted) return { ok: false, error: 'Business Agent task was cancelled.' };
      try {
        const data = await invoke(input, context);
        // An executed experiment that disproves its hypothesis is useful model feedback,
        // not a tool failure. Invalid plans and executor failures still throw above.
        return { ok: true, data, summary: typeof data.summary === 'string' ? data.summary : `${name} completed.` };
      } catch (error: any) {
        if (error instanceof WorkflowStepBindingMismatchError) {
          return { ok: false, error: error.message, data: error.safe_data, summary: error.safe_data.summary };
        }
        if (error instanceof ExperimentCompileRecoveryProtocolError) {
          return { ok: false, error: error.message, data: error.safe_data, summary: String(error.safe_data.summary || error.message) };
        }
        if (error instanceof ExperimentBlockProtocolError) {
          return { ok: false, error: error.message, data: error.safe_data, summary: String(error.safe_data.summary || error.message) };
        }
        if (error instanceof ExperimentRevisionProtocolError) {
          return { ok: false, error: error.message, data: error.safe_data, summary: String(error.safe_data.summary || error.message) };
        }
        if (name === 'bstg.test_plan.compile') {
          const feedback = safeExperimentCompileFeedback(error);
          return { ok: false, error: feedback.summary as string, data: feedback, summary: feedback.summary as string };
        }
        return { ok: false, error: error?.message || String(error), summary: `${name} did not complete. Inspect the persisted business assets and correct the concrete gap.` };
      }
    },
  };
}

function safeAssertionSummary(assertion: any): Record<string, any> {
  const capturedBaseline=assertion?.right?.captured_baseline===true||assertion?.right?.type==='captured_baseline';
  return {
    id: assertion?.id, step_order: assertion?.step_order, description: assertion?.description,
    purpose: assertion?.purpose, left: assertion?.left ? { type: assertion.left.type, path: assertion.left.path } : undefined,
    op: assertion?.op, right: assertion?.right ? {
      type: capturedBaseline?'captured_baseline':assertion.right.type,
      key: capturedBaseline||['literal','value_ref'].includes(assertion.right.type) ? undefined : assertion.right.key,
      handle_id: !capturedBaseline&&assertion.right.type === 'value_ref' ? assertion.right.handle_id : undefined,
      value_present: !capturedBaseline&&assertion.right.type === 'literal' && assertion.right.value !== undefined,
    } : undefined,
    missing_behavior: assertion?.missing_behavior, ...(typeof assertion?.passed === 'boolean' ? { passed: assertion.passed } : {}),
  };
}

function identityKey(value: unknown): string | undefined {
  // Browser contexts canonically URI-encode bounded identity components, so
  // identity keys may legitimately contain @ or Unicode. Exact membership in
  // configured/active identities—not an ASCII-only shape—is the authority.
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > executableIdentityKeyMaxLength || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

async function inspectableBusinessFlow(context:AgentToolContext,flowId:string){
  const taskId=String(context.taskId||'');
  const task=taskId?await context.repo.getTask(taskId):undefined;
  return task?.execution_plan?.intent===BUSINESS_EXPERIMENT_INTENT||task?.task_type==='model_business_experiment'
    ? requireCurrentBusinessExperimentFlow(context,flowId)
    : getBusinessFlow(context.repo,context.scanRunId,flowId);
}

/** A configured entry must contain some supplied material. An empty role map
 * is not executable merely because it has a display key. */
function hasSuppliedIdentityMaterial(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(item => hasSuppliedIdentityMaterial(item, depth + 1));
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(item => hasSuppliedIdentityMaterial(item, depth + 1));
  return false;
}

async function executableIdentityKeys(context: AgentToolContext): Promise<string[]> {
  const run = await context.repo.getRun(context.scanRunId);
  if (!run) throw new Error('Assessment not found.');
  const configured = Object.entries(configuredIdentityAccounts(run.scan_config || {}))
    .flatMap(([key, value]) => {
      const normalized = identityKey(key);
      return normalized && value && typeof value === 'object' && !Array.isArray(value) && hasSuppliedIdentityMaterial(value) ? [normalized] : [];
    });
  const active = (await context.db.repos.accounts.findAll()).flatMap(account => {
    const tags = Array.isArray(account.tags) ? account.tags : [];
    if (account.status !== 'active' || !tags.includes(`scan:${context.scanRunId}`)) return [];
    return tags.flatMap(tag => typeof tag === 'string' && tag.startsWith('role:')
      ? [identityKey(tag.slice('role:'.length))].filter((key): key is string => Boolean(key))
      : []);
  });
  return [...new Set([...configured, ...active])].sort();
}

type FlowRoleResolution =
  | { valid: true; role: string }
  | { valid: false; allowedIdentityKeys: string[] };

async function preparedExecutableIdentityKeys(context: AgentToolContext): Promise<string[]> {
  const candidates = await executableIdentityKeys(context);
  const resolved = await Promise.all(candidates.map(async identity_key => ({ identity_key,
    result: await resolvePreparedBrowserIdentity({ db: context.db, scan_run_id: context.scanRunId, identity_key }) })));
  return resolved.filter(item => item.result.status === 'resolved').map(item => item.identity_key).sort();
}

async function executableFlowRole(input: Record<string, any>, context: AgentToolContext): Promise<FlowRoleResolution> {
  if (!Object.prototype.hasOwnProperty.call(input, 'role') || input.role === undefined || input.role === null) {
    return { valid: true, role: anonymousIdentityKey };
  }
  const role = identityKey(input.role);
  const allowed = await executableIdentityKeys(context);
  if (!role || (role !== anonymousIdentityKey && !allowed.includes(role))) return { valid: false, allowedIdentityKeys: allowed };
  return { valid: true, role };
}

/** Strict normal-only planning is bound to the immutable manifest on the plan
 * task. A model may choose an ID, but it never writes or renames the outcome. */
async function flowDefinitionObjective(input: Record<string, any>, context: AgentToolContext): Promise<NormalBusinessObjective | undefined> {
  const taskId = String(context.taskId || '');
  const task = taskId ? await context.repo.getTask(taskId) : undefined;
  if (!requiresNormalObjectiveManifest(task || undefined)) return undefined;
  const objective = normalObjectiveForTask(task || undefined, input.objective_id);
  if (!objective) {
    throw new Error('A strict normal-business Flow must select one objective_id from the immutable planning manifest. Inspect the planning context and use an exact listed objective ID.');
  }
  const artifacts = await context.repo.listArtifacts(context.scanRunId);
  const latest = new Map<string, any>();
  for (const artifact of artifacts.filter(item => item.artifact_type === 'business_flow')) {
    const flowId = String(artifact.content_json?.id || artifact.source_ref || '');
    if (!flowId) continue;
    const prior = latest.get(flowId);
    const revision = Number(artifact.content_json?.revision || 0);
    if (!prior || revision > Number(prior.content_json?.revision || 0) ||
      revision === Number(prior.content_json?.revision || 0) && String(artifact.created_at) > String(prior.created_at)) latest.set(flowId, artifact);
  }
  if ([...latest.values()].some(artifact => artifact.content_json?.objective_id === objective.id)) {
    throw new Error('This immutable normal-business objective already has a saved Flow. Define the remaining manifest objective instead of creating a duplicate.');
  }
  return objective;
}

export function buildBusinessFlowToolSpecs(): AgentToolSpec[] {
  return [
    tool('bstg.business.flow.define',
      'Define one normal-learning Flow. In strict normal-only planning, choose one exact objective_id from the immutable server manifest; BSTG derives the Flow name and goal from that objective, so do not invent or rename a required outcome. If the objective declares requires_prepared_identity, role must be one exact prepared identity returned by safe context; anonymous is rejected. This creates only a business-flow fact record: it does not claim the goal was executed. role is an execution identity key: use "anonymous" or an exact active/supplied machine key, never a human account or display label.',
      { objective_id: { type: 'string', minLength: 1, maxLength: 100, description: 'Exact immutable normal-business objective ID from the current planning manifest when strict normal objectives are configured.' },
        name: { type: 'string', minLength: 1, maxLength: 200, description: 'Legacy non-strict planning only; ignored when objective_id is required.' },
        goal: { type: 'string', minLength: 1, maxLength: 2000, description: 'Legacy non-strict planning only; ignored when objective_id is required.' },
        role: { type: 'string', minLength: 1, maxLength: 100, description: 'Exactly "anonymous" or an active/supplied executable identity key; account display labels are invalid.' },
        feature_id: id, feature_name: { type: 'string', maxLength: 200 }, start_state: { type: 'string', maxLength: 1000 },
        prerequisites: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 500 } },
        hypotheses: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } } }, [],
      async (input, context) => {
        const objective = await flowDefinitionObjective(input, context);
        const role = await executableFlowRole(input, context);
        const preparedIdentityKeys = objective?.requires_prepared_identity ? await preparedExecutableIdentityKeys(context) : [];
        if (!role.valid || (objective?.requires_prepared_identity &&
          (role.role === anonymousIdentityKey || !preparedIdentityKeys.includes(role.role)))) {
          const allowed = objective?.requires_prepared_identity ? preparedIdentityKeys : role.valid ? [] : role.allowedIdentityKeys;
          return {
            status: 'identity_key_required', identity_key_required: true, allowed_identity_keys: allowed,
            requires_prepared_identity: objective?.requires_prepared_identity === true,
            summary: objective?.requires_prepared_identity
              ? `Business flow was not defined. This server-sealed objective requires one exact prepared scan identity; choose one returned allowed_identity_keys value, never "anonymous" or an account display label. ${allowed.length ? `Available prepared identities: ${allowed.join(', ')}.` : 'No prepared scan identity is currently executable.'}`
              : `Business flow was not defined. Call bstg.business.flow.define again with role "anonymous" or an exact identity key: ${allowed.length ? allowed.join(', ') : '(no active or supplied identity keys)'}. Account names and display labels are not executable identity keys.`,
          };
        }
        const flow = newBusinessFlow({ ...input, role: role.role,
          ...(objective ? { objective_id: objective.id, objective_name: objective.label, objective_completion: objective.completion, objective_operation: objective.operation,
            requires_prepared_identity: objective.requires_prepared_identity, name: objective.label, goal: objective.label } : {}) }, context.taskId);
        const artifact = await saveBusinessFlow(context.repo, context.scanRunId, context.taskId, flow);
        const saved: any = artifact.content_json;
        return { flow_id: saved.id, revision: saved.revision, status: saved.status, name: saved.name, goal: saved.goal,
          objective_id: saved.objective_id, objective_completion: saved.objective_completion,
          objective_operation: saved.objective_operation ? {operation_id:saved.objective_operation.operation_id,side_effect_class:saved.objective_operation.side_effect_class} : undefined,
          requires_prepared_identity: saved.requires_prepared_identity === true, role: saved.role,
          summary: 'Business flow recorded. Start capture before the first normal browser action, then prepare and validate a native Workflow.' };
      }, ['creates an append-only business flow record']),
    tool('bstg.business.flow.inspect',
      'Read the latest safe state of one business flow: goal, prerequisites, observed steps, native normal-run result, blockers and evidence references. This excludes raw credentials and private request/response content.',
      { flow_id: id }, ['flow_id'], async (input, context) => {
        const flow = await inspectableBusinessFlow(context,input.flow_id);
        const handles=await listBusinessObjectHandles(context.repo,context.scanRunId,flow.id);
        return { flow_id: flow.id, revision: flow.revision, name: flow.name, goal: flow.goal, objective_id: flow.objective_id,
          objective_completion:flow.objective_completion,objective_completion_binding:flow.objective_completion_binding,
          objective_operation:flow.objective_operation ? {operation_id:flow.objective_operation.operation_id,side_effect_class:flow.objective_operation.side_effect_class} : undefined,
          objective_operation_binding:flow.objective_operation_binding,
          requires_prepared_identity:flow.requires_prepared_identity === true, role: flow.role, status: flow.status,
          prerequisites: flow.prerequisites, blockers: flow.blockers, steps: flow.steps,
          recording_session_id:flow.recording_session_id,recording_context_key:flow.recording_context_key,
          recording_context_scope:flow.recording_context_scope,recording_identity_key:flow.recording_identity_key,
          workflow_id: flow.workflow_id, normal_run_id: flow.normal_run_id,
          assertions: (flow.assertions || []).map(safeAssertionSummary), assertions_verified: flow.assertions_verified === true, evidence_artifact_ids: flow.evidence_artifact_ids,
          object_handles:handles.map(publicBusinessObjectHandle),
          notice: 'A flow is eligible for a model experiment only when assertions_verified is true and normal_run_id is present. Object handles are opaque server-owned values from verified normal responses; use their handle_id as value_ref rather than copying request or response values.' };
      }),
    tool('bstg.business.object_handles.inspect',
      'List opaque dynamic values produced by a verified normal business flow. Each handle can be used as a model plan value_ref for a request patch or semantic assertion; raw object IDs, tokens, cookies and response values remain private and are resolved by the native compiler only.',
      {flow_id:id},['flow_id'],async(input,context)=>{
        const flow=await inspectableBusinessFlow(context,input.flow_id);
        if(flow.status!=='verified'||flow.assertions_verified!==true||!flow.normal_run_id)throw new Error('Object handles are available only after a verified native normal flow.');
        const handles=await listBusinessObjectHandles(context.repo,context.scanRunId,flow.id);
        return {flow_id:flow.id,normal_run_id:flow.normal_run_id,handles:handles.map(publicBusinessObjectHandle),
          summary:handles.length?'Opaque handles are available for model-selected cross-step or cross-identity experiments.':'The verified flow did not yield a bounded scalar response value handle.'};
      }),
  ];
}

const workflowStepOrder = {
  type: 'integer', minimum: 1,
  description: 'Use the exact integer step_order from the latest bstg.workflow.inspect.steps[].step_order. BSTG binds that order to the current native Workflow step.',
};

const planProperties: Record<string, any> = {
  flow_id: id, plan_id: id, parent_plan_id: id, name: { type: 'string', minLength: 1, maxLength: 200 },
  hypothesis: { type: 'string', minLength: 1, maxLength: 2000 }, category: { type: 'string', maxLength: 100 }, rationale: { type: 'string', minLength: 1, maxLength: 3000 },
  control_role: { type: 'string', maxLength: 200 },
  steps: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['workflow_step_order'], additionalProperties: false,
    properties: { workflow_step_order: workflowStepOrder, role: { type: 'string', maxLength: 200 } } } },
  patches: { type: 'array', maxItems: 24, items: { type: 'object', required: ['workflow_step_order', 'location', 'operation', 'path'], additionalProperties: false,
    properties: { workflow_step_order: workflowStepOrder, location: { enum: ['query', 'header', 'json_body', 'form_body', 'path'] }, operation: { enum: ['set', 'delete', 'append'] },
      path: { type: 'string', minLength: 1, maxLength: 300 }, value: scalar,
      value_ref:{type:'object',required:['handle_id'],additionalProperties:false,properties:{handle_id:id}} } } },
  bindings: { type: 'array', maxItems: 24, items: { type: 'object', required: ['from_workflow_step_order', 'from_location', 'from_path', 'to_workflow_step_order', 'to_location', 'to_path', 'variable_name'], additionalProperties: false,
    properties: { from_workflow_step_order: workflowStepOrder, from_location: { enum: ['response.body', 'response.header'] }, from_path: { type: 'string', minLength: 1, maxLength: 300 },
      to_workflow_step_order: workflowStepOrder, to_location: { enum: ['query', 'header', 'json_body', 'form_body', 'path'] }, to_path: { type: 'string', minLength: 1, maxLength: 300 },
      variable_name: { type: 'string', minLength: 1, maxLength: 100 } } } },
  repeats: { type: 'array', maxItems: 100, items: { type: 'object', required: ['workflow_step_order', 'count'], additionalProperties: false,
    properties: { workflow_step_order: workflowStepOrder, count: { type: 'integer', minimum: 1, maximum: 12 } } } },
  concurrency: { type: 'object', required: ['workflow_step_order', 'count'], additionalProperties: false,
    properties: { workflow_step_order: workflowStepOrder, count: { type: 'integer', minimum: 2, maximum: 12 } } },
  parallel: { type: 'array', maxItems: 6, items: { type: 'object', required: ['anchor_workflow_step_order', 'extra_workflow_step_orders'], additionalProperties: false,
    properties: { anchor_workflow_step_order: workflowStepOrder, extra_workflow_step_orders: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: workflowStepOrder } } } },
  assertions: { type: 'array', minItems: 1, maxItems: 50, items: assertion },
  control_assertions: { type: 'array', minItems: 1, maxItems: 50, items: assertion },
};

export function buildBusinessExperimentToolSpecs(): AgentToolSpec[] {
  return [
    tool('bstg.test_plan.create',
      'Save an exact model-designed security experiment for one native-verified normal business flow. Select each source step by its exact integer step_order from the latest bstg.workflow.inspect.steps[].step_order and put it in the workflow_step_order input fields; use the same order in response-binding, repeat, concurrency and parallel references. BSTG resolves these orders to the current native Workflow steps and rejects stale or unknown orders. Request field paths describe data locations and are never step references. This experiment view excludes Workflow asset and template handles. Choose every source step, concrete field change/deletion/append, response binding, role, skip (by omitting a source step), repeat, concurrency, parallel packets, and both impact and control assertions. Use value_ref.handle_id only from bstg.business.object_handles.inspect for dynamic cross-account/object values; the executor resolves it privately. The executor rejects absent fields or operations instead of substituting a preset attack.',
      planProperties, ['flow_id', 'name', 'hypothesis', 'rationale', 'steps', 'patches', 'assertions', 'control_assertions'],
      (input, context) => planBusinessExperiment(context, input), ['creates an append-only model experiment plan']),
    tool('bstg.test_plan.compile',
      'Compile the exact current model plan into immutable native Workflow snapshots and mutation profiles. It reports safe closed failure codes for correctable plan rejections; inspect a rejected plan and create one fresh child plan instead of retrying that same plan. Compilation does not execute requests.',
      { plan_id: id }, ['plan_id'], (input, context) => compileBusinessExperiment(context, { plan_id: input.plan_id }), ['creates native Workflow snapshots']),
    tool('bstg.test_plan.execute',
      'Execute a fresh native control Test Run and the exact compiled experiment Test Run. Returns redacted assertion facts, native run IDs, proof status and evidence gaps. A disproved hypothesis is valid feedback for the next model plan, not a finding.',
      { plan_id: id }, ['plan_id'], (input, context) => executeBusinessExperiment(context, { plan_id: input.plan_id }), ['creates and executes native Test Runs']),
    tool('bstg.test_plan.inspect',
      'Inspect the latest safe model-plan and execution result, including the plan revision, source flow revision, assertion pass/fail facts and finite business_proof.evidence_gaps codes with actionable summaries. Raw request bodies, credentials and private traces are deliberately excluded.',
      { plan_id: id }, ['plan_id'], (input, context) => inspectBusinessExperiment(context, input.plan_id)),
    tool('bstg.test_plan.assess',
      'Record the model assessment after inspecting a completed native result. A requested vulnerable verdict becomes confirmed only when native control, execution and business-invariant proof all passed. A requested not_vulnerable verdict requires a completed normal control plus a completed experiment that disproves the hypothesis; otherwise either request is stored as inconclusive and the model should revise the plan.',
      { plan_id: id, result_revision: { type: 'integer', minimum: 1 }, verdict: { enum: ['vulnerable', 'not_vulnerable', 'inconclusive'] },
        title: { type: 'string', minLength: 1, maxLength: 300 }, severity: { enum: ['critical', 'high', 'medium', 'low', 'info'] },
        reason: { type: 'string', minLength: 1, maxLength: 3000 }, business_impact: { type: 'string', minLength: 1, maxLength: 3000 } },
      ['plan_id', 'verdict', 'title', 'severity', 'reason', 'business_impact'], (input, context) => assessBusinessExperiment(context, input),
      ['writes evidence-gated model assessment']),
    tool('bstg.test_plan.block',
      'Record a safe blocked outcome only when the current persisted result has the exact authoritative_readback_unavailable evidence gap and the verified native Workflow contains no observed GET/HEAD read-back after its selected write. The server links the block to the current plan, native result, assessment, and traces. A block is not a secure conclusion or a vulnerability finding.',
      { plan_id:id, reason_code:{enum:['authoritative_readback_unavailable']} }, ['plan_id','reason_code'],
      (input,context)=>blockBusinessExperiment(context,input), ['persists an evidence-linked blocked experiment outcome']),
  ];
}
