import type { AgentToolSpec } from '../tool-types.js';
import { dbAll } from '../../db/sql-helpers.js';
import { discoverTargetFromHttp } from '../../services/ai-scan/browser-discovery.js';
import { rebuildFeatureTree, rebuildVulnerabilityCandidates, shouldMapCandidateToSelected } from '../../services/ai-scan/feature-vuln-engine.js';
import { runFileUploadTask } from '../../services/ai-scan/file-upload-runner.js';
import { runGenericVulnerabilityTask } from '../../services/ai-scan/generic-vuln-runner.js';
import { enhanceFeatureAndVulnModelWithAI } from '../../services/ai-scan/ai-planner.js';
import { navigateWithOptionalBrowser } from '../../services/ai-scan/browser/browser-session-service.js';
import type { AIDiscoveredEndpoint, AIScanTask } from '../../services/ai-scan/types.js';
import { buildWorkflowEndpointContext } from '../../services/ai-scan/workflow-context.js';
import { getBstgCapabilityInventory } from '../../services/ai-scan/bstg-capability-map.js';
import { generateAndApplyExecutionLearning } from '../../services/ai-scan/bstg-learning-automation.js';
import { getLastTrace } from '../../services/debug-trace.js';
import { payloadsForVulnType } from '../../services/ai-scan/payload-catalog.js';
import { runNativeApiTestRun } from '../../services/ai-scan/bstg-native-orchestrator.js';
import { getSharedLoginEndpointIds, markSharedResourcesUsed, prepareSharedAgentResources } from '../../services/ai-scan/shared-resource-manager.js';

function endpointById(endpoints: AIDiscoveredEndpoint[], id: string): AIDiscoveredEndpoint | undefined {
  return endpoints.find(endpoint => endpoint.id === id);
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
        const task = context.taskId ? await context.repo.getTask(context.taskId) : null;
        if (!task) throw new Error('bstg.api_test.run requires an active AI scan task');
        const endpoints = await context.repo.listEndpoints(context.scanRunId);
        const endpoint = endpointById(endpoints, String(input.endpoint_id));
        if (!endpoint) throw new Error(`Endpoint not found: ${input.endpoint_id}`);
        const vulnType = String(input.vuln_type || task.vuln_type || 'generic');
        const result = await runNativeApiTestRun({
          db: context.db,
          repo: context.repo,
          task: { ...task, vuln_type: vulnType } as AIScanTask,
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
      description: 'Applies native BSTG execution learning to a workflow using the last workflow debug trace: creates workflow_variables, workflow_mappings, workflow_extractors and session jar config, then records learning suggestion/evidence rows.',
      input_schema: { type: 'object', properties: { workflow_id: { type: 'string' }, source_execution_run_id: { type: 'string' } }, required: ['workflow_id'] },
      side_effects: ['creates workflow_learning_suggestions', 'creates workflow_learning_evidence', 'updates workflow variables/mappings/extractors/session jar'],
      handler: async (input, context) => {
        const workflowId = String(input.workflow_id || '');
        if (!workflowId) throw new Error('workflow_id is required');
        const result = await generateAndApplyExecutionLearning(context.db, workflowId, getLastTrace('workflow'), { sourceExecutionRunId: input.source_execution_run_id ? String(input.source_execution_run_id) : undefined, includeAssertions: false, minConfidence: 0.5 });
        await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'bstg_learning_repair_tool_result', title: `Learning repair for workflow ${workflowId}`, content_json: result });
        return { ok: Boolean(result.ok), data: result, summary: result.ok ? `Applied learning repair to workflow ${workflowId}.` : `Learning repair skipped for workflow ${workflowId}: ${result.reason || 'unknown'}` };
      },
    },
    {
      name: 'browser.navigate',
      description: 'Navigates the target with Playwright when available, otherwise falls back to HTTP. Captures browser/DOM summary, network events, and screenshot artifact for the right-side visual testing panel.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          timeout_ms: { type: 'number' },
        },
      },
      side_effects: ['creates browser_state artifact', 'captures network events'],
      handler: async (input, context) => {
        const run = await context.repo.getRun(context.scanRunId);
        if (!run) throw new Error(`AI scan run not found: ${context.scanRunId}`);
        const url = String(input.url || run.base_url);
        const result = await navigateWithOptionalBrowser({ url, repo: context.repo, scanRunId: context.scanRunId, taskId: context.taskId, timeout_ms: Number(input.timeout_ms || 45000) });
        return { ok: result.ok, data: result as unknown as Record<string, any>, summary: `${result.mode} navigation ${result.ok ? 'completed' : 'failed'} for ${url}`, error: result.error };
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
        const result = await discoverTargetFromHttp(run.base_url, { max_pages: Number(input.max_pages ?? run.scan_config?.max_pages ?? 1000) });
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
        const allEndpointsForScoring = await context.repo.listEndpoints(context.scanRunId);
        const endpointsById = new Map(allEndpointsForScoring.map(endpoint => [endpoint.id, endpoint]));
        const candidateScore = (candidate: any): number => {
          const endpointText = (candidate.endpoint_ids || []).map((id: string) => {
            const endpoint = endpointsById.get(id);
            return endpoint ? `${endpoint.method} ${endpoint.path} ${endpoint.url || ''} ${endpoint.request_summary || ''} ${endpoint.feature_guess || ''}` : '';
          }).join(' ');
          const text = `${candidate.title || ''} ${candidate.reason || ''} ${endpointText}`.toLowerCase();
          let score = Number(candidate.confidence || 0);
          if (/uploadimage|walletimage|upload|download|dataoperate|ping|admin\/users|admin|orderdetail|order|withdraw|transfer|funds|wallet|cancelorder|payment|loginconfirm|send.*code|article|contact/.test(text)) score += 0.5;
          if (candidate.vuln_type === 'bola_idor' && /\/api\/(app\/)?login|clause|page browse|页面浏览/.test(text)) score -= 0.6;
          if (candidate.vuln_type === 'bola_idor' && /order|withdraw|transfer|wallet|user\/.+address|record|cancel/.test(text)) score += 0.9;
          if (candidate.vuln_type === 'bfla' && /admin\/users|admin|manage|role|permission/.test(text)) score += 0.9;
          if (candidate.vuln_type === 'business_logic' && /order|cart|exchange|cancel|withdraw|transfer|amount|quantity|payment/.test(text)) score += 0.7;
          if (/placeholder|common|通用/.test(text)) score -= 0.2;
          return score;
        };
        const candidates = (await context.repo.listCandidates(context.scanRunId)).sort((a, b) => candidateScore(b) - candidateScore(a));
        const features = await context.repo.listFeatures(context.scanRunId);
        const endpointsAll = await context.repo.listEndpoints(context.scanRunId);
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
        const selectedGroups = selectedCanonical
          .map(type => ({ type, candidates: candidates.filter(candidate => shouldMapCandidateToSelected(candidate.vuln_type, [type])) }))
          .filter(group => group.candidates.length > 0);

        for (const group of selectedGroups) {
          const planned = group.candidates.slice(0, maxTasksPerType > 0 ? maxTasksPerType : group.candidates.length);
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
            endpoint_ids: Array.from(new Set(planned.flatMap(candidate => candidate.endpoint_ids || []))),
            agent_goal: `主 Agent 已为 ${group.type} 专项测试建立持久化 Campaign。该 Campaign 不是单个粗粒度测试任务，而是承载多个功能/子功能子 Agent 的父级任务。`,
            execution_plan: {
              role: 'campaign_parent',
              selected_vuln_type: group.type,
              planned_candidate_ids: planned.map(candidate => candidate.id),
              orchestration: 'parent_campaign_with_parallel_feature_subagents_and_summary',
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
              selected_candidates: planned.map(candidate => ({
                id: candidate.id,
                title: candidate.title,
                reason: candidate.reason,
                confidence: candidate.confidence,
                feature_id: candidate.feature_id,
                feature_name: candidateFeatureName(candidate),
                endpoint_ids: candidate.endpoint_ids,
              })),
            },
          });

          const childTasks: AIScanTask[] = [];
          for (const candidate of planned) {
            const feature = features.find(item => item.id === candidate.feature_id);
            const functionName = candidateFeatureName(candidate);
            let endpointContext = buildWorkflowEndpointContext({ allEndpoints: endpointsAll, selectedEndpointIds: candidate.endpoint_ids, vulnType: candidate.vuln_type }).map(endpoint => endpoint.id);
            const requiresSharedIdentity = ['bola_idor', 'bfla', 'business_logic', 'auth_otp', 'email_sms_bypass', 'passcode_bypass', 'replay_race'].includes(candidate.vuln_type);
            if (requiresSharedIdentity && sharedLoginEndpointIds.length) endpointContext = Array.from(new Set([...sharedLoginEndpointIds, ...endpointContext]));
            const taskType = taskTypeForCandidate(candidate);
            const key = `${taskType}:${candidate.vuln_type}:${candidate.feature_id || ''}:${endpointContext.join(',')}`;
            if (existingKeys.has(key)) continue;
            const createdTask = await context.repo.createTask({
              scan_run_id: context.scanRunId,
              parent_task_id: campaign.id,
              title: `${group.type} 子 Agent：测试功能点「${feature?.name || functionName}」`,
              task_type: taskType,
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
                strategy: candidate.vuln_type === 'file_upload' ? 'subagent_normal_upload_mutation_post_access_native_gate' : 'subagent_baseline_mutation_native_gate',
                vuln_type: candidate.vuln_type,
                parallel_group: `${group.type}:${candidate.feature_id || candidate.id}`,
                parallel_capable: true,
                recommended_agent_role: `${candidate.vuln_type}-feature-subagent`,
                requires_identity_context: ['bola_idor', 'bfla', 'business_logic', 'auth_otp', 'email_sms_bypass', 'passcode_bypass', 'replay_race'].includes(candidate.vuln_type),
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
        return {
          ok: true,
          data: {
            created_tasks_count: createdTasks.length,
            created_tasks: createdTasks,
            campaign_tasks_count: campaignTasks.length,
            campaign_tasks: campaignTasks,
            summary_tasks_count: summaryTasks.length,
            summary_tasks: summaryTasks,
          },
          summary: `Created ${createdTasks.length} feature/sub-feature sub-agent tasks under ${campaignTasks.length} vulnerability campaigns, plus ${summaryTasks.length} campaign summary tasks.`,
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
        const findings = await dbAll<any>(context.db, `SELECT id, title, severity, request_evidence, response_evidence, ai_analysis, response_body, created_at FROM findings WHERE source_type = 'ai_scan' ORDER BY created_at ASC`);
        const campaignFindings = findings.filter(finding => {
          const haystack = `${finding.title || ''} ${finding.request_evidence || ''} ${finding.response_evidence || ''} ${finding.ai_analysis || ''} ${finding.response_body || ''}`.toLowerCase();
          return haystack.includes(vulnType.toLowerCase()) || haystack.includes(campaignTaskId.toLowerCase()) || childTaskIds.some(id => haystack.includes(id.toLowerCase()));
        });
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
        const task = context.taskId ? await context.repo.getTask(context.taskId) : null;
        if (!task) throw new Error('bstg.file_upload.run_test requires an active task');
        const endpoints = await context.repo.listEndpoints(context.scanRunId);
        const endpoint = endpointById(endpoints, String(input.endpoint_id));
        if (!endpoint) throw new Error(`Endpoint not found: ${input.endpoint_id}`);
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
        const task = context.taskId ? await context.repo.getTask(context.taskId) : null;
        if (!task) throw new Error('bstg.generic_vuln.run_test requires an active task');
        const endpoints = await context.repo.listEndpoints(context.scanRunId);
        const requestedIds = Array.isArray(input.endpoint_ids) && input.endpoint_ids.length ? input.endpoint_ids.map(String) : (task.endpoint_ids || []);
        const relatedEndpoints = requestedIds.map(id => endpointById(endpoints, id)).filter(Boolean) as AIDiscoveredEndpoint[];
        const endpoint = endpointById(endpoints, String(input.endpoint_id || requestedIds[requestedIds.length - 1] || task.endpoint_ids[0]));
        if (!endpoint) throw new Error(`Endpoint not found: ${input.endpoint_id || requestedIds.join(',')}`);
        await markSharedResourcesUsed({ repo: context.repo, scanRunId: context.scanRunId, refs: Object.values(task.execution_plan?.shared_resource_refs || {}).filter(Boolean) as string[] });
        const result = await runGenericVulnerabilityTask({ db: context.db, repo: context.repo, task, endpoint, endpoints: relatedEndpoints.length ? relatedEndpoints : [endpoint] });
        return {
          ok: true,
          data: result,
          summary: `${task.vuln_type || 'generic'} test completed with verdict ${result.judge?.verdict || 'unknown'}.`,
        };
      },
    },
  ];
}
