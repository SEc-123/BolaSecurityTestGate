import { MANUAL_IDENTITY_INTENT } from '../services/ai-scan/manual-identity-preparation.js';
import { dbGet } from '../db/sql-helpers.js';
import type { DbProvider } from '../types/index.js';
import { AIClient } from '../services/ai/ai-client.js';
import type { AIProvider } from '../services/ai/types.js';
import type { AutonomousAgentContext } from './context-builder.js';
import { sanitizeForAIModel } from './model-context-sanitizer.js';
import { agentEventBus } from '../observability/agent-event-bus.js';
import type { AutonomousPlannerResult } from './decision-types.js';
import { AUTONOMOUS_DECISION_SCHEMA } from './decision-types.js';
import { DISCOVERY_COMPLETED_PHASE, isDedicatedWebDiscovery, requiresAutomaticAccounts } from './discovery-task-lifecycle.js';
import { BUSINESS_PLAN_INTENT, BUSINESS_LEARNING_INTENT, BUSINESS_REVIEW_INTENT, BUSINESS_EXPERIMENT_INTENT } from './business-task-lifecycle.js';

function normalizeBool(value: any): boolean {
  return value === true || value === 1 || value === '1';
}

async function getDefaultProvider(db: DbProvider): Promise<AIProvider | null> {
  const row = await dbGet<any>(db, `SELECT * FROM ai_providers WHERE is_enabled = ? ORDER BY is_default DESC, created_at DESC LIMIT 1`, [db.kind === 'sqlite' ? 1 : true]);
  if (row) return { ...row, is_enabled: normalizeBool(row.is_enabled), is_default: normalizeBool(row.is_default) } as AIProvider;

  // Internal relay fallback: credentials remain server-side and are never persisted or returned to the browser.
  const apiKey = process.env.BUILT_IN_FORGE_API_KEY || process.env.OPENAI_API_KEY;
  const configuredBase = process.env.BUILT_IN_FORGE_API_URL || process.env.OPENAI_API_BASE;
  if (!apiKey || !configuredBase) return null;
  const base = configuredBase.replace(/\/+$/, '');
  const normalizedBase = base.endsWith('/v1') ? base : `${base}/v1`;
  return {
    id: 'internal-agent-relay',
    name: 'BSTG Internal Agent Relay',
    provider_type: 'openai_compat',
    base_url: normalizedBase,
    api_key: apiKey,
    model: process.env.BSTG_INTERNAL_AGENT_MODEL || 'gpt-5-mini',
    is_enabled: true,
    is_default: true,
  } as AIProvider;
}

function safeJsonParse(text: string): any | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return null;
}


const ALL_VULN_TYPES = [
  'file_upload',
  'file_download',
  'path_traversal',
  'bola_idor',
  'bfla',
  'business_logic',
  'xss',
  'command_injection',
  'auth_otp',
  'email_sms_bypass',
  'passcode_bypass',
  'replay_race',
  'state_machine_race',
];

function isAutopilotContext(context: AutonomousAgentContext): boolean {
  const config = context.scan?.scan_config || {};
  return config.driving_mode === 'autopilot' || config.auto_start === true || config.selected_scope_strategy === 'all_vulnerability_types';
}

function isAccountAutoExecutionContext(context: AutonomousAgentContext): boolean {
  return requiresAutomaticAccounts(context.scan?.scan_config || {});
}

function invoked(context: AutonomousAgentContext, toolName: string): boolean {
  return context.task_tool_invocations.some(inv => inv.tool_name === toolName && inv.status === 'completed');
}

/**
 * A normal-flow Workflow can be replaced by validation with an immutable
 * execution snapshot.  An inspect of an earlier Workflow therefore cannot
 * authorize validation of the current one.  Keep the deterministic hint
 * aligned with that provenance, while leaving assertion and mapping choices
 * to the model.
 */
function inspectedBusinessWorkflow(context: AutonomousAgentContext, workflowId: string): boolean {
  return context.task_tool_invocations.some(invocation => invocation.status === 'completed' &&
    invocation.tool_name === 'bstg.business.workflow.inspect' && invocation.output_json?.workflow_id === workflowId);
}

function latestInvocation(context: AutonomousAgentContext): any | undefined {
  return context.task_tool_invocations[context.task_tool_invocations.length - 1];
}

function latestCompletedToolOutput(context: AutonomousAgentContext, names: string[]): Record<string, any> | undefined {
  for (const invocation of [...context.task_tool_invocations].reverse()) {
    if (invocation.status === 'completed' && names.includes(invocation.tool_name) && invocation.output_json && typeof invocation.output_json === 'object') {
      return invocation.output_json as Record<string, any>;
    }
  }
  return undefined;
}

function persistedCaptureStatus(invocation: any): string | undefined {
  const output = invocation?.output_json;
  if (!output || typeof output !== 'object') return undefined;
  const status = output.capture_status ?? output.status ?? output.data?.capture_status ?? output.data?.status;
  return typeof status === 'string' ? status : undefined;
}

function artifactType(artifact: any): string {
  return String(artifact?.type || artifact?.artifact_type || '');
}

function artifactContent(artifact: any): Record<string, any> {
  return artifact?.content_json && typeof artifact.content_json === 'object' ? artifact.content_json : {};
}

function newestContextArtifact(artifacts: any[]): any | undefined {
  return [...artifacts].sort((left, right) => {
    const leftTime = Date.parse(String(left?.created_at || '')) || 0;
    const rightTime = Date.parse(String(right?.created_at || '')) || 0;
    return rightTime - leftTime || Number(artifactContent(right).revision || 0) - Number(artifactContent(left).revision || 0);
  })[0];
}

interface CurrentExperimentState {
  plan?: Record<string, any>;
  result?: Record<string, any>;
  assessed: boolean;
  persisted: boolean;
}

/**
 * Invocation history is a useful audit trail, but it is not authority for the
 * next experiment stage: a model may have revised the same plan after an old
 * compile/execute/assessment.  Prefer the newest append-only artifacts and
 * only use an invocation as a short-lived fallback before context refresh.
 */
function currentExperimentState(context: AutonomousAgentContext): CurrentExperimentState {
  const artifacts = Array.isArray(context.task_artifacts) ? context.task_artifacts : [];
  const plans = artifacts.filter(artifact => artifactType(artifact) === 'agent_experiment_plan' &&
    artifactContent(artifact).flow_id === context.task.execution_plan?.flow_id);
  const planArtifact = newestContextArtifact(plans);
  if (planArtifact) {
    const plan = artifactContent(planArtifact);
    const resultArtifact = newestContextArtifact(artifacts.filter(artifact => artifactType(artifact) === 'agent_experiment_result' &&
      artifactContent(artifact).plan_id === plan.id && Number(artifactContent(artifact).plan_revision) === Number(plan.revision)));
    const result = resultArtifact ? artifactContent(resultArtifact) : undefined;
    const assessed = Boolean(result && artifacts.some(artifact => artifactType(artifact) === 'agent_experiment_assessment' &&
      artifactContent(artifact).plan_id === plan.id && Number(artifactContent(artifact).plan_revision) === Number(plan.revision) &&
      Number(artifactContent(artifact).result_revision) === Number(result.revision)));
    return { plan, result, assessed, persisted: true };
  }
  const output = latestCompletedToolOutput(context, ['bstg.test_plan.create', 'bstg.test_plan.compile', 'bstg.test_plan.execute', 'bstg.test_plan.inspect']);
  if (typeof output?.plan_id !== 'string') return { assessed: false, persisted: false };
  return {
    plan: { id: output.plan_id, revision: Number(output.plan_revision || 0), status: output.status },
    result: Number.isInteger(output.result_revision) ? { plan_id: output.plan_id, plan_revision: Number(output.plan_revision || 0), revision: output.result_revision, status: output.result_status || output.status } : undefined,
    assessed: false,
    persisted: false,
  };
}

function inspectedCurrentExperiment(context: AutonomousAgentContext, state: CurrentExperimentState): boolean {
  const plan = state.plan, result = state.result;
  if (!plan || !result) return false;
  return context.task_tool_invocations.some(invocation => invocation.status === 'completed' && invocation.tool_name === 'bstg.test_plan.inspect' &&
    invocation.output_json?.plan_id === plan.id && Number(invocation.output_json?.plan_revision) === Number(plan.revision) &&
    Number(invocation.output_json?.result_revision) === Number(result.revision));
}

function hasSavedBusinessCoverage(context: AutonomousAgentContext): boolean {
  return (context.task_artifacts || []).some(artifact => artifactType(artifact) === 'business_flow_coverage' &&
    artifactContent(artifact).plan_task_id === context.task.id);
}

function endpointId(context: AutonomousAgentContext, vulnType = ''): string | undefined {
  const plannedTarget = context.task.execution_plan?.workflow_execution_plan?.target_endpoint_id;
  if (plannedTarget) return String(plannedTarget);
  const relevant = context.relevant_endpoints || [];
  const find = (re: RegExp, method?: string) => relevant.find(endpoint => re.test(String(endpoint.path || endpoint.url || '')) && (!method || String(endpoint.method).toUpperCase() === method));
  if (vulnType === 'business_logic') return (find(/cart|quantity/i, 'GET') || find(/cart|quantity|order|amount|payment|withdraw|transfer/i))?.id || relevant[relevant.length - 1]?.id;
  if (vulnType === 'bfla') return (find(/admin\/users|admin|manage|role/i) || relevant[relevant.length - 1])?.id;
  if (vulnType === 'bola_idor') return (find(/order|historyorders|withdraw|transfer|wallet|user/i) || relevant[relevant.length - 1])?.id;
  const ids = Array.isArray(context.task.endpoint_ids) ? context.task.endpoint_ids : [];
  return ids[ids.length - 1] || relevant[relevant.length - 1]?.id || context.endpoint_inventory_summary.sample?.[0]?.id;
}

function normalizeDecision(input: any): AutonomousPlannerResult | null {
  if (!input || typeof input !== 'object') return null;
  const action = String(input.action || '').trim();
  if (!['tool_call', 'complete_task', 'fail_task', 'wait_for_user_selection', 'create_child_tasks'].includes(action)) return null;
  const decision: AutonomousPlannerResult = {
    action: action as any,
    tool_name: input.tool_name ? String(input.tool_name) : undefined,
    arguments: input.arguments && typeof input.arguments === 'object' ? input.arguments : {},
    tasks: Array.isArray(input.tasks) ? input.tasks : undefined,
    summary: input.summary ? String(input.summary) : undefined,
    reason: input.reason ? String(input.reason) : undefined,
    rationale: input.rationale ? String(input.rationale) : undefined,
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : undefined,
    stop_after_tool_call: Boolean(input.stop_after_tool_call),
  };
  if (decision.action === 'tool_call' && !decision.tool_name) return null;
  return decision;
}

function isAndroidContext(context: AutonomousAgentContext): boolean {
  const config = context.scan?.scan_config || {};
  return config.surface === 'android' || config.surface_type === 'android' || config.mobile?.platform === 'android' || config.android?.platform === 'android';
}

function shouldCompleteAfterLastTool(context: AutonomousAgentContext): boolean {
  const last = latestInvocation(context);
  if (!last || last.status !== 'completed') return false;
  return [
    'bstg.capabilities.inventory',
    'browser.discover_target',
    'vuln.generate_candidates',
    'agent.shared_context.prepare',
    'task.expand_selected_vulnerabilities',
    'task.summarize_vulnerability_campaign',
    'bstg.file_upload.run_test',
    'bstg.generic_vuln.run_test',
    'bstg.identity.bootstrap_accounts',
    'mobile.lab.stop',
  ].includes(last.tool_name);
}

export function localPolicy(context: AutonomousAgentContext): AutonomousPlannerResult {
  const taskType = String(context.task.task_type || '');
  const hasExplicitVulnType = Boolean(context.task.vuln_type || context.task.execution_plan?.vuln_type);
  const vulnType = String(context.task.vuln_type || context.task.execution_plan?.vuln_type || '');
  const selected = Array.isArray(context.selected_vuln_types) ? context.selected_vuln_types : [];
  const selectedForPolicy = selected.length > 0 ? selected : (isAutopilotContext(context) ? ALL_VULN_TYPES : []);
  const last = latestInvocation(context);
  const businessIntent = context.task.execution_plan?.intent;
  const businessFlows = context.business_flows || [];
  if (businessIntent === BUSINESS_PLAN_INTENT) {
    if (!invoked(context, 'browser.navigate')) return {action: 'tool_call', tool_name: 'browser.navigate', arguments: {url: context.scan.base_url},
      rationale: 'Observe the actual site before defining business goals.', source: 'local_policy'};
    if (!invoked(context, 'bstg.business.coverage.inspect')) return {action: 'tool_call', tool_name: 'bstg.business.coverage.inspect', arguments: {},
      rationale: 'Read every currently discovered operable feature and endpoint operation before deciding which normal flows to plan or defer.', source: 'local_policy'};
    if (hasSavedBusinessCoverage(context)) return {action: 'complete_task', summary: 'The model saved a coverage decision for the discovered business inventory; schedule only its planned normal flows.', source: 'local_policy'};
    if (businessFlows.length) return {action: 'tool_call', tool_name: 'bstg.business.coverage.inspect', arguments: {},
      rationale: 'Flows alone do not release learning. Refresh the current inventory and save the model coverage list that maps every feature/operation to a planned flow or a concrete deferred/blocked reason.', source: 'local_policy'};
    return {action: 'tool_call', tool_name: 'bstg.business.flow.define', arguments: {
      name: context.feature_tree[0]?.name || 'Observed normal business',
      goal: context.feature_tree[0]?.description || context.scan.user_prompt || 'Complete an observed normal function and verify its resulting business state.',
      role: 'anonymous', ...(context.feature_tree[0]?.id ? {feature_id:context.feature_tree[0].id,feature_name:context.feature_tree[0]?.name} : {})}, rationale: 'Define a goal grounded in current observations; the model should choose the actual business names, roles and prerequisites.', source: 'local_policy'};
  }
  if (businessIntent === BUSINESS_LEARNING_INTENT) {
    const flow = businessFlows.find(item => item.id === context.task.execution_plan?.flow_id);
    if (!flow) return {action: 'fail_task', reason: 'The normal business task has no defined flow in this assessment.', source: 'local_policy'};
    if (flow.status === 'verified' && flow.assertions_verified === true && flow.normal_run_id) return {action: 'complete_task', summary: 'The normal business goal has native execution and verified assertions.', source: 'local_policy'};
    if (flow.workflow_id) {
      if (!inspectedBusinessWorkflow(context, flow.workflow_id)) {
        return {action: 'tool_call', tool_name: 'bstg.business.workflow.inspect', arguments: {workflow_id: flow.workflow_id},
          rationale: 'Inspect the current observed Workflow, fields, and dependency candidates before choosing semantic assertions and normal validation.', source: 'local_policy'};
      }
      // This is guidance sent to the real provider, not a runnable fallback:
      // validation requires model-selected semantic assertions.  Supplying
      // fixed assertions here would turn the normal business proof into a
      // rules-only flow and could incorrectly validate a different outcome.
      return {action: 'tool_call', tool_name: 'bstg.business.workflow.validate', arguments: {workflow_id: flow.workflow_id},
        rationale: 'The current Workflow has been inspected. Select the observed business assertions, justified mapping IDs, and session propagation, then validate a fresh native normal run.', source: 'local_policy'};
    }
    if (flow.recording_session_id && last?.tool_name === 'bstg.business.capture.stop' && persistedCaptureStatus(last) === 'stopped') {
      return {action: 'tool_call', tool_name: 'bstg.business.workflow.prepare', arguments: {recording_session_id: flow.recording_session_id},
        rationale: 'Reuse the existing recording generator for this completed normal browser flow.', source: 'local_policy'};
    }
    if (flow.recording_session_id) return {action: 'tool_call', tool_name: 'bstg.business.capture.inspect', arguments: {recording_session_id: flow.recording_session_id},
      rationale: 'Review actual normal-flow actions and outcomes; choose further browser operations or stop only after the intended normal flow.', source: 'local_policy'};
    return {action: 'tool_call', tool_name: 'bstg.business.capture.start', arguments: {flow_id: flow.id, identity_key: flow.role},
      rationale: 'Record the normal business flow before its first action.', source: 'local_policy'};
  }
  if (businessIntent === BUSINESS_REVIEW_INTENT) {
    const unresolved = businessFlows.filter(flow => flow.status !== 'verified' || flow.assertions_verified !== true || !flow.normal_run_id);
    if (businessFlows.length) return {action: 'complete_task', summary: unresolved.length
      ? `${businessFlows.length - unresolved.length} normal flows are verified; ${unresolved.length} blocked/failed flows remain recorded as independent repair work.`
      : 'Defined normal business flows have verified native results.', source: 'local_policy'};
  }
  if (businessIntent === BUSINESS_EXPERIMENT_INTENT) {
    const flow = businessFlows.find(item => item.id === context.task.execution_plan?.flow_id);
    if (!flow || flow.status !== 'verified' || flow.assertions_verified !== true || !flow.normal_run_id || !flow.workflow_id) {
      return { action: 'fail_task', reason: 'A model experiment may run only for its persisted native-verified normal flow.', source: 'local_policy' };
    }
    if (!invoked(context, 'bstg.business.flow.inspect')) {
      return { action: 'tool_call', tool_name: 'bstg.business.flow.inspect', arguments: { flow_id: flow.id },
        rationale: 'Read the verified normal goal and evidence before selecting a concrete experiment.', source: 'local_policy' };
    }
    if (!invoked(context, 'bstg.workflow.inspect')) {
      return { action: 'tool_call', tool_name: 'bstg.workflow.inspect', arguments: { workflow_id: flow.workflow_id },
        rationale: 'Inspect native step and field structure; the model must choose its own exact fields and mutations.', source: 'local_policy' };
    }
    const experiment = currentExperimentState(context);
    const plan = experiment.plan;
    if (!plan?.id || !Number.isInteger(Number(plan.revision))) {
      return { action: 'tool_call', tool_name: 'bstg.test_plan.create', arguments: { flow_id: flow.id },
        rationale: 'Create a model-authored plan using observed steps, explicit changes, dynamic bindings and semantic control/impact assertions.', source: 'local_policy' };
    }
    if (plan.status !== 'compiled') {
      return { action: 'tool_call', tool_name: 'bstg.test_plan.compile', arguments: { plan_id: plan.id },
        rationale: 'Compile the exact model plan to immutable native control and experiment workflows.', source: 'local_policy' };
    }
    if (!experiment.result || experiment.result.status !== 'executed') {
      return { action: 'tool_call', tool_name: 'bstg.test_plan.execute', arguments: { plan_id: plan.id },
        rationale: 'Run fresh native control and model experiment Test Runs.', source: 'local_policy' };
    }
    if (!inspectedCurrentExperiment(context, experiment)) {
      return { action: 'tool_call', tool_name: 'bstg.test_plan.inspect', arguments: { plan_id: plan.id },
        rationale: 'Inspect safe execution facts before judging or revising the model plan.', source: 'local_policy' };
    }
    if (!experiment.assessed) {
      return { action: 'tool_call', tool_name: 'bstg.test_plan.assess', arguments: { plan_id: plan.id },
        rationale: 'Record a model assessment grounded in the current native result; revise the plan if its evidence gaps require another experiment.', source: 'local_policy' };
    }
    return { action: 'complete_task', summary: 'The model has completed a native control/experiment loop and recorded its evidence-gated assessment.', source: 'local_policy' };
  }
  const isModelingTask = context.task.execution_plan?.intent === 'model_features_and_candidates' || /candidate|feature|漏洞候选|功能树/i.test(taskType + ' ' + context.task.title);
  if (shouldCompleteAfterLastTool(context)) {
    if (last?.tool_name === 'vuln.generate_candidates' && isModelingTask && !invoked(context, 'agent.shared_context.prepare')) {
      // Continue to shared context preparation before waiting/completing.
    } else if (last?.tool_name === 'agent.shared_context.prepare' && isModelingTask && selectedForPolicy.length > 0 && !invoked(context, 'task.expand_selected_vulnerabilities')) {
      // Continue to selected vulnerability expansion when scan creation already included selected_vuln_types.
    } else if (last?.tool_name === 'browser.discover_target' && context.task.execution_plan?.intent === 'discover_target' && isAccountAutoExecutionContext(context) && !invoked(context, 'bstg.identity.bootstrap_accounts')) {
      // Default account mode must attempt a real register/login bootstrap before discovery is considered complete.
    } else if (last?.tool_name === 'bstg.capabilities.inventory' && context.task.execution_plan?.intent !== 'inventory_bstg_capabilities') {
      // Capability inventory is a reusable background capability; executable sub-agents must still run their actual test tool.
    } else {
    if ((taskType === 'generate_candidates' || context.task.execution_plan?.intent === 'model_features_and_candidates') && selected.length === 0 && context.vulnerability_candidates.length > 0 && invoked(context, 'agent.shared_context.prepare') && !invoked(context, 'task.expand_selected_vulnerabilities')) {
      return { action: 'wait_for_user_selection', summary: 'Feature tree and vulnerability candidates are ready; waiting for selected vulnerability types.', source: 'local_policy' };
    }
    return { action: 'complete_task', summary: last?.output_summary || `${last?.tool_name || 'tool'} completed.`, source: 'local_policy' };
    }
  }

  if ((context.task.execution_plan?.intent === 'inventory_bstg_capabilities' || /inventory|capabilit/i.test(taskType + ' ' + context.task.title)) && !invoked(context, 'bstg.capabilities.inventory')) {
    return { action: 'tool_call', tool_name: 'bstg.capabilities.inventory', arguments: {}, rationale: 'First load native BSTG capabilities as controllable Agent tools.', source: 'local_policy' };
  }
  if ((context.task.execution_plan?.intent === 'discover_target') || (/discover|understand|目标|发现/i.test(taskType + ' ' + context.task.title) && !/candidate|feature|漏洞候选|功能树/i.test(taskType + ' ' + context.task.title))) {
    if (isAndroidContext(context)) {
      const mobileCfg = context.scan.scan_config?.mobile || context.scan.scan_config?.android || {};
      if (!invoked(context, 'mobile.lab.prepare')) {
        return { action: 'tool_call', tool_name: 'mobile.lab.prepare', arguments: { profile_id: mobileCfg.lab_profile_id, app_package: mobileCfg.app_package, app_activity: mobileCfg.app_activity, apk_path: mobileCfg.apk_path }, rationale: 'Prepare Android Mobile Lab with preconfigured Burp/proxy/certificate health gate before App automation.', source: 'local_policy' };
      }
      if (!invoked(context, 'mobile.app.install')) {
        return { action: 'tool_call', tool_name: 'mobile.app.install', arguments: { apk_path: mobileCfg.apk_path }, rationale: 'Install authorized APK when supplied, otherwise verify preinstalled App path.', source: 'local_policy' };
      }
      if (mobileCfg.acquisition_mode !== 'explore' && !invoked(context, 'mobile.app.launch')) {
        return { action: 'tool_call', tool_name: 'mobile.app.launch', arguments: { app_package: mobileCfg.app_package, app_activity: mobileCfg.app_activity }, rationale: 'Launch the Android App for UIAutomator/Appium-style observation.', source: 'local_policy' };
      }
      if (mobileCfg.acquisition_mode !== 'explore' && !invoked(context, 'mobile.observe')) {
        return { action: 'tool_call', tool_name: 'mobile.observe', arguments: {}, rationale: 'Capture Android screenshot and UIAutomator hierarchy for the right-side App panel.', source: 'local_policy' };
      }
      const acquisitionTool = mobileCfg.acquisition_mode === 'explore' ? 'mobile.app.explore' : 'mobile.flow.run';
      if (!invoked(context, acquisitionTool)) {
        return { action: 'tool_call', tool_name: acquisitionTool, arguments: mobileCfg.acquisition_mode==='explore'?{}:{ steps: mobileCfg.flow_steps || [] }, rationale: 'Run deterministic Android App flow to create authenticated state and business objects before importing traffic.', source: 'local_policy' };
      }
      if (!invoked(context, 'mobile.capture.import')) {
        return { action: 'tool_call', tool_name: 'mobile.capture.import', arguments: { export_path: mobileCfg.burp_flow_export_path, regenerate: true }, rationale: 'Import decrypted Burp mobile flows into BSTG recording, API templates and workflow drafts.', source: 'local_policy' };
      }
      if (!invoked(context, 'mobile.lab.stop')) return { action: 'tool_call', tool_name: 'mobile.lab.stop', arguments: {}, rationale: 'Release owned Android/proxy resources after persisting the capture.', source: 'local_policy' };
      return { action: 'complete_task', summary: 'Android App discovery flow completed; mobile capture has been imported for feature and vulnerability modeling.', source: 'local_policy' };
    }
    if (!invoked(context, 'browser.navigate')) {
      return { action: 'tool_call', tool_name: 'browser.navigate', arguments: { url: context.scan.base_url, timeout_ms: context.scan.scan_config?.timeout_ms || 45000 }, rationale: 'Navigate target and capture browser state before endpoint discovery.', source: 'local_policy' };
    }
    if (!invoked(context, 'browser.discover_target')) {
      return { action: 'tool_call', tool_name: 'browser.discover_target', arguments: { max_pages: context.scan.scan_config?.max_pages || 1000 }, rationale: 'Discover endpoints, forms, upload controls, and page observations.', source: 'local_policy' };
    }
    if (isAccountAutoExecutionContext(context) && !invoked(context, 'bstg.identity.bootstrap_accounts')) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.identity.bootstrap_accounts',
        arguments: {
          roles: context.scan.scan_config?.auto_account_roles || ['attacker', 'victim', 'admin'],
          max_pages: context.scan.scan_config?.account_bootstrap_max_pages || 40,
          form_values: context.scan.scan_config?.auto_account_form_values || {},
        },
        rationale: 'Default account mode requires a real registration/login bootstrap before downstream authenticated testing.',
        source: 'local_policy',
      };
    }
  }
  if (context.task.execution_plan?.intent === 'expand_selected_vulnerabilities') {
    const selectedForExpansion = Array.isArray(context.task.execution_plan?.selected_vuln_types) && context.task.execution_plan.selected_vuln_types.length ? context.task.execution_plan.selected_vuln_types : selected;
    if (!invoked(context, 'task.expand_selected_vulnerabilities')) return { action: 'tool_call', tool_name: 'task.expand_selected_vulnerabilities', arguments: { selected_vuln_types: selectedForExpansion }, rationale: 'Expand selected vulnerability types into persistent executable tasks.', source: 'local_policy' };
    return { action: 'complete_task', summary: `Expanded selected vulnerability types: ${selectedForExpansion.join(', ')}`, source: 'local_policy' };
  }

  if (isModelingTask) {
    if (!invoked(context, 'feature.extract_tree')) return { action: 'tool_call', tool_name: 'feature.extract_tree', arguments: {}, rationale: 'Build feature/sub-feature tree before vulnerability inference.', source: 'local_policy' };
    if (!invoked(context, 'vuln.generate_candidates')) return { action: 'tool_call', tool_name: 'vuln.generate_candidates', arguments: {}, rationale: 'Generate vulnerability candidates from feature and endpoint model.', source: 'local_policy' };
    if (!invoked(context, 'agent.shared_context.prepare')) return { action: 'tool_call', tool_name: 'agent.shared_context.prepare', arguments: { selected_vuln_types: selectedForPolicy }, rationale: 'Prepare reusable cross-agent shared context before selection/expansion.', source: 'local_policy' };
    if (selectedForPolicy.length > 0 && !invoked(context, 'task.expand_selected_vulnerabilities')) return { action: 'tool_call', tool_name: 'task.expand_selected_vulnerabilities', arguments: { selected_vuln_types: selectedForPolicy }, rationale: 'Selected vulnerability categories exist; expand them into persistent executable tasks.', source: 'local_policy' };
    return { action: 'wait_for_user_selection', summary: 'Candidates generated; waiting for user-selected vulnerability categories.', source: 'local_policy' };
  }
  if (context.task.execution_plan?.intent === 'summarize_vulnerability_campaign' || taskType === 'summarize_vulnerability_campaign') {
    const summaryVulnType = vulnType || 'generic';
    if (!invoked(context, 'task.summarize_vulnerability_campaign')) return { action: 'tool_call', tool_name: 'task.summarize_vulnerability_campaign', arguments: { campaign_task_id: context.task.execution_plan?.campaign_task_id, child_task_ids: context.task.execution_plan?.child_task_ids || [], vuln_type: summaryVulnType }, rationale: 'All child sub-agent tasks for this vulnerability campaign have completed; summarize campaign evidence and residual gaps.', source: 'local_policy' };
    return { action: 'complete_task', summary: `${summaryVulnType} campaign summarized.`, source: 'local_policy' };
  }
  if (taskType === 'test_file_upload' || vulnType === 'file_upload') {
    return { action: 'tool_call', tool_name: 'bstg.file_upload.run_test', arguments: { endpoint_id: endpointId(context, vulnType), endpoint_ids: context.task.endpoint_ids || [] }, rationale: 'File upload requires normal upload, mutation upload, post-upload access, and native workflow/API evidence.', source: 'local_policy' };
  }
  if (taskType.startsWith('test_') || hasExplicitVulnType) {
    const simpleApiTypes = new Set(['xss', 'command_injection', 'file_download', 'path_traversal']);
    if (simpleApiTypes.has(vulnType) && !invoked(context, 'bstg.api_test.run')) {
      return { action: 'tool_call', tool_name: 'bstg.api_test.run', arguments: { endpoint_id: endpointId(context, vulnType), vuln_type: vulnType }, rationale: 'This vulnerability is single-interface suitable; execute native API test-run mode first.', source: 'local_policy' };
    }
    return { action: 'tool_call', tool_name: 'bstg.generic_vuln.run_test', arguments: { endpoint_id: endpointId(context, vulnType), endpoint_ids: context.task.endpoint_ids || [] }, rationale: 'Run native BSTG vulnerability task with workflow/API evidence and finding gate.', source: 'local_policy' };
  }
  return { action: 'complete_task', summary: 'No additional action needed for this task.', source: 'local_policy' };
}

export class AutonomousAgentPlanner {
  constructor(private readonly db: DbProvider) {}

  async decide(context: AutonomousAgentContext): Promise<AutonomousPlannerResult> {
    // Login preparation is a lifecycle requirement and cannot be skipped by a provider decision.
    if (context.task.execution_plan?.intent === MANUAL_IDENTITY_INTENT) {
      if (!invoked(context, 'bstg.identity.bootstrap_accounts')) return { action: 'tool_call', tool_name: 'bstg.identity.bootstrap_accounts', arguments: {}, source: 'local_policy', rationale: 'Prepare saved manual identities before authenticated tests.' };
      return { action: 'complete_task', source: 'local_policy', summary: '账号登录准备已记录；测试按各角色的实际会话和阻断结果执行。' };
    }
    if (context.task.execution_plan?.intent === 'expand_selected_vulnerabilities' && context.task.execution_plan?.identity_preparation_task_id) {
      if (!invoked(context, 'task.expand_selected_vulnerabilities')) return { action: 'tool_call', tool_name: 'task.expand_selected_vulnerabilities', arguments: {selected_vuln_types: context.task.execution_plan.selected_vuln_types || context.selected_vuln_types}, source: 'local_policy', rationale: 'Build deferred workflows using the persisted identity preparation result.' };
      return { action: 'complete_task', source: 'local_policy', summary: '已按实际账号准备结果生成测试计划。' };
    }
    const config = context.scan.scan_config || {};
    if (isDedicatedWebDiscovery(context.task, config) && requiresAutomaticAccounts(config) &&
        context.task.phase === DISCOVERY_COMPLETED_PHASE) {
      // This persisted phase follows the successful discovery invocation. A prior
      // bootstrap cannot satisfy it, and model continuation cannot skip it.
      return { action: 'tool_call', tool_name: 'bstg.identity.bootstrap_accounts', arguments: {
        roles: config.auto_account_roles || ['attacker', 'victim', 'admin'],
        max_pages: config.account_bootstrap_max_pages || 40,
        form_values: config.auto_account_form_values || {},
      }, source: 'local_policy', rationale: 'Complete configured account preparation after discovery before releasing dependent tasks.' };
    }
    const policyDecision = localPolicy(context);
    // The mobile acquisition contract is deterministic. An LLM may not skip
    // install/launch/assertions/capture/cleanup or pronounce this phase complete.
    const mobileDiscovery = isAndroidContext(context) && (context.task.execution_plan?.intent === 'discover_target' || (/discover|understand|目标|发现/i.test(context.task.task_type + ' ' + context.task.title) && !/candidate|feature|漏洞候选|功能树/i.test(context.task.task_type + ' ' + context.task.title)));
    if (mobileDiscovery) return policyDecision;
    // Imported App traffic is tested by the native security executor. Once a
    // mobile test has produced its evidence, a later model decision must not
    // restart the stopped capture session or switch to an incompatible
    // acquisition mode. The executor itself still uses the configured model
    // for vulnerability judgement.
    if (isAndroidContext(context) &&
        (String(context.task.task_type || '').startsWith('test_') ||
          context.task.execution_plan?.intent === 'model_features_and_candidates' ||
          /candidate|feature|漏洞候选|功能树/i.test(String(context.task.task_type || '') + ' ' + String(context.task.title || '')))) return policyDecision;
    let provider: AIProvider | null = null;
    let providerError: unknown = null;
    try { provider = await getDefaultProvider(this.db); } catch (error) { providerError = error; }
    if (!provider) {
      const reason=providerError instanceof Error?providerError.message:'未配置可用的模型服务。请在模型设置中启用并验证连接，再重新测试。';
      agentEventBus.publish({ kind: 'agent_state_changed', status: 'blocked', scan_run_id: context.task.scan_run_id, task_id: context.task.id, error:reason,summary:'模型服务不可用，本轮停止执行。' });
      throw new Error(reason);
    }
    agentEventBus.publish({ kind: 'agent_state_changed', status: 'info', scan_run_id: context.task.scan_run_id, task_id: context.task.id, provider_id: provider.id, model: provider.model, summary: `Agent 已选择真实 provider：${provider.id}` });

    const client = new AIClient(provider);
    const system = [
      'You are the BSTG discovery-first autonomous security testing planner.',
      'Goal: maximize useful vulnerability discovery on the operator-declared target using BSTG tools and evidence artifacts.',
      'First discover and verify the normal business flows, then base further testing on actual evidence. Incomplete evidence cannot confirm a risk; record the gap, inspect the failed outcome and iterate.',
      'Business planning, normal browser recording, native workflow validation and review are explicit task stages. In plan_business_flows, call bstg.business.coverage.inspect and save a model-owned coverage list with bstg.business.coverage.save: every discovered operable feature and endpoint operation must be planned through a saved flow or explicitly deferred/blocked with a concrete reason. A nonempty flow list is not coverage. Do not skip these stages or declare a normal business goal verified without a persisted native Test Run and passing semantic assertions.',
      'Choose observed business operations, parameter mappings and result assertions yourself; deterministic tool suggestions are guidance rather than substitutes for reasoning about the actual site.',
      'For a model_business_experiment task, you must inspect the verified flow and native Workflow, then use bstg.test_plan.create, bstg.test_plan.compile, bstg.test_plan.execute, bstg.test_plan.inspect, and bstg.test_plan.assess in that order. You decide the exact selected steps, patches, bindings, identities, repeats/concurrency and semantic control/impact assertions from observed structure. Do not copy raw request values into a plan. A native counterexample or rejected mutation is valid evidence; revise when needed and never call an unproven hypothesis a vulnerability.',
      'Prefer actions that expand reachable routes, authenticated states, object IDs, workflows, and mutation opportunities.',
      'Plan within context.task.decision_budget; its remaining allowance includes this decision. Reserve a decision to complete, hand off, or explicitly fail the task instead of exploring until the allowance is exhausted.',
      'Return strict JSON only.',
    ].join('\n');
    const userPayload = sanitizeForAIModel({
      context,
      deterministic_next_step: policyDecision,
      required_output: {
        action: 'tool_call | complete_task | fail_task | wait_for_user_selection | create_child_tasks',
        tool_name: 'required only for tool_call',
        arguments: 'object; match selected tool input_schema',
        rationale: 'why this increases vulnerability discovery or closes replay gaps',
      },
    });
    const telemetry = agentEventBus.beginLLM({
      scan_run_id: context.task.scan_run_id,
      task_id: context.task.id,
      provider_id: provider.id,
      model: provider.model,
      request: { model: provider.model, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(userPayload) }] },
      message_count: 2,
    });
    try {
      const response = await client.chat({
        model: provider.model,
        temperature: 0.1,
        max_tokens: 1800,
        ...(provider.id === 'internal-agent-relay' ? {} : { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(userPayload) },
        ],
      }, { scan_run_id: context.task.scan_run_id, task_id: context.task.id, emit_events: false });
      telemetry.succeed(response);
      const content = response.choices?.[0]?.message?.content || '';
      const parsed = safeJsonParse(content);
      const normalized = normalizeDecision(parsed);
      if (!normalized) throw new Error(`AI provider returned invalid decision JSON: ${content.slice(0, 400)}`);
      return { ...normalized, source: 'ai_provider', raw_response: parsed, provider_id: provider.id, model: response.model, provider_response_id:response.id, ai_provider_attempted:true, ai_usage:response.usage, policy_decision: policyDecision, validation_status: 'accepted' };
    } catch (error: any) {
      telemetry.fail(error);
      agentEventBus.publish({ kind: 'agent_state_changed', status: 'failed', scan_run_id: context.task.scan_run_id, task_id: context.task.id, provider_id: provider.id, model: provider.model, error: error.message || String(error), summary: '模型决策失败，本轮停止执行。请检查服务权限或连接后重试。' });
      throw new Error(`模型服务未完成本次请求：${error.message || String(error)}`);
    }
  }
}
