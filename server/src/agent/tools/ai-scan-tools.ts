import { discoverWebPages } from '../../services/ai-scan/browser/web-discovery.js';
import { hydrateRequests, capturedParameters } from '../../services/ai-scan/captured-request.js';
import { interactPersistentBrowser } from '../../services/ai-scan/browser/persistent-browser-runtime.js';
import type { AgentToolSpec } from '../tool-types.js';
import { dbAll } from '../../db/sql-helpers.js';
import { discoverTargetFromHttp } from '../../services/ai-scan/browser-discovery.js';
import { rebuildFeatureTree, rebuildVulnerabilityCandidates, shouldMapCandidateToSelected } from '../../services/ai-scan/feature-vuln-engine.js';
import { runFileUploadTask } from '../../services/ai-scan/file-upload-runner.js';
import { runGenericVulnerabilityTask } from '../../services/ai-scan/generic-vuln-runner.js';
import { enhanceFeatureAndVulnModelWithAI } from '../../services/ai-scan/ai-planner.js';
import { navigateWithOptionalBrowser } from '../../services/ai-scan/browser/browser-session-service.js';
import type { AIDiscoveredEndpoint, AIScanTask } from '../../services/ai-scan/types.js';
import { buildWorkflowEndpointContext, buildWorkflowExecutionPlan } from '../../services/ai-scan/workflow-context.js';
import { getBstgCapabilityInventory } from '../../services/ai-scan/bstg-capability-map.js';
import { generateAndApplyExecutionLearning } from '../../services/ai-scan/bstg-learning-automation.js';
import { getTraceByRunId } from '../../services/debug-trace.js';
import { payloadsForVulnType } from '../../services/ai-scan/payload-catalog.js';
import { runNativeApiTestRun } from '../../services/ai-scan/bstg-native-orchestrator.js';
import { getSharedLoginEndpointIds, markSharedResourcesUsed, prepareSharedAgentResources } from '../../services/ai-scan/shared-resource-manager.js';
import { bootstrapAutoAccounts } from '../../services/ai-scan/account-autobootstrap.js';
import { rememberAgentObservation, retrieveRelevantAgentMemories } from '../../services/ai-scan/agent-memory.js';
import { closePersistentBrowserContext } from '../../services/ai-scan/browser/persistent-browser-runtime.js';
import { resolveTaskEndpointPlan } from '../../services/ai-scan/task-endpoint-plan.js';

function defaultMaxTasksForVulnType(vulnType: string): number {
  if (vulnType === 'business_logic') return 18;
  if (['auth_otp', 'email_sms_bypass', 'passcode_bypass', 'replay_race', 'state_machine_race'].includes(vulnType)) return 10;
  if (['bola_idor', 'bfla'].includes(vulnType)) return 8;
  return 6;
}

function maxTasksPerFunctionBucket(vulnType: string): number {
  if (vulnType === 'business_logic') return 2;
  if (['auth_otp', 'email_sms_bypass', 'passcode_bypass'].includes(vulnType)) return 2;
  return 3;
}

function normalizeBucket(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\?.*$/, '')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/[a-f0-9-]{12,}/g, ':id')
    .replace(/\s+/g, ' ')
    .trim();
}

function businessLogicDomain(text: string): string {
  const value = String(text || '').toLowerCase();
  if (/admin|manage|role|permission|后台|管理|权限/.test(value)) return 'admin_privileged';
  if (/withdraw|提现/.test(value)) return 'withdrawal';
  if (/transfer|funds|资金|转账/.test(value)) return 'transfer';
  if (/wallet|balance|address|钱包|余额|地址/.test(value)) return 'wallet';
  if (/refund|退款/.test(value)) return 'refund';
  if (/cancel|cancelorder|cancelentrust|bulkcancellation|撤单|取消/.test(value)) return 'cancellation';
  if (/payment|\bpay\b|支付/.test(value)) return 'payment';
  if (/cart|quantity|amount|price|购物车|数量|金额/.test(value)) return 'amount_quantity';
  if (/order|entrust|commission|exchange|contract|option|otc|订单|委托|交易/.test(value)) return 'order_exchange';
  if (/login|register|send.*code|verify.*code|sms|email|mail|otp|captcha|password|passcode|paypwd|验证码|短信|邮箱|登录|注册|密码/.test(value)) return 'auth_only';
  return 'other';
}

function isBusinessLogicPrimaryDomain(domain: string): boolean {
  return domain !== 'auth_only' && domain !== 'other';
}

export function buildAIScanToolSpecs(): AgentToolSpec[] {
  return [

    {
      name: 'bstg.capabilities.inventory',
      description: 'Inventories native BSTG capabilities and explains how the Agent can drive them: templates, workflows, variables, mappings, extractors, session jar, learning, security rules, checklists, account binding, mutation profiles and evidence gates.',
      input_schema: { type: 'object', properties: {} },
      side_effects: ['creates bstg_capability_inventory artifact'],
      handler: async (_input, context) => {
        const inventory = await getBstgCapabilityInventory(context.db);
        await context.repo.createArtifact({
          scan_run_id: context.scanRunId,
          task_id: context.taskId,
          artifact_type: 'bstg_capability_inventory',
          title: 'BSTG native capability inventory for AI Agent driving layer',
          content_json: inventory as unknown as Record<string, any>,
        });
        return { ok: true, data: inventory as unknown as Record<string, any>, summary: `Inventoried ${inventory.capabilities.length} native BSTG capability groups for Agent control.` };
      },
    },

    {
      name: 'agent.shared_context.prepare',
      description: 'Builds and refreshes scan-wide shared resources that all parent/sub-agents can reuse: attacker/victim/admin identity pool, canonical login/session workflow blueprint, session strategy, object inventory, payload plans and feature attack contexts. This prevents every sub-agent from rediscovering the same accounts/login ABCDE flow/payloads/object IDs.',
      input_schema: { type: 'object', properties: { selected_vuln_types: { type: 'array', items: { type: 'string' } } } },
      side_effects: ['upserts ai_scan_shared_resources', 'creates agent_shared_context_inventory artifact'],
      handler: async (input, context) => {
        const selected = Array.isArray(input.selected_vuln_types) ? input.selected_vuln_types.map(String) : [];
        const result = await prepareSharedAgentResources({ db: context.db, repo: context.repo, scanRunId: context.scanRunId, taskId: context.taskId, selectedVulnTypes: selected });
        return { ok: true, data: { summary: result.summary, resources_count: result.resources.length, resources: result.resources.map(resource => ({ id: resource.id, type: resource.resource_type, key: resource.resource_key, title: resource.title, usage_count: resource.usage_count })) }, summary: `Prepared ${result.resources.length} reusable cross-agent shared resources.` };
      },
    },
    {
      name: 'agent.memory.query',
      description: 'Retrieves task-relevant structured Agent memories using scope, confidence, TTL, provenance and lexical relevance. Secret-reference memories return only safe summaries/references.',
      input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 50 }, identity_key: { type: 'string' } } },
      side_effects: ['increments memory usage counters'],
      handler: async (input, context) => {
        const task = context.taskId ? await context.repo.getTask(context.taskId) : null;
        const memories = await retrieveRelevantAgentMemories({ repo: context.repo, scanRunId: context.scanRunId, task: task || undefined, query: String(input.query || ''), identityKey: input.identity_key ? String(input.identity_key) : undefined, limit: Number(input.limit || 20) });
        return { ok: true, data: { memories, count: memories.length }, summary: `Retrieved ${memories.length} relevant Agent memories.` };
      },
    },
    {
      name: 'agent.memory.remember',
      description: 'Stores a sanitized structured observation in Agent Memory with scope, confidence, TTL, dependencies and provenance. Secret-like values are redacted before persistence and model reuse.',
      input_schema: {
        type: 'object',
        required: ['memory_type', 'memory_key', 'summary'],
        properties: {
          memory_type: { type: 'string', minLength: 1, maxLength: 120 },
          memory_key: { type: 'string', minLength: 1, maxLength: 240 },
          scope_type: { type: 'string', enum: ['scan', 'task', 'identity', 'feature', 'endpoint'] },
          scope_ref: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string', minLength: 1, maxLength: 4000 },
          content: { type: 'object' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          ttl_seconds: { type: 'number', minimum: 60, maximum: 604800 },
          depends_on: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        },
      },
      side_effects: ['upserts ai_agent_memories'],
      handler: async (input, context) => {
        const memory = await rememberAgentObservation({ repo: context.repo, scanRunId: context.scanRunId, taskId: context.taskId, memoryType: String(input.memory_type), memoryKey: String(input.memory_key), scopeType: input.scope_type as any, scopeRef: input.scope_ref ? String(input.scope_ref) : undefined, title: input.title ? String(input.title) : undefined, summary: String(input.summary), content: input.content && typeof input.content === 'object' ? input.content : {}, confidence: input.confidence === undefined ? undefined : Number(input.confidence), ttlSeconds: input.ttl_seconds === undefined ? undefined : Number(input.ttl_seconds), dependsOn: Array.isArray(input.depends_on) ? input.depends_on.map(String) : [], provenance: { source: 'agent.memory.remember', task_id: context.taskId } });
        return { ok: true, data: { memory_id: memory.id, version: memory.version, scope_type: memory.scope_type, scope_ref: memory.scope_ref }, summary: `Stored Agent memory ${memory.memory_type}:${memory.memory_key} v${memory.version}.` };
      },
    },
    {
      name: 'bstg.payload.plan',
      description: 'Returns the vulnerability-specific payload set that will be written into BSTG security_rules/checklists and consumed by native workflow variable configs.',
      input_schema: { type: 'object', properties: { vuln_type: { type: 'string' } } },
      side_effects: ['creates payload_plan artifact'],
      handler: async (input, context) => {
        const vulnType = String(input.vuln_type || 'generic');
        const payloads = payloadsForVulnType(vulnType);
        const data = { vuln_type: vulnType, payload_count: payloads.length, payloads };
        await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'payload_plan', title: `Payload plan for ${vulnType}`, content_json: data as unknown as Record<string, any> });
        return { ok: true, data: data as unknown as Record<string, any>, summary: `Planned ${payloads.length} payloads for ${vulnType}.` };
      },
    },

    {
      name: 'bstg.api_test.run',
      description: 'Drives BSTG native API test-run mode for vulnerabilities that can be tested on a single interface. It compiles baseline and mutation api_templates, binds security_rules/checklists/account fields, executes template test_runs, and emits native_api_test_run evidence before any finding gate can pass.',
      input_schema: {
        type: 'object',
        properties: {
          endpoint_id: { type: 'string' },
          vuln_type: { type: 'string' },
          param_name: { type: 'string' },
        },
        required: ['endpoint_id'],
      },
      side_effects: ['creates api_templates', 'creates test_runs', 'creates security_rules', 'creates checklists', 'creates native_api_test_run artifacts'],
      handler: async (input, context) => {
        if (!context.taskId) throw new Error('bstg.api_test.run requires an active AI scan task');
        const { task, endpoint } = await resolveTaskEndpointPlan({ repo: context.repo, scanRunId: context.scanRunId,
          taskId: context.taskId, endpointId: input.endpoint_id, vulnType: input.vuln_type });
        const vulnType = task.vuln_type || 'generic';
        const result = await runNativeApiTestRun({
          db: context.db,
          repo: context.repo,
          task,
          endpoint,
          payloads: payloadsForVulnType(vulnType),
          paramName: input.param_name ? String(input.param_name) : undefined,
        });
        return {
          ok: Boolean(result.api_mode?.baseline_run?.success && result.api_mode?.mutation_run?.success),
          data: result as unknown as Record<string, any>,
          summary: `Native API test-run mode executed for ${vulnType} on ${endpoint.method} ${endpoint.path}.`,
        };
      },
    },
    {
      name: 'bstg.learning.repair_workflow',
      description: 'Applies native BSTG execution learning to a workflow using the exact workflow debug trace identified by source_execution_run_id, preventing parallel Agent tasks from consuming another task’s evidence.',
      input_schema: { type: 'object', properties: { workflow_id: { type: 'string' }, source_execution_run_id: { type: 'string' } }, required: ['workflow_id', 'source_execution_run_id'] },
      side_effects: ['creates workflow_learning_suggestions', 'creates workflow_learning_evidence', 'updates workflow variables/mappings/extractors/session jar'],
      handler: async (input, context) => {
        const workflowId = String(input.workflow_id || '');
        if (!workflowId) throw new Error('workflow_id is required');
        const sourceExecutionRunId = String(input.source_execution_run_id || '');
        if (!sourceExecutionRunId) throw new Error('source_execution_run_id is required to isolate workflow learning evidence');
        const trace = getTraceByRunId('workflow', sourceExecutionRunId);
        if (!trace) throw new Error(`Workflow debug trace not found for source_execution_run_id=${sourceExecutionRunId}`);
        const result = await generateAndApplyExecutionLearning(context.db, workflowId, trace, { sourceExecutionRunId, includeAssertions: false, minConfidence: 0.5 });
        await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'bstg_learning_repair_tool_result', title: `Learning repair for workflow ${workflowId}`, content_json: result });
        return { ok: Boolean(result.ok), data: result, summary: result.ok ? `Applied learning repair to workflow ${workflowId}.` : `Learning repair skipped for workflow ${workflowId}: ${result.reason || 'unknown'}` };
      },
    },
    {
      name: 'browser.navigate',
      description: 'Navigates the target in the same isolated headed Playwright browser that users watch live through read-only noVNC. Fails if the browser is unavailable; never substitutes an HTTP response for browser interaction. Screenshots are retained only as audit evidence.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          timeout_ms: { type: 'number' },
          context_scope: { type: 'string', enum: ['scan', 'task', 'identity'] },
          identity_key: { type: 'string' },
          context_key: { type: 'string' },
          context_ttl_seconds: { type: 'number', minimum: 60, maximum: 86400 },
        },
      },
      side_effects: ['creates browser_state artifact', 'captures network events'],
      handler: async (input, context) => {
        const run = await context.repo.getRun(context.scanRunId);
        if (!run) throw new Error(`AI scan run not found: ${context.scanRunId}`);
        const url = String(input.url || run.base_url);
        const browserRuntime = run.scan_config?.browser_runtime || {};
        const result = await navigateWithOptionalBrowser({ url, repo: context.repo, scanRunId: context.scanRunId, taskId: context.taskId, timeout_ms: Number(input.timeout_ms || 45000), scope_base_url: run.base_url, signal: context.signal, context_scope: (input.context_scope || browserRuntime.default_scope || 'task') as any, identity_key: input.identity_key ? String(input.identity_key) : undefined, context_key: input.context_key ? String(input.context_key) : undefined, persist_context: true, context_ttl_seconds: input.context_ttl_seconds === undefined ? Number(browserRuntime.context_ttl_seconds || 3600) : Number(input.context_ttl_seconds) });
        return { ok: result.ok, data: result as unknown as Record<string, any>, summary: `${result.mode} navigation ${result.ok ? 'completed' : 'failed'} for ${url}`, error: result.error };
      },
    },
    {
      name: 'browser.interact',
      description: 'Performs a business UI action or assertion in the SAME previously navigated browser context shown in the read-only live viewer. Use selectors that identify exactly one visible match from observed DOM. For press, omit selector to send the allowed key once to the current page focus (for example Escape to dismiss a dialog); supply selector to focus and press on one visible control. An invalid supplied selector never falls back to page keyboard. On retryable pre_action failure with action_performed:false, inspect recovery_hint and observed controls; choose a corrected selector or safe dialog close action. Never repeat the unchanged rejected action, force a blocked control, or replay an action_or_after failure. At most two corrections are allowed until a selector-based interaction or assertion succeeds; selectorless press, observe, scroll, navigation and unrelated tools do not reset this limit. Task and run decision budgets still apply. An action is not a verified business result; assert the expected state separately. HTTP-only tests do not fabricate UI actions.',
      input_schema: {type:'object',required:['operation'],properties:{
        context_key:{type:'string'},context_scope:{type:'string',enum:['scan','task','identity']},identity_key:{type:'string'},
        timeout_ms:{type:'number'},operation:{type:'object',required:['action'],properties:{
          action:{type:'string',enum:['click','fill','select','press','scroll','assert','observe']},
          selector:{type:'string',description:'Required for click/fill/select/assert. Optional for press: omit to use current page focus; when supplied, must identify one visible control.'},
          value:{type:'string'},key:{type:'string',enum:['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Space'],description:'Required for press; one allowed key, without modifiers.'},text:{type:'string'},x:{type:'number'},y:{type:'number'}}},
      }},
      side_effects:['operates the authorized business UI','updates browser state','stores audit evidence'],
      handler: async(input,context)=>{
        const run=await context.repo.getRun(context.scanRunId);if(!run)throw new Error('Run not found');
        const result=await interactPersistentBrowser({repo:context.repo,scanRunId:context.scanRunId,taskId:context.taskId,
          scope_base_url:run.base_url,scope_type:(input.context_scope||run.scan_config?.browser_runtime?.default_scope||'task') as any,
          context_key:input.context_key?String(input.context_key):undefined,identity_key:input.identity_key?String(input.identity_key):undefined,
          operation:input.operation,timeout_ms:Number(input.timeout_ms||10000),signal:context.signal});
        return {ok:result.ok,data:result,summary:result.ok?'Business UI action completed; verify the business outcome.':'Business UI action did not complete.',error:result.error};
      },
    },
    {
      name: 'browser.context.close',
      description: 'Closes one persistent Playwright browser context while retaining its last persisted storage-state record for audit/recovery history.',
      input_schema: { type: 'object', required: ['context_key'], properties: { context_key: { type: 'string', minLength: 1 } } },
      side_effects: ['closes live browser context', 'marks ai_browser_contexts record closed'],
      handler: async (input, context) => {
        const contextKey = String(input.context_key || '');
        await closePersistentBrowserContext(context.repo, context.scanRunId, contextKey, 'closed');
        return { ok: true, data: { context_key: contextKey, status: 'closed' }, summary: `Closed persistent browser context ${contextKey}.` };
      },
    },
    {
      name: 'browser.discover_target',
      description: 'Fetches and crawls the target URL, extracts pages, links, HTML forms, file inputs, and normalizes them into discovered endpoints. This is the automated replacement for manual recording.',
      input_schema: {
        type: 'object',
        properties: {
          max_pages: { type: 'number', description: 'Maximum pages to crawl for this automated discovery pass.' },
        },
      },
      side_effects: ['creates ai_discovered_endpoints', 'creates ai_scan_artifacts'],
      handler: async (input, context) => {
        const run = await context.repo.getRun(context.scanRunId);
        if (!run) throw new Error(`AI scan run not found: ${context.scanRunId}`);
        await discoverWebPages(context.db,context.repo,run,context.taskId);
        const result = await discoverTargetFromHttp(run.base_url, { max_pages: Math.max(1,Math.min(100,Number(input.max_pages ?? run.scan_config?.max_pages ?? 30))) });
        for (const endpoint of result.endpoints) {
          const created = await context.repo.upsertEndpoint({
            scan_run_id: context.scanRunId,
            method: endpoint.method,
            path: endpoint.path,
            url: endpoint.url,
            request_summary: endpoint.request_summary,
            response_summary: endpoint.response_summary,
            content_type: endpoint.content_type,
            feature_guess: endpoint.feature_guess,
            source_type: endpoint.source_type,
            source_id: endpoint.source_id,
          });
          if (endpoint.form) {
            await context.repo.createArtifact({
              scan_run_id: context.scanRunId,
              task_id: context.taskId,
              artifact_type: 'browser_form',
              title: `${endpoint.method} ${endpoint.path}`,
              content_json: { endpoint_id: created.id, form: endpoint.form, has_file_input: endpoint.has_file_input || false },
              source_ref: created.id,
            });
          }
        }
        await context.repo.createArtifact({
          scan_run_id: context.scanRunId,
          task_id: context.taskId,
          artifact_type: 'browser_discovery_summary',
          title: 'Automated browser/http discovery summary',
          content_json: {
            pages: result.observations.map(item => ({ url: item.url, status: item.status, title: item.title, links: item.links.slice(0, 50), forms_count: item.forms.length })),
            endpoints_count: result.endpoints.length,
            warnings: result.warnings,
          },
        });
        return {
          ok: true,
          data: { endpoints_count: result.endpoints.length, pages_count: result.observations.length, warnings: result.warnings },
          summary: `Discovered ${result.endpoints.length} endpoints from ${result.observations.length} page observations.`,
        };
      },
    },
    {
      name: 'bstg.identity.bootstrap_accounts',
      description: 'Default account auto-execution mode. Discovers register/login forms, generates test-owned attacker/victim/admin accounts, submits registration, logs in, captures cookie/token/session material, saves BSTG account records, and publishes a reusable identity_pool. If OTP/captcha/MFA blocks automation it creates a human_input_request instead of silently pretending success.',
      input_schema: {
        type: 'object',
        properties: {
          roles: { type: 'array', items: { type: 'string' } },
          max_pages: { type: 'number' },
          form_values: { type: 'object' },
        },
      },
      side_effects: ['creates accounts', 'creates account_auto_bootstrap_result artifact', 'upserts identity_pool shared resource', 'may create human_input_request artifact'],
      handler: async (input, context) => {
        const run = await context.repo.getRun(context.scanRunId);
        if (!run) throw new Error(`AI scan run not found: ${context.scanRunId}`);
        const result = await bootstrapAutoAccounts({
          db: context.db,
          repo: context.repo,
          scanRunId: context.scanRunId,
          taskId: context.taskId,
          baseUrl: run.base_url,
          roles: Array.isArray(input.roles) ? input.roles.map(String) : (Array.isArray(run.scan_config?.auto_account_roles) ? run.scan_config.auto_account_roles.map(String) : ['attacker', 'victim', 'admin']),
          maxPages: Number(input.max_pages || run.scan_config?.account_bootstrap_max_pages || 40),
          formValueOverrides: (input.form_values && typeof input.form_values === 'object' ? input.form_values : run.scan_config?.auto_account_form_values) || {},
          accountMode: String(run.scan_config?.account_mode || 'auto_execute'),
          manualAccounts: run.scan_config?.accounts,
        });
        return {
          ok: result.ok,
          data: result as unknown as Record<string, any>,
          summary: result.created_accounts.length > 0
            ? `Auto-registered and logged in ${result.created_accounts.length} test account(s).`
            : `Account auto-execution did not create accounts: ${result.mode}.`,
        };
      },
    },
    {
      name: 'feature.extract_tree',
      description: 'Builds a project feature/sub-feature tree from discovered endpoints, page semantics, forms, and URL paths.',
      input_schema: { type: 'object', properties: {} },
      side_effects: ['rebuilds ai_feature_nodes'],
      handler: async (_input, context) => {
        const features = await rebuildFeatureTree(context.repo, context.scanRunId);
        return {
          ok: true,
          data: { features_count: features.length, features },
          summary: `Built feature tree with ${features.length} nodes.`,
        };
      },
    },
    {
      name: 'vuln.generate_candidates',
      description: 'Generates large-grain vulnerability candidates such as file upload, file download, path traversal, BOLA/IDOR, BFLA, business logic, XSS, command injection, auth/OTP, and replay/race from the feature tree and endpoints.',
      input_schema: { type: 'object', properties: {} },
      side_effects: ['rebuilds ai_vulnerability_candidates'],
      handler: async (_input, context) => {
        await rebuildVulnerabilityCandidates(context.repo, context.scanRunId);
        const aiEnhancement = await enhanceFeatureAndVulnModelWithAI({ db: context.db, repo: context.repo, scanRunId: context.scanRunId });
        const candidates = await context.repo.listCandidates(context.scanRunId);
        return {
          ok: true,
          data: { candidates_count: candidates.length, candidates, ai_enhancement: aiEnhancement },
          summary: `Generated ${candidates.length} vulnerability candidates. ${aiEnhancement.summary}`,
        };
      },
    },
    {
      name: 'task.expand_selected_vulnerabilities',
      description: 'Turns selected vulnerability types into persistent executable scan tasks by mapping candidates back to related features and endpoints.',
      input_schema: {
        type: 'object',
        properties: {
          selected_vuln_types: { type: 'array', items: { type: 'string' } },
        },
      },
      side_effects: ['creates ai_scan_tasks'],
      handler: async (input, context) => {
        const selected = Array.isArray(input.selected_vuln_types) ? input.selected_vuln_types.map(String) : [];
        const run = await context.repo.getRun(context.scanRunId);
        const maxTasksPerType = Number(run?.scan_config?.max_tasks_per_vuln_type || 0);
        const hasConfiguredIdentity = Boolean(
          Object.keys(run?.scan_config?.accounts || run?.scan_config?.identities || {}).length ||
          (Array.isArray(run?.scan_config?.account_raw_requests) ? run?.scan_config?.account_raw_requests.length : run?.scan_config?.account_raw_requests)
        );
        const allEndpointsForScoring = await hydrateRequests(context.repo, await context.repo.listEndpoints(context.scanRunId));
        const endpointsById = new Map(allEndpointsForScoring.map(endpoint => [endpoint.id, endpoint]));
        const candidateScore = (candidate: any): number => {
          const endpointText = (candidate.endpoint_ids || []).map((id: string) => {
            const endpoint = endpointsById.get(id);
            return endpoint ? `${endpoint.method} ${endpoint.path} ${endpoint.url || ''} ${endpoint.request_summary || ''} ${endpoint.feature_guess || ''}` : '';
          }).join(' ');
          const text = `${candidate.title || ''} ${candidate.reason || ''} ${endpointText}`.toLowerCase();
          let score = Number(candidate.confidence || 0);
          if (/uploadimage|walletimage|upload|download|dataoperate|ping|admin\/users|admin|orderdetail|order|withdraw|transfer|funds|wallet|cancelorder|payment|article|contact/.test(text)) score += 0.5;
          if (['file_download', 'path_traversal'].includes(candidate.vuln_type)) {
            if (/(download|filedownload|\/down(?:$|[\s/?#._-])|export|text\/plain|application\/octet-stream|attachment|content-disposition)/.test(endpointText)) score += 2.2;
            if (/[?&](file|filename|path|dir)=/.test(endpointText)) score += 0.35;
            if (/\/(?:login|account|manage|member|param|buy|hall|room)(?:\/init)?(?:[?\s]|$)/.test(endpointText) && /[?&](file|filename|path|dir)=/.test(endpointText) && !/(download|filedownload|\/down(?:$|[\s/?#._-])|export)/.test(endpointText)) score -= 0.9;
          }
          if (candidate.vuln_type === 'bola_idor' && /\/api\/(app\/)?login|clause|page browse|页面浏览/.test(text)) score -= 0.6;
          if (candidate.vuln_type === 'bola_idor' && /order|withdraw|transfer|wallet|user\/.+address|record|cancel/.test(text)) score += 0.9;
          if (candidate.vuln_type === 'bfla' && /admin\/users|admin|manage|role|permission/.test(text)) score += 0.9;
          if (candidate.vuln_type === 'business_logic') {
            const domain = businessLogicDomain(`${endpointText} ${candidate.title || ''}`);
            if (isBusinessLogicPrimaryDomain(domain)) score += 1.4;
            if (['amount_quantity', 'withdrawal', 'transfer', 'payment', 'cancellation', 'order_exchange', 'wallet'].includes(domain)) score += 0.9;
            if (domain === 'amount_quantity' && /html form with .*fields?:.*(quantity|amount|price|coupon)|\bget\b.*[?&](quantity|amount|price|coupon)=/i.test(endpointText)) score += 1.2;
            if (domain === 'amount_quantity' && /inline js\/api reference/i.test(endpointText) && /\bpost\b/i.test(endpointText)) score -= 0.6;
            if (domain === 'auth_only') score -= 3.0;
          }
          if (candidate.vuln_type === 'state_machine_race' && /refund/.test(text)) score += 1.8;
          if (candidate.vuln_type === 'state_machine_race' && /cancel|cancelorder/.test(text)) score += 1.55;
          if (candidate.vuln_type === 'state_machine_race' && /payment|pay|withdraw|transfer/.test(text)) score += 1.25;
          if (candidate.vuln_type === 'state_machine_race' && /get \/api\/order| get \/orders|orderdetail|detail|history|list/.test(text)) score -= 0.4;
          if (candidate.vuln_type === 'replay_race' && /refund/.test(text)) score += 1.25;
          if (candidate.vuln_type === 'replay_race' && /cancel|payment|pay|withdraw|transfer/.test(text)) score += 1.05;
          if (candidate.vuln_type === 'replay_race' && /cart|quantity/.test(text)) score += 0.9;
          if (candidate.vuln_type === 'replay_race' && /get \/api\/order| get \/orders|orderdetail|detail|history|list/.test(text)) score -= 0.25;
          if (candidate.vuln_type === 'auth_otp' || candidate.vuln_type === 'email_sms_bypass') {
            if (/\/index\.php\/index\/(?:sign|send)(?:$|[\/?#\s._-])|captcha|verify|code/.test(endpointText)) score += 1.2;
            if (/\/index\.php\/admin\/login(?:$|[\/?#\s._-])/.test(endpointText) && /[?&](file|host)=/.test(endpointText)) score -= 0.8;
          }
          if (candidate.vuln_type === 'passcode_bypass' && /withdraw|transfer|wallet|payment|paypwd|passcode|member_mpw|member_rpw|\/index\.php\/hall\/pw|trade.*password|fund.*password/.test(text)) score += 1.0;
          if (candidate.vuln_type === 'passcode_bypass' && /ping|command\/exec|dataoperate|host|domain/.test(text)) score -= 1.4;
          if (/placeholder|common|通用/.test(text)) score -= 0.2;
          return score;
        };
        const candidates = (await context.repo.listCandidates(context.scanRunId)).sort((a, b) => candidateScore(b) - candidateScore(a));
        const features = await context.repo.listFeatures(context.scanRunId);
        const endpointsAll = allEndpointsForScoring;
        const selectedCanonical = selected.length ? selected : Array.from(new Set(candidates.map(candidate => candidate.vuln_type)));
        await prepareSharedAgentResources({ db: context.db, repo: context.repo, scanRunId: context.scanRunId, taskId: context.taskId, selectedVulnTypes: selectedCanonical });
        const sharedLoginEndpointIds = await getSharedLoginEndpointIds(context.repo, context.scanRunId);
        const createdTasks: AIScanTask[] = [];
        const campaignTasks: AIScanTask[] = [];
        const summaryTasks: AIScanTask[] = [];
        const existing = await context.repo.listTasks(context.scanRunId);
        const existingKeys = new Set(existing.map(task => `${task.task_type}:${task.vuln_type || ''}:${task.feature_id || ''}:${task.endpoint_ids.join(',')}`));

        const candidateFeatureName = (candidate: any): string => {
          const feature = features.find(item => item.id === candidate.feature_id);
          if (feature?.name) return feature.name;
          const endpoint = (candidate.endpoint_ids || []).map((id: string) => endpointsById.get(id)).find(Boolean);
          return endpoint?.feature_guess || endpoint?.path || candidate.title || candidate.vuln_type;
        };
        const taskTypeForCandidate = (candidate: any): string => candidate.vuln_type === 'file_upload' ? 'test_file_upload' : 'test_generic_vuln';
        const taskPriorityForCandidate = (candidate: any): number => {
          if (candidate.vuln_type === 'file_upload') return 40;
          if (candidate.vuln_type === 'email_sms_bypass' || candidate.vuln_type === 'passcode_bypass') return 48;
          if (candidate.vuln_type === 'bola_idor' || candidate.vuln_type === 'bfla') return 45;
          if (candidate.vuln_type === 'business_logic' || candidate.vuln_type === 'auth_otp' || candidate.vuln_type === 'replay_race') return 50;
          if (candidate.vuln_type === 'command_injection') return 55;
          return 60;
        };
        const childGoalForCandidate = (candidate: any, functionName: string): string => {
          if (candidate.vuln_type === 'bola_idor') return `作为 BOLA/IDOR 子 Agent，围绕“${functionName}”梳理正常账号/受害者对象/攻击者访问路径，优先利用登录/session/对象 ID 上下文，自动选择 API test run、workflow 或 hybrid，并用 BSTG anchor_attacker、account binding、checklist、extractor、mapping 和 native evidence gate 验证是否存在横向越权。`;
          if (candidate.vuln_type === 'bfla') return `作为 BFLA 子 Agent，围绕“${functionName}”验证普通用户是否能访问管理/高权限功能，自动准备账号/session 证据，选择 API test run 或 workflow，使用 BSTG 账号绑定、权限变异和 evidence gate 形成闭环。`;
          if (candidate.vuln_type === 'business_logic') return `作为业务逻辑漏洞子 Agent，围绕“${functionName}”建立正常业务流和异常变异流，自动判断是否需要 workflow 状态机、API 单接口变异或 hybrid，验证金额、状态、数量、订单、购物车、交易等逻辑异常。`;
          if (candidate.vuln_type === 'auth_otp' || candidate.vuln_type === 'email_sms_bypass') return `作为认证/邮箱短信验证码子 Agent，围绕“${functionName}”构造发送验证码、校验验证码、登录/注册/找回密码等 workflow，使用 extractor、mapping、session jar 和 mutation profile 验证验证码复用、绕过、跨账号使用或票据缺陷。`;
          if (candidate.vuln_type === 'passcode_bypass') return `作为 passcode/支付密码绕过子 Agent，围绕“${functionName}”建立资金/交易/登录后敏感动作的正常校验流和异常变异流，测试空 passcode、弱码、跳过字段、验证状态复用和跨流程绕过，并使用 BSTG workflow/API test run、extractor、mapping、session jar、mutation 和 evidence gate。`;
          if (candidate.vuln_type === 'file_upload') return `作为文件上传子 Agent，围绕“${functionName}”建立正常上传 baseline，自动选择 API 或 workflow/hybrid，写入 BSTG security_rules/checklists，执行异常文件 payload、上传后访问验证和 native evidence gate。`;
          return `作为 ${candidate.vuln_type} 子 Agent，围绕“${functionName}”选择 API test run、workflow 或 hybrid，调用 BSTG 原生模板、变量、payload、学习、mutation 和 evidence gate 完成端到端测试。`;
        };
        const isUploadEndpointForFallback = (endpoint: AIDiscoveredEndpoint): boolean => {
          const method = endpoint.method.toUpperCase();
          const text = `${endpoint.method} ${endpoint.path} ${endpoint.url || ''} ${endpoint.request_summary || ''} ${endpoint.response_summary || ''} ${endpoint.feature_guess || ''} ${endpoint.content_type || ''}`.toLowerCase();
          let pathname = String(endpoint.path || '').toLowerCase();
          try {
            if (endpoint.url) pathname = `${pathname} ${new URL(endpoint.url).pathname.toLowerCase()}`;
          } catch {
            // Keep the persisted path as the matching surface when URL parsing fails.
          }
          if (endpoint.content_type?.toLowerCase().includes('multipart/form-data')) return true;
          if (method === 'GET') return false;
          if (/multipart\/form-data|formdata\s*\(|file input|type=file/.test(text)) return true;
          return /(?:^|[\/._-])(upload|avatar|attachment|media|image|excel|import)(?:$|[\/._-])/.test(pathname);
        };
        const scoreEndpointForFallback = (endpoint: AIDiscoveredEndpoint, vulnType: string): number => {
          const text = `${endpoint.method} ${endpoint.path} ${endpoint.url || ''} ${endpoint.request_summary || ''} ${endpoint.response_summary || ''} ${endpoint.feature_guess || ''}`.toLowerCase();
          let score = endpoint.method.toUpperCase() === 'GET' ? 0.1 : 0.25;
          if (endpoint.source_type === 'browser_form' || endpoint.source_type === 'browser_js_reference') score += 0.4;
          const matches: Record<string, RegExp> = {
            file_upload: /upload|avatar|attachment|media|image|import|multipart|formdata|上传|附件|导入/,
            file_download: /download|export|file|path|filename|下载|导出/,
            path_traversal: /download|export|file|path|filename|dir|目录|路径/,
            bola_idor: /id|uid|user|account|order|wallet|file|address|record|对象|订单|用户/,
            bfla: /admin|manage|role|permission|后台|管理|权限/,
            business_logic: /cart|order|pay|payment|coupon|refund|withdraw|transfer|wallet|amount|quantity|price|订单|支付|退款|提现|转账|金额|数量/,
            xss: /search|comment|post|article|content|message|title|form|q=|query|评论|搜索|内容/,
            command_injection: /cmd|command|exec|shell|ping|host|domain|命令/,
            auth_otp: /login|register|password|captcha|otp|sms|email|verify|code|登录|注册|验证码|短信|邮箱/,
            email_sms_bypass: /sms|email|mail|otp|captcha|verify|code|验证码|短信|邮箱/,
            passcode_bypass: /passcode|paypwd|pay_password|pin|payment.*password|trade.*password|支付密码|交易密码/,
            replay_race: /cart|order|pay|payment|coupon|refund|withdraw|transfer|wallet|cancel|quantity|订单|支付|退款|提现|转账|撤单/,
            state_machine_race: /refund|cancel|pay|payment|withdraw|transfer|order|status|state|退款|取消|支付|提现|转账|状态/,
          };
          if (matches[vulnType]?.test(text)) score += 2;
          if (vulnType === 'file_upload') score += isUploadEndpointForFallback(endpoint) ? 1.25 : -3;
          if (/login|register/.test(text) && !['auth_otp', 'email_sms_bypass'].includes(vulnType)) score -= 0.5;
          return score;
        };
        const fallbackCandidatesForType = (vulnType: string): any[] => {
          const ranked = endpointsAll
            .map(endpoint => ({ endpoint, score: scoreEndpointForFallback(endpoint, vulnType) }))
            .sort((a, b) => b.score - a.score)
            .filter(item => item.score > 0.2);
          const fallbackLimit = Number(run?.scan_config?.fallback_tasks_per_vuln_type || 0) || 1;
          return ranked.slice(0, fallbackLimit).map((item, index) => ({
            id: `fallback:${vulnType}:${item.endpoint.id}:${index + 1}`,
            feature_id: features.find(feature => feature.endpoint_ids.includes(item.endpoint.id))?.id,
            vuln_type: vulnType,
            title: `${item.endpoint.feature_guess || item.endpoint.path} - ${vulnType} fallback coverage`,
            reason: `自动驾驶全漏洞覆盖兜底：候选生成未产出 ${vulnType}，但为保证该漏洞类型不会静默跳过，选择最相关 endpoint 执行低置信兜底测试。`,
            confidence: Math.min(0.49, 0.25 + item.score / 10),
            endpoint_ids: [item.endpoint.id],
            required_accounts: [],
            fallback_coverage: true,
          }));
        };
        const selectedGroups = selectedCanonical
          .map(type => {
            const mapped = candidates.filter(candidate => shouldMapCandidateToSelected(candidate.vuln_type, [type]));
            return { type, candidates: mapped.length ? mapped : fallbackCandidatesForType(type), used_fallback: mapped.length === 0 };
          })
          .filter(group => group.candidates.length > 0);
        const planCandidate = (candidate: any) => {
          const feature = features.find(item => item.id === candidate.feature_id);
          const functionName = candidateFeatureName(candidate);
          const requiresSharedIdentity = ['bola_idor', 'bfla', 'business_logic', 'auth_otp', 'email_sms_bypass', 'passcode_bypass', 'replay_race', 'state_machine_race'].includes(candidate.vuln_type);
          const workflowPlan = buildWorkflowExecutionPlan({
            allEndpoints: endpointsAll,
            selectedEndpointIds: candidate.endpoint_ids,
            vulnType: candidate.vuln_type,
            sharedLoginEndpointIds: requiresSharedIdentity ? sharedLoginEndpointIds : [],
            hasConfiguredIdentity,
          });
          let endpointContext = workflowPlan.endpoint_ids.length
            ? workflowPlan.endpoint_ids
            : buildWorkflowEndpointContext({ allEndpoints: endpointsAll, selectedEndpointIds: candidate.endpoint_ids, vulnType: candidate.vuln_type }).map(endpoint => endpoint.id);
          // The dependency planner already selects required login steps. Adding
          // every shared login reference here reintroduced unobserved requests.
          const targetEndpoint = workflowPlan.target_endpoint_id ? endpointsById.get(workflowPlan.target_endpoint_id) : undefined;
          const targetRoute = normalizeBucket(targetEndpoint ? `${targetEndpoint.method} ${targetEndpoint.path}` : endpointContext.join('|'));
          const functionBucket = normalizeBucket(feature?.name || functionName);
          const requirementBucket = workflowPlan.required_capabilities.slice().sort().join('+') || 'no-extra-capability';
          const targetText = targetEndpoint ? `${targetEndpoint.method} ${targetEndpoint.path} ${targetEndpoint.url || ''} ${targetEndpoint.request_summary || ''} ${targetEndpoint.feature_guess || ''}` : '';
          const featureText = `${feature?.name || functionName} ${targetText}`;
          let businessDomain = businessLogicDomain(featureText);
          if (businessDomain === 'other') businessDomain = businessLogicDomain(`${featureText} ${candidate.title || ''}`);
          return {
            candidate,
            feature,
            functionName,
            requiresSharedIdentity,
            workflowPlan,
            endpointContext,
            functionBucket,
            businessDomain,
            semanticKey: `${candidate.vuln_type}:${functionBucket}:${businessDomain}:${workflowPlan.target_kind}:${targetRoute}:${requirementBucket}`,
          };
        };
        const selectRepresentativePlans = (group: { type: string; candidates: any[] }) => {
          const configuredMax = maxTasksPerType > 0 ? maxTasksPerType : Number(run?.scan_config?.max_tasks_per_vuln_type_by_type?.[group.type] || 0);
          const maxForType = configuredMax > 0 ? configuredMax : defaultMaxTasksForVulnType(group.type);
          const perBucketLimit = Number(run?.scan_config?.max_tasks_per_function_bucket || 0) || maxTasksPerFunctionBucket(group.type);
          const seen = new Set<string>();
          const bucketCounts = new Map<string, number>();
          const candidatePlans: ReturnType<typeof planCandidate>[] = [];
          for (const candidate of group.candidates) {
            const plan = planCandidate(candidate);
            if (!plan.endpointContext.length) continue;
            if (seen.has(plan.semanticKey)) continue;
            if (group.type === 'business_logic' && !plan.candidate?.fallback_coverage && !isBusinessLogicPrimaryDomain(plan.businessDomain)) continue;
            const bucketKey = group.type === 'business_logic' ? `${plan.functionBucket}:${plan.businessDomain}` : plan.functionBucket;
            const bucketCount = bucketCounts.get(bucketKey) || 0;
            if (bucketCount >= perBucketLimit) continue;
            seen.add(plan.semanticKey);
            bucketCounts.set(bucketKey, bucketCount + 1);
            candidatePlans.push(plan);
          }
          if (group.type !== 'business_logic') return candidatePlans.slice(0, maxForType);

          const domainPriority = ['amount_quantity', 'payment', 'refund', 'cancellation', 'withdrawal', 'transfer', 'wallet', 'order_exchange', 'admin_privileged'];
          const domainBuckets = new Map<string, ReturnType<typeof planCandidate>[]>();
          for (const plan of candidatePlans) {
            const bucket = domainBuckets.get(plan.businessDomain) || [];
            if (bucket.length < 3) {
              bucket.push(plan);
              domainBuckets.set(plan.businessDomain, bucket);
            }
          }
          const domainOrder = [
            ...domainPriority.filter(domain => domainBuckets.has(domain)),
            ...Array.from(domainBuckets.keys()).filter(domain => !domainPriority.includes(domain)),
          ];
          const selectedPlans: ReturnType<typeof planCandidate>[] = [];
          while (selectedPlans.length < maxForType) {
            let addedThisRound = false;
            for (const domain of domainOrder) {
              const bucket = domainBuckets.get(domain);
              const nextPlan = bucket?.shift();
              if (!nextPlan) continue;
              selectedPlans.push(nextPlan);
              addedThisRound = true;
              if (selectedPlans.length >= maxForType) break;
            }
            if (!addedThisRound) break;
          }
          return selectedPlans;
        };

        for (const group of selectedGroups) {
          const planned = selectRepresentativePlans(group);
          if (planned.length === 0) continue;
          const campaign = await context.repo.createTask({
            scan_run_id: context.scanRunId,
            parent_task_id: context.taskId,
            title: `${group.type} 漏洞专项测试 Campaign：梳理全部相关功能点并派发子 Agent`,
            task_type: 'vulnerability_campaign',
            vuln_type: group.type,
            status: 'completed',
            phase: 'planned',
            priority: 30,
            endpoint_ids: Array.from(new Set(planned.flatMap(plan => plan.endpointContext || []))),
            agent_goal: `主 Agent 已为 ${group.type} 专项测试建立持久化 Campaign。该 Campaign 不是单个粗粒度测试任务，而是承载多个功能/子功能子 Agent 的父级任务。`,
            execution_plan: {
              role: 'campaign_parent',
              selected_vuln_type: group.type,
              planned_candidate_ids: planned.map(plan => plan.candidate.id),
              orchestration: 'parent_campaign_with_parallel_feature_subagents_and_summary',
              dedupe_policy: {
                max_tasks_per_type: planned.length,
                semantic_key: 'vuln_type + function_bucket + business_domain + target_kind + target_route + required_capabilities',
                max_tasks_per_function_bucket: Number(run?.scan_config?.max_tasks_per_function_bucket || 0) || maxTasksPerFunctionBucket(group.type),
                business_logic_domain_sampling: group.type === 'business_logic' ? 'round_robin_across_primary_business_domains' : undefined,
              },
            },
          });
          campaignTasks.push(campaign);
          await context.repo.createArtifact({
            scan_run_id: context.scanRunId,
            task_id: campaign.id,
            artifact_type: 'vulnerability_campaign_plan',
            title: `${group.type} campaign plan`,
            content_json: {
              vuln_type: group.type,
              campaign_task_id: campaign.id,
              selected_candidates: planned.map(plan => ({
                id: plan.candidate.id,
                title: plan.candidate.title,
                reason: plan.candidate.reason,
                confidence: plan.candidate.confidence,
                feature_id: plan.candidate.feature_id,
                feature_name: plan.feature?.name || plan.functionName,
                endpoint_ids: plan.endpointContext,
                semantic_key: plan.semanticKey,
                target_kind: plan.workflowPlan.target_kind,
                access_phase: plan.workflowPlan.access_phase,
              })),
            },
          });

          const childTasks: AIScanTask[] = [];
          for (const plan of planned) {
            const { candidate, feature, functionName, requiresSharedIdentity, workflowPlan, endpointContext } = plan;
            const taskType = taskTypeForCandidate(candidate);
            const key = `${taskType}:${candidate.vuln_type}:${candidate.feature_id || ''}:${endpointContext.join(',')}`;
            if (existingKeys.has(key)) continue;
            const target = endpointsById.get(workflowPlan.target_endpoint_id || candidate.endpoint_ids[0]);
            const missingCapture = taskType !== 'test_file_upload' && endpointContext.some(id => !endpointsById.get(id)?.captured_request);
            const missingInput = taskType !== 'test_file_upload' && target?.captured_request && !Object.keys(capturedParameters(target)).length;
            const captureBlock = missingCapture ? '尚未采集本项所需的完整业务请求。请实际操作对应页面或导入流量后重新测试。'
              : missingInput ? '本项请求尚无可验证的输入字段。请采集包含业务参数的实际操作后重新测试。' : undefined;
            const createdTask = await context.repo.createTask({
              scan_run_id: context.scanRunId,
              parent_task_id: campaign.id,
              title: `${group.type} 子 Agent：测试功能点「${feature?.name || functionName}」`,
              task_type: taskType,
              ...(captureBlock ? {status: 'blocked' as const, phase: 'capture_required', result_summary: captureBlock} : {}),
              vuln_type: candidate.vuln_type,
              feature_id: candidate.feature_id,
              endpoint_ids: endpointContext,
              priority: taskPriorityForCandidate(candidate),
              agent_goal: childGoalForCandidate(candidate, feature?.name || functionName),
              execution_plan: {
                candidate_id: candidate.id,
                campaign_task_id: campaign.id,
                campaign_vuln_type: group.type,
                function_name: feature?.name || functionName,
                semantic_dedupe_key: plan.semanticKey,
                strategy: candidate.vuln_type === 'file_upload' ? 'subagent_normal_upload_mutation_post_access_native_gate' : 'subagent_baseline_mutation_native_gate',
                vuln_type: candidate.vuln_type,
                parallel_group: `${group.type}:${candidate.feature_id || candidate.id}`,
                parallel_capable: workflowPlan.parallel_capable,
                orchestration_mode: workflowPlan.parallel_capable ? 'parallel_independent_task' : 'serial_prerequisite_workflow_inside_task',
                workflow_execution_plan: workflowPlan,
                precondition_policy: {
                  enforce_before_target: true,
                  block_finding_when_missing: true,
                  missing_preconditions: workflowPlan.missing_preconditions,
                  access_phase: workflowPlan.access_phase,
                  target_kind: workflowPlan.target_kind,
                },
                recommended_agent_role: `${candidate.vuln_type}-feature-subagent`,
                requires_identity_context: requiresSharedIdentity,
                execution_path_is_agent_decision: true,
                shared_resource_refs: {
                  identity_pool: 'identity_pool:default-attacker-victim-admin',
                  login_flow: requiresSharedIdentity ? 'workflow_blueprint:canonical-login-session-flow' : undefined,
                  session_strategy: requiresSharedIdentity ? 'session_strategy:default-session-jar-and-token-propagation' : undefined,
                  object_inventory: requiresSharedIdentity ? 'object_inventory:observed-object-and-owner-fields' : undefined,
                  payload_plan: `payload_plan:${candidate.vuln_type}`,
                },
              },
            });
            await context.repo.createArtifact({
              scan_run_id: context.scanRunId,
              task_id: createdTask.id,
              artifact_type: 'workflow_dependency_plan',
              title: `Workflow dependency plan for ${candidate.vuln_type} / ${feature?.name || functionName}`,
              content_json: workflowPlan as unknown as Record<string, any>,
              content_text: workflowPlan.mermaid,
              source_ref: workflowPlan.target_endpoint_id || candidate.id,
            });
            existingKeys.add(key);
            createdTasks.push(createdTask);
            childTasks.push(createdTask);
          }
          if (childTasks.length > 0) {
            const summaryTask = await context.repo.createTask({
              scan_run_id: context.scanRunId,
              parent_task_id: campaign.id,
              title: `${group.type} 专项测试结果收敛`,
              task_type: 'summarize_vulnerability_campaign',
              vuln_type: group.type,
              status: 'pending',
              priority: 90,
              dependencies: childTasks.map(task => task.id),
              endpoint_ids: Array.from(new Set(childTasks.flatMap(task => task.endpoint_ids || []))),
              agent_goal: `收敛 ${group.type} 专项下所有功能/子功能子 Agent 的执行结果、native BSTG 证据、findings 和未闭合证据，形成该漏洞类型的整体结论。`,
              execution_plan: {
                campaign_task_id: campaign.id,
                child_task_ids: childTasks.map(task => task.id),
                intent: 'summarize_vulnerability_campaign',
                vuln_type: group.type,
              },
            });
            summaryTasks.push(summaryTask);
          }
        }
        const coverage = {
          selected_vuln_types: selectedCanonical,
          campaign_vuln_types: campaignTasks.map(task => task.vuln_type).filter(Boolean),
          child_task_vuln_types: Array.from(new Set(createdTasks.map(task => task.vuln_type).filter(Boolean))),
          missing_vuln_types: selectedCanonical.filter(type => !campaignTasks.some(task => task.vuln_type === type)),
          fallback_vuln_types: selectedGroups.filter(group => group.used_fallback).map(group => group.type),
          all_selected_types_covered: selectedCanonical.every(type => campaignTasks.some(task => task.vuln_type === type)),
        };
        await context.repo.createArtifact({
          scan_run_id: context.scanRunId,
          task_id: context.taskId,
          artifact_type: 'autopilot_vulnerability_coverage_matrix',
          title: 'Autopilot all-vulnerability task coverage matrix',
          content_json: coverage as unknown as Record<string, any>,
        });
        return {
          ok: true,
          data: {
            created_tasks_count: createdTasks.length,
            created_tasks: createdTasks,
            campaign_tasks_count: campaignTasks.length,
            campaign_tasks: campaignTasks,
            summary_tasks_count: summaryTasks.length,
            summary_tasks: summaryTasks,
            coverage,
          },
          summary: `Created ${createdTasks.length} feature/sub-feature sub-agent tasks under ${campaignTasks.length} vulnerability campaigns, plus ${summaryTasks.length} campaign summary tasks. Coverage ${coverage.child_task_vuln_types.length}/${selectedCanonical.length} selected vulnerability types.`,
        };
      },
    },
    {
      name: 'task.summarize_vulnerability_campaign',
      description: 'Summarizes one selected vulnerability campaign after all its feature/sub-feature sub-agent tasks finish. It aggregates child task results, native BSTG evidence, findings, blocked evidence, and residual gaps into a persistent campaign_summary artifact.',
      input_schema: {
        type: 'object',
        properties: {
          campaign_task_id: { type: 'string' },
          child_task_ids: { type: 'array', items: { type: 'string' } },
          vuln_type: { type: 'string' },
        },
      },
      side_effects: ['creates campaign_summary artifact'],
      handler: async (input, context) => {
        const task = context.taskId ? await context.repo.getTask(context.taskId) : null;
        if (!task) throw new Error('task.summarize_vulnerability_campaign requires an active summary task');
        const vulnType = String(input.vuln_type || task.vuln_type || task.execution_plan?.vuln_type || 'generic');
        const campaignTaskId = String(input.campaign_task_id || task.execution_plan?.campaign_task_id || task.parent_task_id || '');
        const childTaskIds = Array.isArray(input.child_task_ids) && input.child_task_ids.length
          ? input.child_task_ids.map(String)
          : Array.isArray(task.execution_plan?.child_task_ids) ? task.execution_plan.child_task_ids.map(String) : [];
        const snapshot = await context.repo.getSnapshot(context.scanRunId);
        const childTasks = snapshot.tasks.filter(item => childTaskIds.includes(item.id));
        const childTaskIdSet = new Set(childTasks.map(item => item.id));
        const childArtifacts = snapshot.artifacts.filter(artifact => artifact.task_id && childTaskIdSet.has(artifact.task_id));
        const artifactsByType: Record<string, number> = {};
        for (const artifact of childArtifacts) artifactsByType[artifact.artifact_type] = (artifactsByType[artifact.artifact_type] || 0) + 1;
        const toolInvocations = snapshot.tool_invocations.filter(invocation => invocation.task_id && childTaskIdSet.has(invocation.task_id));
        const toolsByName: Record<string, number> = {};
        for (const invocation of toolInvocations) toolsByName[invocation.tool_name] = (toolsByName[invocation.tool_name] || 0) + 1;
        const provenanceIds = Array.from(new Set([campaignTaskId, ...childTaskIds].filter(Boolean)));
        const campaignFindings = provenanceIds.length
          ? await dbAll<any>(context.db, `SELECT f.id, f.title, f.severity,
              p.task_id AS ai_scan_task_id, p.campaign_task_id AS ai_campaign_task_id,
              p.candidate_id AS ai_candidate_id, p.feature_id AS ai_feature_id,
              p.endpoint_id AS ai_endpoint_id, p.evidence_contract_id AS ai_evidence_contract,
              f.created_at
            FROM findings f
            JOIN ai_finding_provenance p ON p.finding_id = f.id
            WHERE f.source_type = 'ai_scan' AND p.scan_run_id = ?
              AND (p.campaign_task_id = ? OR p.task_id IN (${childTaskIds.length ? childTaskIds.map(() => '?').join(',') : "''"}))
            ORDER BY f.created_at ASC`, [context.scanRunId, campaignTaskId || '__none__', ...childTaskIds])
          : [];
        const completed = childTasks.filter(item => item.status === 'completed').length;
        const failed = childTasks.filter(item => item.status === 'failed').length;
        const blocked = childTasks.filter(item => item.status === 'blocked').length;
        const summary = {
          vuln_type: vulnType,
          campaign_task_id: campaignTaskId,
          summary_task_id: task.id,
          child_tasks_total: childTasks.length,
          child_tasks_completed: completed,
          child_tasks_failed: failed,
          child_tasks_blocked: blocked,
          native_api_test_run_artifacts: artifactsByType.native_api_test_run || 0,
          native_workflow_verification_artifacts: artifactsByType.native_workflow_verification || 0,
          native_bstg_execution_artifacts: artifactsByType.native_bstg_execution || 0,
          learning_repair_artifacts: artifactsByType.bstg_learning_repair || 0,
          findings_count: campaignFindings.length,
          findings: campaignFindings.map(finding => ({ id: finding.id, title: finding.title, severity: finding.severity })),
          tools_by_name: toolsByName,
          child_tasks: childTasks.map(item => ({ id: item.id, title: item.title, status: item.status, phase: item.phase, endpoint_ids: item.endpoint_ids, result_summary: item.result_summary })),
          residual_gaps: [
            failed ? `${failed} child task(s) failed` : '',
            blocked ? `${blocked} child task(s) blocked` : '',
            campaignFindings.length === 0 ? 'No confirmed finding for this vulnerability campaign; evidence may be negative or inconclusive.' : '',
          ].filter(Boolean),
        };
        await context.repo.createArtifact({
          scan_run_id: context.scanRunId,
          task_id: task.id,
          artifact_type: 'vulnerability_campaign_summary',
          title: `${vulnType} campaign summary`,
          content_json: summary,
        });
        return { ok: failed === 0, data: summary, summary: `${vulnType} campaign summary: ${completed}/${childTasks.length} child tasks completed, ${campaignFindings.length} confirmed finding(s).` };
      },
    },
    {
      name: 'bstg.file_upload.run_test',
      description: 'Uses BSTG assets plus direct HTTP multipart execution to test a file upload endpoint end-to-end: normal upload, mutated uploads, fetch uploaded result, AI/heuristic judgement, and finding creation.',
      input_schema: {
        type: 'object',
        properties: {
          endpoint_id: { type: 'string' },
          endpoint_ids: { type: 'array', items: { type: 'string' } },
        },
      },
      side_effects: ['creates api_template', 'creates security_rule', 'creates checklist', 'creates ai artifacts', 'may create finding'],
      handler: async (input, context) => {
        if (!context.taskId) throw new Error('bstg.file_upload.run_test requires an active task');
        const { task, endpoint, plan } = await resolveTaskEndpointPlan({ repo: context.repo, scanRunId: context.scanRunId,
          taskId: context.taskId, endpointId: input.endpoint_id, endpointIds: input.endpoint_ids, vulnType: 'file_upload' });
        const isUploadEndpoint = (endpoint: AIDiscoveredEndpoint): boolean => {
          const method = endpoint.method.toUpperCase();
          const text = `${endpoint.method} ${endpoint.path} ${endpoint.url || ''} ${endpoint.request_summary || ''} ${endpoint.response_summary || ''} ${endpoint.feature_guess || ''} ${endpoint.content_type || ''}`.toLowerCase();
          let pathname = String(endpoint.path || '').toLowerCase();
          try {
            if (endpoint.url) pathname = `${pathname} ${new URL(endpoint.url).pathname.toLowerCase()}`;
          } catch {
            // Keep the persisted path as the matching surface when URL parsing fails.
          }
          if (endpoint.content_type?.toLowerCase().includes('multipart/form-data')) return true;
          if (method === 'GET') return false;
          if (/multipart\/form-data|formdata\s*\(|file input|type=file/.test(text)) return true;
          return /(?:^|[\/._-])(upload|avatar|attachment|media|image|excel|import)(?:$|[\/._-])/.test(pathname);
        };
        if (!isUploadEndpoint(endpoint)) {
          const skip = {
            endpoint: { id: endpoint.id, method: endpoint.method, path: endpoint.path, url: endpoint.url, content_type: endpoint.content_type, feature_guess: endpoint.feature_guess },
            requested_endpoint_ids: plan.endpoint_ids,
            reason: 'No multipart/file-input/non-GET upload endpoint was available in the task context; skipped upload runner to avoid creating false file-upload evidence from file download/query endpoints.',
          };
          await context.repo.createArtifact({
            scan_run_id: context.scanRunId,
            task_id: task.id,
            artifact_type: 'file_upload_endpoint_skipped',
            title: 'File upload runner skipped non-upload endpoint context',
            content_json: skip,
            source_ref: endpoint.id,
          });
          await context.repo.updateTask(task.id, {
            phase: 'no_upload_endpoint',
            result_summary: skip.reason,
          });
          return { ok: true, data: skip, summary: skip.reason };
        }
        await markSharedResourcesUsed({ repo: context.repo, scanRunId: context.scanRunId, refs: Object.values(task.execution_plan?.shared_resource_refs || {}).filter(Boolean) as string[] });
        const result = await runFileUploadTask({ db: context.db, repo: context.repo, task, endpoint });
        return {
          ok: true,
          data: result,
          summary: `File upload test completed with verdict ${result.judge?.verdict || 'unknown'}.`,
        };
      },
    },

    {
      name: 'bstg.generic_vuln.run_test',
      description: 'Runs an executable generic vulnerability test for file download/path traversal, BOLA/IDOR, BFLA, business logic, XSS, command injection, auth/OTP, replay/race by creating BSTG assets, establishing baseline, mutating candidate parameters, judging evidence, and creating findings when confirmed.',
      input_schema: {
        type: 'object',
        properties: {
          endpoint_id: { type: 'string' },
          endpoint_ids: { type: 'array', items: { type: 'string' } },
        },
      },
      side_effects: ['creates api_template', 'creates workflow', 'creates security_rule', 'creates ai artifacts', 'may create finding'],
      handler: async (input, context) => {
        if (!context.taskId) throw new Error('bstg.generic_vuln.run_test requires an active task');
        const { task, endpoint, endpoints } = await resolveTaskEndpointPlan({ repo: context.repo, scanRunId: context.scanRunId,
          taskId: context.taskId, endpointId: input.endpoint_id, endpointIds: input.endpoint_ids });
        await markSharedResourcesUsed({ repo: context.repo, scanRunId: context.scanRunId, refs: Object.values(task.execution_plan?.shared_resource_refs || {}).filter(Boolean) as string[] });
        const result = await runGenericVulnerabilityTask({ db: context.db, repo: context.repo, task, endpoint, endpoints });
        return {
          ok: true,
          data: result,
          summary: `${task.vuln_type || 'generic'} test completed with verdict ${result.judge?.verdict || 'unknown'}.`,
        };
      },
    },
  ];
}
