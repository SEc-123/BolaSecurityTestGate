import { createHash } from 'node:crypto';
import type { AgentToolContext, AgentToolResult, AgentToolSpec } from '../tool-types.js';
import type { ApiTemplate, RecordingSession, TestRun, Workflow, WorkflowStep } from '../../types/index.js';
import { dbAll } from '../../db/sql-helpers.js';
import { executeWorkflowRun } from '../../services/workflow-runner.js';
import { getTraceByRunId } from '../../services/debug-trace.js';
import { assertScanActive } from '../../services/ai-scan/run-control.js';
import { isAuthorizedBusinessCoverageRetryTask, prepareBusinessWorkflow } from '../../services/ai-scan/agent-business-capture.js';
import { currentBusinessExperimentFlow } from '../../services/ai-scan/agent-business-experiment.js';
import { getBusinessFlow, type BusinessFlow } from '../../services/ai-scan/agent-business-contract.js';
import { BUSINESS_EXPERIMENT_INTENT, BUSINESS_LEARNING_INTENT } from '../business-task-lifecycle.js';

/**
 * These adapters deliberately expose the native execution graph as a bounded,
 * model-readable capability. They do not turn the Agent into an unscoped
 * database browser: every item must be attributable to the current scan via a
 * business recording, a scan-owned Test Run, or an experiment compilation.
 */
const SECRET_FIELD = /(?:password|passwd|^pwd$|secret|authorization|cookie|(?:^|[_-])(token|csrf|xsrf|ticket|otp|passcode|session)(?:$|[_-])|verification[_-]?code|^_g$)/i;
const VALUE_FIELD = /(?:^value$|^values$|example|sample|default|current_value|value_preview|value_text|operand|payload)/i;
const RAW_FIELD = /(?:raw|request_body|response_body|request_snapshot|captured_request|trace|storage_state|auth_profile)/i;
const MAX_ITEMS = 80;

type NativeScope = {
  sessions: Map<string, RecordingSession>;
  workflows: Map<string, Workflow>;
  templates: Map<string, ApiTemplate>;
  testRuns: Map<string, TestRun>;
  taskFlow?:BusinessFlow;
  taskId?:string;
  experimentFlow?:boolean;
};

type TaskBoundBusinessFlow = { flow: BusinessFlow; taskId: string; experiment: boolean };

function digest(value: unknown): string {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function bounded(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(MAX_ITEMS, parsed)) : fallback;
}

function safeText(value: unknown, max = 600): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) || undefined;
}

/** Normal learning and security experiments each own one scheduler-bound flow.
 * Native asset discovery for those stages must not expose a sibling capture,
 * workflow, Test Run, or experiment plan merely because it belongs to the same
 * scan. Generic/review stages retain the existing scan-wide inventory. */
async function taskBoundBusinessFlow(context:AgentToolContext):Promise<TaskBoundBusinessFlow|undefined>{
  const taskId=String(context.taskId||'');
  if(!taskId)return undefined;
  const task=await context.repo.getTask(taskId);
  const intent=String(task?.execution_plan?.intent||'');
  if(intent===BUSINESS_EXPERIMENT_INTENT||task?.task_type==='model_business_experiment'){
    return {flow:await currentBusinessExperimentFlow(context),taskId,experiment:true};
  }
  if(intent!==BUSINESS_LEARNING_INTENT)return undefined;
  const flowId=String(task?.execution_plan?.flow_id||'');
  if(!flowId)throw new Error('Normal business learning native assets require the current task flow.');
  const flow=await getBusinessFlow(context.repo,context.scanRunId,flowId);
  if(flow.owner_task_id&&flow.owner_task_id!==taskId&&!await isAuthorizedBusinessCoverageRetryTask(context,task,flow)){
    throw new Error('Normal business learning native assets belong only to the current task flow.');
  }
  return {flow,taskId,experiment:false};
}

/**
 * Workflow errors can include a raw request, response excerpt, or transport
 * header assembled by a lower-level executor. The model needs a usable class
 * of failure, never that diagnostic verbatim. The complete diagnostic stays
 * in the private Test Run/trace for an authorized reviewer.
 */
function safeExecutionDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.replace(/[\r\n\t]+/g, ' ').trim();
  const status = text.match(/\b(?:http\s*)?(?:status|response)?\s*[:=]?\s*([1-5]\d\d)\b/i);
  if (status) return `Native executor reported HTTP ${status[1]}; raw diagnostic is retained in private evidence.`;
  if (/timed?\s*out|timeout/i.test(text)) return 'Native executor timed out; raw diagnostic is retained in private evidence.';
  if (/network|socket|econn|fetch failed|connection/i.test(text)) return 'Native executor reported a transport failure; raw diagnostic is retained in private evidence.';
  if (/snapshot/i.test(text)) return 'Native executor could not use the stored snapshot; raw diagnostic is retained in private evidence.';
  if (/mapping|variable|extract/i.test(text)) return 'Native executor reported a variable or mapping failure; raw diagnostic is retained in private evidence.';
  return 'Native executor reported an execution issue; raw diagnostic is retained in private evidence.';
}

function safeShape(value: unknown, key = '', depth = 0): any {
  if (depth > 10) return '[nested structure omitted]';
  if (RAW_FIELD.test(key)) return '[private execution source retained]';
  if (SECRET_FIELD.test(key)) return '[REDACTED]';
  if (VALUE_FIELD.test(key)) return '[value omitted]';
  if (value === null) return null;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeShape(item, key, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, 80).map(([name, item]) => [name, safeShape(item, name, depth + 1)]));
  if (typeof value === 'string') return { type: 'string', length: value.length };
  return { type: typeof value };
}

function fieldPaths(value: unknown, prefix = '', key = '', depth = 0, result: Array<{ path: string; type: string; sensitive: boolean }> = []): Array<{ path: string; type: string; sensitive: boolean }> {
  if (result.length >= 120 || depth > 10 || RAW_FIELD.test(key)) return result;
  if (value === null || typeof value !== 'object') {
    if (prefix) result.push({ path: prefix, type: value === null ? 'null' : typeof value, sensitive: SECRET_FIELD.test(key) });
    return result;
  }
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item, index) => fieldPaths(item, `${prefix}${prefix ? '.' : ''}${index}`, key, depth + 1, result));
    return result;
  }
  for (const [name, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    fieldPaths(item, `${prefix}${prefix ? '.' : ''}${name}`, name, depth + 1, result);
  }
  return result;
}

function templateSummary(template: ApiTemplate): Record<string, any> {
  const structure = template.parsed_structure || {};
  return {
    id: template.id,
    name: safeText(template.name, 200) || 'Native request template',
    group_name: safeText(template.group_name, 120),
    description: safeText(template.description, 500),
    active: template.is_active === true,
    source_recording_session_id: template.source_recording_session_id,
    request_shape: safeShape(structure),
    observed_field_paths: fieldPaths(structure),
    variable_names: Array.isArray(template.variables) ? template.variables.slice(0, 80).map((item: any) => ({
      name: safeText(item?.name || item?.variable_name || item, 120),
      location: safeText(item?.location || item?.target || item?.to_location, 120),
      sensitive: SECRET_FIELD.test(String(item?.name || item?.variable_name || '')),
    })) : [],
  };
}

function workflowSummary(workflow: Workflow, steps: WorkflowStep[]): Record<string, any> {
  return {
    id: workflow.id,
    name: safeText(workflow.name, 200) || 'Native workflow',
    description: safeText(workflow.description, 500),
    workflow_type: workflow.workflow_type || 'baseline',
    template_mode: workflow.template_mode || 'reference',
    source_recording_session_id: workflow.source_recording_session_id,
    step_count: steps.length,
    steps: steps.map(step => ({
      // `id` remains for existing callers. The explicit alias prevents a
      // model from confusing this native WorkflowStep with a business-flow
      // graph step, whose shape also includes an `id` and `step_order`.
      id: step.id, workflow_step_id: step.id, step_order: step.step_order, template_id: step.api_template_id,
      name: safeText(step.snapshot_template_name, 200), has_snapshot: Boolean(step.request_snapshot_raw),
      assertions: Array.isArray(step.step_assertions) ? step.step_assertions.slice(0, 30).map((assertion: any) => ({
        id: safeText(assertion?.id, 120), purpose: safeText(assertion?.purpose, 60), left: safeShape(assertion?.left),
        op: safeText(assertion?.op, 60), right_type: safeText(assertion?.right?.captured_baseline===true ? 'captured_baseline' : assertion?.right?.type, 60), missing_behavior: safeText(assertion?.missing_behavior, 60),
      })) : [],
    })),
  };
}

function testRunSummary(testRun: TestRun): Record<string, any> {
  const params = testRun.execution_params || {};
  return {
    id: testRun.id,
    name: safeText(testRun.name, 200) || 'Native Test Run',
    status: safeText(testRun.status, 60),
    execution_type: safeText(testRun.execution_type, 60),
    trigger_type: safeText(testRun.trigger_type, 60),
    workflow_id: testRun.workflow_id,
    source_recording_session_id: testRun.source_recording_session_id,
    progress_percent: Number(testRun.progress_percent || 0),
    has_execution_error: testRun.has_execution_error === true,
    errors_count: Number(testRun.errors_count || 0),
    error_message: safeExecutionDiagnostic(testRun.error_message),
    started_at: testRun.started_at,
    completed_at: testRun.completed_at,
    model_directed: params.model_directed === true,
    plan_id: typeof params.plan_id === 'string' ? params.plan_id : undefined,
  };
}

async function nativeScope(context: AgentToolContext): Promise<NativeScope> {
  const taskFlow=await taskBoundBusinessFlow(context);
  const sessions = new Map((await context.db.repos.recordingSessions.findAll()).filter(session =>
    session.capture_filters?.source === 'agent_business' && session.capture_filters?.scan_run_id === context.scanRunId)
    .map(session => [session.id, session]));
  const artifacts = await context.repo.listArtifacts(context.scanRunId);
  const compiledWorkflowIds = new Set<string>();
  for (const artifact of artifacts.filter(item => item.artifact_type === 'agent_experiment_compilation')) {
    for (const key of ['source_workflow_id', 'control_workflow_id', 'experiment_workflow_id']) {
      const value = artifact.content_json?.[key];
      if (typeof value === 'string') compiledWorkflowIds.add(value);
    }
  }
  const testRuns = new Map((await context.db.repos.testRuns.findAll()).filter(testRun =>
    testRun.execution_params?.scan_run_id === context.scanRunId ||
    (testRun.source_recording_session_id && sessions.has(testRun.source_recording_session_id)))
    .map(testRun => [testRun.id, testRun]));
  const workflowIds = new Set<string>(compiledWorkflowIds);
  if(taskFlow?.flow.workflow_id)workflowIds.add(taskFlow.flow.workflow_id);
  for (const testRun of testRuns.values()) if (testRun.workflow_id) workflowIds.add(testRun.workflow_id);
  const allWorkflows = await context.db.repos.workflows.findAll();
  for (const workflow of allWorkflows) if (workflow.source_recording_session_id && sessions.has(workflow.source_recording_session_id)) workflowIds.add(workflow.id);
  const workflows = new Map(allWorkflows.filter(workflow => workflowIds.has(workflow.id)).map(workflow => [workflow.id, workflow]));
  const templateIds = new Set<string>();
  for (const workflow of workflows.values()) {
    for (const step of await context.db.repos.workflowSteps.findAll({ where: { workflow_id: workflow.id } as any })) templateIds.add(step.api_template_id);
  }
  for (const testRun of testRuns.values()) for (const templateId of testRun.template_ids || []) templateIds.add(templateId);
  const templates = new Map((await context.db.repos.apiTemplates.findAll()).filter(template =>
    templateIds.has(template.id) || Boolean(template.source_recording_session_id && sessions.has(template.source_recording_session_id)))
    .map(template => [template.id, template]));
  if(!taskFlow)return { sessions, workflows, templates, testRuns };
  const allowedWorkflowIds=new Set([taskFlow.flow.workflow_id].filter((id):id is string=>Boolean(id)));
  const scopedWorkflows=new Map([...workflows].filter(([id])=>allowedWorkflowIds.has(id)));
  const scopedTemplateIds=new Set<string>();
  for(const workflow of scopedWorkflows.values()){
    for(const step of await context.db.repos.workflowSteps.findAll({where:{workflow_id:workflow.id} as any}))scopedTemplateIds.add(step.api_template_id);
  }
  const scopedSessions=new Map([...sessions].filter(([id])=>id===taskFlow.flow.recording_session_id));
  const scopedTestRuns=new Map([...testRuns].filter(([id,testRun])=>id===taskFlow.flow.normal_run_id||
    String(testRun.execution_params?.ai_scan_task_id||'')===taskFlow.taskId));
  const scopedTemplates=new Map([...templates].filter(([id])=>scopedTemplateIds.has(id)));
  return {sessions:scopedSessions,workflows:scopedWorkflows,templates:scopedTemplates,testRuns:scopedTestRuns,
    taskFlow:taskFlow.flow,taskId:taskFlow.taskId,experimentFlow:taskFlow.experiment};
}

async function scopedWorkflow(context: AgentToolContext, workflowId: string): Promise<{ scope: NativeScope; workflow: Workflow; steps: WorkflowStep[] }> {
  const scope = await nativeScope(context);
  if(scope.taskFlow&&workflowId!==scope.taskFlow.workflow_id){
    throw new Error('Native workflow inspection belongs only to the current task flow.');
  }
  const workflow = scope.workflows.get(workflowId);
  if (!workflow) throw new Error('The workflow is not attributable to this assessment. Select a scan-owned recording or native execution asset first.');
  const steps = (await context.db.repos.workflowSteps.findAll({ where: { workflow_id: workflow.id } as any }))
    .sort((a, b) => a.step_order - b.step_order);
  return { scope, workflow, steps };
}

function tool(name: string, description: string, properties: Record<string, any>, required: string[],
  invoke: (input: Record<string, any>, context: AgentToolContext) => Promise<Record<string, any>>, sideEffects: string[] = []): AgentToolSpec {
  return {
    name,
    description,
    input_schema: { type: 'object', properties, required, additionalProperties: false },
    side_effects: sideEffects,
    handler: async (input, context): Promise<AgentToolResult> => {
      if (context.signal?.aborted) return { ok: false, error: 'Native asset operation was cancelled.' };
      try {
        const data = await invoke(input, context);
        return { ok: true, data, summary: typeof data.summary === 'string' ? data.summary : `${name} completed.` };
      } catch (error: any) {
        return { ok: false, error: error?.message || String(error), summary: `${name} could not complete for the current assessment.` };
      }
    },
  };
}

async function inspectWorkflow(context: AgentToolContext, workflowId: string): Promise<Record<string, any>> {
  const { scope, workflow, steps } = await scopedWorkflow(context, workflowId);
  const templates = new Map(await Promise.all(steps.map(async step => [step.api_template_id, scope.templates.get(step.api_template_id)] as const)));
  const mappings = await dbAll<Record<string, any>>(context.db, `SELECT from_step_order, from_location, from_path, to_step_order, to_location, to_path, variable_name, confidence, reason, is_enabled
    FROM workflow_mappings WHERE workflow_id = ? ORDER BY from_step_order, to_step_order`, [workflow.id]);
  const extractors = await context.db.repos.workflowExtractors.findAll({ where: { workflow_id: workflow.id } as any });
  const variables = await context.db.repos.workflowVariableConfigs.findAll({ where: { workflow_id: workflow.id } as any });
  if (scope.experimentFlow) {
    return {
      workflow_id: workflow.id,
      name: safeText(workflow.name, 200) || 'Native workflow',
      description: safeText(workflow.description, 500),
      workflow_type: workflow.workflow_type || 'baseline',
      template_mode: workflow.template_mode || 'reference',
      step_count: steps.length,
      steps: steps.map(step => {
        const template = templates.get(step.api_template_id);
        return {
          step_order: step.step_order,
          method: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(String(template?.parsed_structure?.method||'').toUpperCase())
            ? String(template?.parsed_structure?.method).toUpperCase() : 'OTHER',
          name: safeText(step.snapshot_template_name || template?.name, 200),
          has_snapshot: Boolean(step.request_snapshot_raw),
          observed_field_paths: template ? fieldPaths(template.parsed_structure) : [],
          assertions: Array.isArray(step.step_assertions) ? step.step_assertions.slice(0, 30).map((assertion: any) => ({
            purpose: safeText(assertion?.purpose, 60),
            left: safeShape(assertion?.left),
            op: safeText(assertion?.op, 60),
            right_type: safeText(assertion?.right?.captured_baseline===true ? 'captured_baseline' : assertion?.right?.type, 60),
            missing_behavior: safeText(assertion?.missing_behavior, 60),
          })) : [],
        };
      }),
      variable_configs: variables.slice(0, 80).map(item => ({ name: safeText(item.name, 120), data_source: safeText(item.data_source, 120),
        role: safeText(item.role, 80), account_field_name: SECRET_FIELD.test(String(item.account_field_name || '')) ? '[REDACTED]' : safeText(item.account_field_name, 120),
        mapping_count: Array.isArray(item.step_variable_mappings) ? item.step_variable_mappings.length : 0 })),
      mappings: mappings.slice(0, 120).map(item => ({ from_step_order: Number(item.from_step_order), from_location: safeText(item.from_location, 80),
        from_path: safeText(item.from_path, 200), to_step_order: Number(item.to_step_order), to_location: safeText(item.to_location, 80),
        to_path: safeText(item.to_path, 200), variable_name: safeText(item.variable_name, 120), confidence: Number(item.confidence || 0),
        reason: safeText(item.reason, 80), enabled: item.is_enabled === true || item.is_enabled === 1 })),
      extractors: extractors.slice(0, 80).map(item => ({ step_order: item.step_order, name: safeText(item.name, 120), source: safeText(item.source, 120), required: item.required === true })),
      notice: 'For model test-plan references, use only the exact integer steps[].step_order. BSTG binds that order to the current native Workflow step. Field paths are request-data paths, never step references; opaque Workflow and template handles are omitted from this experiment view.',
    };
  }
  return {
    ...workflowSummary(workflow, steps),
    templates: steps.map(step => {
      const template = templates.get(step.api_template_id);
      return template ? templateSummary(template) : { id: step.api_template_id, missing: true };
    }),
    variable_configs: variables.slice(0, 80).map(item => ({ name: safeText(item.name, 120), data_source: safeText(item.data_source, 120),
      role: safeText(item.role, 80), account_field_name: SECRET_FIELD.test(String(item.account_field_name || '')) ? '[REDACTED]' : safeText(item.account_field_name, 120),
      mapping_count: Array.isArray(item.step_variable_mappings) ? item.step_variable_mappings.length : 0 })),
    mappings: mappings.slice(0, 120).map(item => ({ from_step_order: Number(item.from_step_order), from_location: safeText(item.from_location, 80),
      from_path: safeText(item.from_path, 200), to_step_order: Number(item.to_step_order), to_location: safeText(item.to_location, 80),
      to_path: safeText(item.to_path, 200), variable_name: safeText(item.variable_name, 120), confidence: Number(item.confidence || 0),
      reason: safeText(item.reason, 80), enabled: item.is_enabled === true || item.is_enabled === 1 })),
    extractors: extractors.slice(0, 80).map(item => ({ step_order: item.step_order, name: safeText(item.name, 120), source: safeText(item.source, 120), required: item.required === true })),
    notice: 'This inspection shows names, field paths and native wiring only. Request values, cookies, credentials, response bodies and extractor values remain private.',
  };
}

async function runNativeWorkflow(context: AgentToolContext, workflowId: string): Promise<Record<string, any>> {
  assertScanActive();
  if (!context.taskId) throw new Error('bstg.native.run requires an active assessment task so its Test Run and evidence remain attributable.');
  const { workflow, steps } = await scopedWorkflow(context, workflowId);
  if (!steps.length || steps.some(step => !step.request_snapshot_raw)) {
    throw new Error('A fresh native run requires a scan-owned workflow with an immutable request snapshot for every selected step. Prepare it from a complete recording first.');
  }
  const run = await context.repo.getRun(context.scanRunId);
  if (!run) throw new Error('Assessment not found.');
  const session = workflow.source_recording_session_id ? await context.db.repos.recordingSessions.findById(workflow.source_recording_session_id) : null;
  const accountIds = session?.account_id ? [session.account_id] : workflow.attacker_account_id ? [workflow.attacker_account_id] : [];
  const environment = await context.db.repos.environments.create({ name: `Agent native run ${workflow.name}`.slice(0, 200), base_url: run.base_url, is_active: true } as any);
  const testRun = await context.db.repos.testRuns.create({
    name: `Agent native evidence ${workflow.name}`.slice(0, 200), status: 'pending', execution_type: 'workflow', trigger_type: 'ai_scan',
    workflow_id: workflow.id, account_ids: accountIds, environment_id: environment.id, rule_ids: [], progress_percent: 0,
    source_recording_session_id: workflow.source_recording_session_id,
    execution_params: { scan_run_id: context.scanRunId, ai_scan_task_id: context.taskId, native_asset_tool: true, evidence_only: true },
  } as any);
  const execution = await executeWorkflowRun({ test_run_id: testRun.id, workflow_id: workflow.id, account_ids: accountIds,
    environment_id: environment.id, evidence_only: true });
  const trace = getTraceByRunId('workflow', testRun.id);
  const traceArtifact = await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId,
    artifact_type: 'agent_native_run_trace', source_ref: testRun.id, title: 'Agent 原生运行轨迹',
    content_json: { workflow_id: workflow.id, test_run_id: testRun.id, trace, private: true } });
  const factArtifact = await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId,
    artifact_type: 'agent_native_run_result', source_ref: testRun.id, title: 'Agent 原生运行结果', content_json: {
      workflow_id: workflow.id, test_run_id: testRun.id, execution_success: execution.success === true,
      has_execution_error: execution.has_execution_error === true, trace_artifact_id: traceArtifact.id,
      executed_step_orders: (trace?.records || []).map(record => Number(record.meta?.step_order || 0)).filter(Boolean),
    } });
  return {
    workflow_id: workflow.id, test_run_id: testRun.id, execution_success: execution.success === true,
    has_execution_error: execution.has_execution_error === true,
    errors: [execution.error, ...(execution.warnings || [])].map(safeExecutionDiagnostic).filter((item): item is string => Boolean(item)),
    executed_step_orders: (trace?.records || []).map(record => Number(record.meta?.step_order || 0)).filter(Boolean),
    evidence_artifact_ids: [factArtifact.id, traceArtifact.id],
    summary: execution.success ? 'Fresh native Test Run completed. Inspect semantic assertions before treating this as a business result.' :
      'Fresh native Test Run completed with execution gaps. Inspect its redacted result and adapt the workflow or experiment.',
  };
}

export function buildNativeAssetToolSpecs(): AgentToolSpec[] {
  const id = { type: 'string', minLength: 1, maxLength: 200 };
  return [
    tool('bstg.assets.search',
      'List current-assessment native recordings, templates, workflows, Test Runs and model experiment plans. Results are provenance-scoped and contain only names, structure and status; raw traffic, credentials and dynamic values are excluded.',
      { kind: { enum: ['all', 'recordings', 'templates', 'workflows', 'test_runs', 'experiments'] }, limit: { type: 'integer', minimum: 1, maximum: MAX_ITEMS } }, [],
      async (input, context) => {
        const scope = await nativeScope(context); const kind = String(input.kind || 'all'); const limit = bounded(input.limit, 40);
        const artifacts = await context.repo.listArtifacts(context.scanRunId);
        const out: Record<string, any> = {};
        if (kind === 'all' || kind === 'recordings') out.recordings = [...scope.sessions.values()].slice(0, limit).map(session => ({
          id: session.id, name: safeText(session.name, 200), status: session.status, role: safeText(session.role, 100), event_count: Number(session.event_count || 0),
          context: 'private capture context available to the native executor',
        }));
        if (kind === 'all' || kind === 'templates') out.templates = [...scope.templates.values()].slice(0, limit).map(templateSummary);
        if (kind === 'all' || kind === 'workflows') {
          out.workflows = await Promise.all([...scope.workflows.values()].slice(0, limit).map(async workflow =>
            workflowSummary(workflow, (await context.db.repos.workflowSteps.findAll({ where: { workflow_id: workflow.id } as any })).sort((a, b) => a.step_order - b.step_order))));
        }
        if (kind === 'all' || kind === 'test_runs') out.test_runs = [...scope.testRuns.values()].slice(0, limit).map(testRunSummary);
        if (kind === 'all' || kind === 'experiments') out.experiments = artifacts.filter(artifact => artifact.artifact_type === 'agent_experiment_plan' &&
          (!scope.taskFlow||artifact.content_json?.flow_id===scope.taskFlow.id)).slice(0, limit)
          .map(artifact => ({ plan_id: artifact.content_json?.id, revision: artifact.content_json?.revision, flow_id: artifact.content_json?.flow_id,
            name: safeText(artifact.content_json?.name, 200), status: safeText(artifact.content_json?.status, 60), hypothesis: safeText(artifact.content_json?.hypothesis, 500) }));
        return { kind, ...out, summary: 'Listed scan-owned native assets. Inspect an ID before selecting it for a new normal replay or model experiment.' };
      }),
    tool('bstg.template.inspect',
      'Inspect a scan-owned native API template without exposing its raw request or values. It returns request shape, field paths, variable names and provenance for model planning.',
      { template_id: id }, ['template_id'], async (input, context) => {
        const scope = await nativeScope(context); const template = scope.templates.get(String(input.template_id));
        if (!template) throw new Error('The template is not attributable to this assessment. Search scan-owned assets first.');
        return { template: templateSummary(template), summary: 'Native template structure inspected without exposing raw request content.' };
      }),
    tool('bstg.workflow.inspect',
      'Inspect a scan-owned native Workflow, its immutable steps, HTTP method, mappings, variable configuration and assertions. The method is from a finite safe HTTP-method set and helps distinguish write operations from GET/HEAD read-back steps. In a model security experiment, use each exact steps[].step_order as a workflow_step_order reference; BSTG resolves it to the current native step. Field paths are request-data paths, never step references. It is an observation/planning tool and does not execute traffic.',
      { workflow_id: id }, ['workflow_id'], async (input, context) => ({ ...(await inspectWorkflow(context, String(input.workflow_id))), summary: 'Native Workflow inspected. Select observed fields, mappings and assertions deliberately before a fresh run.' })),
    tool('bstg.workflow.prepare',
      'Prepare a Workflow from an explicit selection of observed events in one complete current-assessment business recording using the existing recorder, learning generator and workflow publisher. event_ids are mandatory so this capability never silently turns an entire capture into a workflow. It never accepts synthetic requests or external recording IDs.',
      { recording_session_id: id, event_ids: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: id }, name: { type: 'string', minLength: 1, maxLength: 200 } }, ['recording_session_id','event_ids'],
      async (input, context) => prepareBusinessWorkflow(context, { recording_session_id: String(input.recording_session_id),
        event_ids: Array.isArray(input.event_ids) ? input.event_ids.map(String) : [], name: input.name ? String(input.name) : undefined }),
      ['publishes a Workflow through the existing recording generator']),
    tool('bstg.native.run',
      'Execute one fresh evidence-only native Test Run for a scan-owned snapshot Workflow. The stored workflow determines requests, identity and mappings; this tool cannot inject arbitrary traffic or create a vulnerability finding.',
      { workflow_id: id }, ['workflow_id'], async (input, context) => runNativeWorkflow(context, String(input.workflow_id)),
      ['creates a fresh native Test Run and private trace evidence']),
    tool('bstg.test_run.inspect',
      'Inspect a current-assessment native Test Run and its safe execution facts. Raw response bodies, request snapshots, credentials, cookies and trace content remain private.',
      { test_run_id: id }, ['test_run_id'], async (input, context) => {
        const scope = await nativeScope(context); const testRun = scope.testRuns.get(String(input.test_run_id));
        if (!testRun) throw new Error('The Test Run is not attributable to this assessment. Search scan-owned assets first.');
        const artifacts = (await context.repo.listArtifacts(context.scanRunId)).filter(artifact => artifact.source_ref === testRun.id &&
          ['agent_native_run_result', 'business_workflow_validation', 'agent_experiment_native_trace', 'agent_native_run_trace'].includes(artifact.artifact_type));
        return { test_run: testRunSummary(testRun), evidence: artifacts.map(artifact => ({ id: artifact.id, type: artifact.artifact_type,
          title: safeText(artifact.title, 200), private: artifact.content_json?.private === true })),
          summary: 'Native Test Run status and safe evidence references inspected.' };
      }),
  ];
}
