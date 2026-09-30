import type { AgentToolContext, AgentToolResult, AgentToolSpec } from '../tool-types.js';
import { getBusinessFlow, newBusinessFlow, saveBusinessFlow } from '../../services/ai-scan/agent-business-contract.js';
import {
  assessBusinessExperiment,
  compileBusinessExperiment,
  executeBusinessExperiment,
  inspectBusinessExperiment,
  planBusinessExperiment,
} from '../../services/ai-scan/agent-business-experiment.js';

const id = { type: 'string', minLength: 1, maxLength: 200 };
const scalar = { anyOf: [{ type: 'string', maxLength: 4000 }, { type: 'number' }, { type: 'boolean' }] };
const assertion = {
  type: 'object', required: ['step_order', 'description', 'purpose', 'left', 'op', 'right'], additionalProperties: false,
  properties: {
    id, step_order: { type: 'integer', minimum: 1 }, description: { type: 'string', minLength: 1, maxLength: 1000 },
    purpose: { enum: ['goal', 'identity', 'state', 'control', 'impact'] },
    left: { type: 'object', required: ['type', 'path'], additionalProperties: false,
      properties: { type: { const: 'response' }, path: { type: 'string', minLength: 1, maxLength: 400 } } },
    op: { enum: ['equals', 'not_equals', 'contains', 'not_contains', 'regex', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal'] },
    right: { type: 'object', required: ['type', 'value'], additionalProperties: false,
      properties: { type: { const: 'literal' }, value: { type: 'string', maxLength: 4000 } } },
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
        return { ok: false, error: error?.message || String(error), summary: `${name} did not complete. Inspect the persisted business assets and correct the concrete gap.` };
      }
    },
  };
}

function safeAssertionSummary(assertion: any): Record<string, any> {
  return {
    id: assertion?.id, step_order: assertion?.step_order, description: assertion?.description,
    purpose: assertion?.purpose, left: assertion?.left ? { type: assertion.left.type, path: assertion.left.path } : undefined,
    op: assertion?.op, right: assertion?.right ? {
      type: assertion.right.type,
      key: assertion.right.type === 'literal' ? undefined : assertion.right.key,
      value_present: assertion.right.type === 'literal' && assertion.right.value !== undefined,
    } : undefined,
    missing_behavior: assertion?.missing_behavior, ...(typeof assertion?.passed === 'boolean' ? { passed: assertion.passed } : {}),
  };
}

export function buildBusinessFlowToolSpecs(): AgentToolSpec[] {
  return [
    tool('bstg.business.flow.define',
      'Define one observed business goal for normal learning after target discovery. This creates only a business-flow fact record: it does not claim the goal was executed. Use a separate flow for each independently meaningful user outcome, including opaque routes when page observations reveal the operation.',
      { name: { type: 'string', minLength: 1, maxLength: 200 }, goal: { type: 'string', minLength: 1, maxLength: 2000 }, role: { type: 'string', maxLength: 100 },
        feature_id: id, feature_name: { type: 'string', maxLength: 200 }, start_state: { type: 'string', maxLength: 1000 },
        prerequisites: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 500 } },
        hypotheses: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } } }, ['name', 'goal'],
      async (input, context) => {
        const flow = newBusinessFlow(input, context.taskId);
        const artifact = await saveBusinessFlow(context.repo, context.scanRunId, context.taskId, flow);
        const saved: any = artifact.content_json;
        return { flow_id: saved.id, revision: saved.revision, status: saved.status, name: saved.name, goal: saved.goal,
          summary: 'Business flow recorded. Start capture before the first normal browser action, then prepare and validate a native Workflow.' };
      }, ['creates an append-only business flow record']),
    tool('bstg.business.flow.inspect',
      'Read the latest safe state of one business flow: goal, prerequisites, observed steps, native normal-run result, blockers and evidence references. This excludes raw credentials and private request/response content.',
      { flow_id: id }, ['flow_id'], async (input, context) => {
        const flow = await getBusinessFlow(context.repo, context.scanRunId, input.flow_id);
        return { flow_id: flow.id, revision: flow.revision, name: flow.name, goal: flow.goal, role: flow.role, status: flow.status,
          prerequisites: flow.prerequisites, blockers: flow.blockers, steps: flow.steps, workflow_id: flow.workflow_id, normal_run_id: flow.normal_run_id,
          assertions: (flow.assertions || []).map(safeAssertionSummary), assertions_verified: flow.assertions_verified === true, evidence_artifact_ids: flow.evidence_artifact_ids,
          notice: 'A flow is eligible for a model experiment only when assertions_verified is true and normal_run_id is present.' };
      }),
  ];
}

const planProperties: Record<string, any> = {
  flow_id: id, plan_id: id, parent_plan_id: id, name: { type: 'string', minLength: 1, maxLength: 200 },
  hypothesis: { type: 'string', minLength: 1, maxLength: 2000 }, category: { type: 'string', maxLength: 100 }, rationale: { type: 'string', minLength: 1, maxLength: 3000 },
  control_role: { type: 'string', maxLength: 200 },
  steps: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['id', 'source_step_order'], additionalProperties: false,
    properties: { id, source_step_order: { type: 'integer', minimum: 1 }, role: { type: 'string', maxLength: 200 } } } },
  patches: { type: 'array', maxItems: 24, items: { type: 'object', required: ['step_id', 'location', 'operation', 'path'], additionalProperties: false,
    properties: { step_id: id, location: { enum: ['query', 'header', 'json_body', 'form_body', 'path'] }, operation: { enum: ['set', 'delete', 'append'] },
      path: { type: 'string', minLength: 1, maxLength: 300 }, value: scalar } } },
  bindings: { type: 'array', maxItems: 24, items: { type: 'object', required: ['from_step_id', 'from_location', 'from_path', 'to_step_id', 'to_location', 'to_path', 'variable_name'], additionalProperties: false,
    properties: { from_step_id: id, from_location: { enum: ['response.body', 'response.header'] }, from_path: { type: 'string', minLength: 1, maxLength: 300 },
      to_step_id: id, to_location: { enum: ['query', 'header', 'json_body', 'form_body', 'path'] }, to_path: { type: 'string', minLength: 1, maxLength: 300 },
      variable_name: { type: 'string', minLength: 1, maxLength: 100 } } } },
  repeats: { type: 'array', maxItems: 100, items: { type: 'object', required: ['step_id', 'count'], additionalProperties: false,
    properties: { step_id: id, count: { type: 'integer', minimum: 1, maximum: 12 } } } },
  concurrency: { type: 'object', required: ['step_id', 'count'], additionalProperties: false,
    properties: { step_id: id, count: { type: 'integer', minimum: 2, maximum: 12 } } },
  parallel: { type: 'array', maxItems: 6, items: { type: 'object', required: ['anchor_step_id', 'extra_step_ids'], additionalProperties: false,
    properties: { anchor_step_id: id, extra_step_ids: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: id } } } },
  assertions: { type: 'array', minItems: 1, maxItems: 50, items: assertion },
  control_assertions: { type: 'array', minItems: 1, maxItems: 50, items: assertion },
};

export function buildBusinessExperimentToolSpecs(): AgentToolSpec[] {
  return [
    tool('bstg.test_plan.create',
      'Save an exact model-designed security experiment for one native-verified normal business flow. Choose every source step, concrete field change/deletion/append, response binding, role, skip (by omitting a source step), repeat, concurrency, parallel packets, and both impact and control assertions. The executor will reject fields or operations absent from the recorded request instead of substituting a preset attack.',
      planProperties, ['flow_id', 'name', 'hypothesis', 'rationale', 'steps', 'patches', 'assertions', 'control_assertions'],
      (input, context) => planBusinessExperiment(context, input), ['creates an append-only model experiment plan']),
    tool('bstg.test_plan.compile',
      'Compile the exact current model plan into immutable native Workflow snapshots and mutation profiles. It reports actual native assets and refuses stale normal-flow evidence or unsupported operations. Compilation does not execute requests.',
      { plan_id: id }, ['plan_id'], (input, context) => compileBusinessExperiment(context, { plan_id: input.plan_id }), ['creates native Workflow snapshots']),
    tool('bstg.test_plan.execute',
      'Execute a fresh native control Test Run and the exact compiled experiment Test Run. Returns redacted assertion facts, native run IDs, proof status and evidence gaps. A disproved hypothesis is valid feedback for the next model plan, not a finding.',
      { plan_id: id }, ['plan_id'], (input, context) => executeBusinessExperiment(context, { plan_id: input.plan_id }), ['creates and executes native Test Runs']),
    tool('bstg.test_plan.inspect',
      'Inspect the latest safe model-plan and execution result, including the plan revision, source flow revision, assertion pass/fail facts and specific missing evidence. Raw request bodies, credentials and private traces are deliberately excluded.',
      { plan_id: id }, ['plan_id'], (input, context) => inspectBusinessExperiment(context, input.plan_id)),
    tool('bstg.test_plan.assess',
      'Record the model assessment after inspecting a completed native result. A requested vulnerable verdict becomes confirmed only when native control, execution and business-invariant proof all passed. A requested not_vulnerable verdict requires a completed normal control plus a completed experiment that disproves the hypothesis; otherwise either request is stored as inconclusive and the model should revise the plan.',
      { plan_id: id, result_revision: { type: 'integer', minimum: 1 }, verdict: { enum: ['vulnerable', 'not_vulnerable', 'inconclusive'] },
        title: { type: 'string', minLength: 1, maxLength: 300 }, severity: { enum: ['critical', 'high', 'medium', 'low', 'info'] },
        reason: { type: 'string', minLength: 1, maxLength: 3000 }, business_impact: { type: 'string', minLength: 1, maxLength: 3000 } },
      ['plan_id', 'verdict', 'title', 'severity', 'reason', 'business_impact'], (input, context) => assessBusinessExperiment(context, input),
      ['writes evidence-gated model assessment']),
  ];
}
