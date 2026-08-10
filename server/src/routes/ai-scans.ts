import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import { AIScanAgentRuntime } from '../agent/agent-runtime.js';
import { localText, requestLanguage } from '../services/i18n/language.js';
import { normalizeTargetBaseUrl } from '../services/ai-scan/target-scope.js';
import { normalizeScanTrafficLimits, getScanTrafficSnapshot } from '../services/ai-scan/scan-traffic-governor.js';
import { listEvidenceContracts } from '../services/ai-scan/evidence-contracts.js';
import { normalizePlannerAutonomyConfig } from '../agent/bounded-autonomy.js';
import { closePersistentBrowserContext } from '../services/ai-scan/browser/persistent-browser-runtime.js';
import { rememberAgentObservation } from '../services/ai-scan/agent-memory.js';

const router = Router();

function runtime() {
  return new AIScanAgentRuntime(dbManager.getActive());
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('base_url is required');
  return normalizeTargetBaseUrl(value);
}

function selectedTypesFromBody(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item).trim()).filter(Boolean);
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


function hasConfiguredManualAccounts(config: any): boolean {
  return Boolean(config?.accounts && typeof config.accounts === 'object' && Object.keys(config.accounts).length > 0);
}

function hasRawAccountRequests(config: any): boolean {
  if (Array.isArray(config?.account_raw_requests)) return config.account_raw_requests.length > 0;
  return typeof config?.account_raw_requests === 'string' && config.account_raw_requests.trim().length > 0;
}

function normalizeScanConfig(value: any): Record<string, any> {
  const config = value && typeof value === 'object' ? { ...value } : {};
  const inferredAccountMode = config.account_mode || (hasConfiguredManualAccounts(config) ? 'manual' : hasRawAccountRequests(config) ? 'raw' : 'auto_execute');
  config.account_mode = inferredAccountMode;
  if (config.enable_account_auto_execution === undefined) {
    config.enable_account_auto_execution = inferredAccountMode === 'auto_execute';
  }
  if (config.enable_autonomous_account_discovery === undefined) {
    config.enable_autonomous_account_discovery = inferredAccountMode === 'auto_execute' || inferredAccountMode === 'autonomous';
  }
  if (!Array.isArray(config.auto_account_roles) || config.auto_account_roles.length === 0) {
    config.auto_account_roles = ['attacker', 'victim', 'admin'];
  }
  if (config.account_bootstrap_max_pages === undefined) {
    config.account_bootstrap_max_pages = 40;
  }
  config.traffic_budget = normalizeScanTrafficLimits(config.traffic_budget);
  const requestedLifecycle = config.asset_lifecycle && typeof config.asset_lifecycle === 'object' ? config.asset_lifecycle : {};
  config.asset_lifecycle = {
    auto_cleanup: requestedLifecycle.auto_cleanup === true,
    default_status: requestedLifecycle.default_status === 'reusable' ? 'reusable' : 'ephemeral',
  };
  if (!Array.isArray(config.allowed_tool_capabilities) || config.allowed_tool_capabilities.length === 0) {
    config.allowed_tool_capabilities = ['read', 'control_plane', 'active_test'];
  }
  if (!Array.isArray(config.allowed_tool_side_effect_levels) || config.allowed_tool_side_effect_levels.length === 0) {
    config.allowed_tool_side_effect_levels = ['none', 'metadata', 'target_read', 'target_mutation', 'target_destructive'];
  }
  const memoryConfig = config.agent_memory && typeof config.agent_memory === 'object' ? config.agent_memory : {};
  config.agent_memory = {
    max_context_memories: Math.max(4, Math.min(50, Number(memoryConfig.max_context_memories || 20))),
    default_ttl_seconds: Math.max(300, Math.min(604800, Number(memoryConfig.default_ttl_seconds || 86400))),
  };
  const browserConfig = config.browser_runtime && typeof config.browser_runtime === 'object' ? config.browser_runtime : {};
  config.browser_runtime = {
    persist_contexts: browserConfig.persist_contexts !== false,
    default_scope: ['scan', 'task'].includes(browserConfig.default_scope) ? browserConfig.default_scope : 'task',
    context_ttl_seconds: Math.max(60, Math.min(86400, Number(browserConfig.context_ttl_seconds || 3600))),
  };
  const requestedAutonomy = config.planner_autonomy && typeof config.planner_autonomy === 'object' ? config.planner_autonomy : {};
  config.planner_autonomy = normalizePlannerAutonomyConfig({
    planner_autonomy: {
      ...requestedAutonomy,
      mode: requestedAutonomy.mode || ((config.driving_mode === 'autopilot' || config.auto_start === true) ? 'bounded_ai' : 'local_only'),
    },
  });
  return config;
}

function isAutopilotScan(config: any): boolean {
  return config?.driving_mode === 'autopilot' || config?.auto_start === true || config?.selected_scope_strategy === 'all_vulnerability_types';
}

router.get('/tools', async (req: Request, res: Response) => {
  try {
    const tools = runtime().listTools(String(req.query.q || '')).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      side_effects: tool.side_effects || [],
      runtime: tool.runtime,
    }));
    res.json({ data: tools, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/', async (_req: Request, res: Response) => {
  try {
    const rt = runtime();
    const runs = await rt.getRepository().listRuns();
    res.json({ data: runs, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const rt = runtime();
    const repo = rt.getRepository();
    const baseUrl = normalizeBaseUrl(req.body?.base_url);
    const scanConfig = normalizeScanConfig(req.body?.scan_config || {});
    const language = requestLanguage({ body: req.body, query: req.query, headers: req.headers as any });
    const selectedFromBody = selectedTypesFromBody(req.body?.selected_vuln_types);
    const selected = selectedFromBody.length > 0 ? selectedFromBody : (isAutopilotScan(scanConfig) ? ALL_VULN_TYPES : []);
    const db = dbManager.getActive();

    const env = await db.repos.environments.create({
      name: req.body?.name || `AI Scan Target ${new URL(baseUrl).host}`,
      description: localText(language, `Auto-created by AI Scan for ${baseUrl}`, `AI 扫描自动创建：${baseUrl}`),
      base_url: baseUrl,
      is_active: true,
    } as any);

    const run = await repo.createRun({
      base_url: baseUrl,
      name: req.body?.name,
      user_prompt: req.body?.user_prompt || req.body?.prompt || '',
      language,
      selected_vuln_types: selected,
      scan_config: scanConfig,
      environment_id: env.id,
    });
    await repo.registerGeneratedAsset({ scan_run_id: run.id, asset_type: 'environment', asset_id: env.id, metadata_json: { source: 'ai_scan_create', base_url: baseUrl } });

    await rt.bootstrapRun(run);
    res.status(201).json({ data: await repo.getSnapshot(run.id), error: null });
  } catch (error: any) {
    res.status(400).json({ data: null, error: error.message });
  }
});

router.get('/meta/evidence-contracts', async (_req: Request, res: Response) => {
  res.json({ data: listEvidenceContracts(), error: null });
});

router.get('/:id/memories', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const memories = await repo.listAgentMemories(String(req.params.id), { status: req.query.status ? String(req.query.status) : undefined, memory_type: req.query.type ? String(req.query.type) : undefined, include_expired: req.query.include_expired === 'true' });
    res.json({ data: memories, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.get('/:id/memories/:memoryId/revisions', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const scanRunId = String(req.params.id);
    const memory = await repo.getAgentMemory(String(req.params.memoryId));
    if (!memory || memory.scan_run_id !== scanRunId) return res.status(404).json({ data: null, error: 'Agent memory not found in this scan' });
    const revisions = await repo.listAgentMemoryRevisions(memory.id);
    res.json({ data: revisions, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.post('/:id/memories', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const scanRunId = String(req.params.id);
    const run = await repo.getRun(scanRunId);
    if (!run) return res.status(404).json({ data: null, error: `AI scan run not found: ${scanRunId}` });
    if (!req.body?.memory_type || !req.body?.memory_key || !req.body?.summary) return res.status(400).json({ data: null, error: 'memory_type, memory_key and summary are required' });
    const memory = await rememberAgentObservation({ repo, scanRunId, taskId: req.body?.task_id ? String(req.body.task_id) : undefined, memoryType: String(req.body.memory_type), memoryKey: String(req.body.memory_key), scopeType: req.body?.scope_type, scopeRef: req.body?.scope_ref ? String(req.body.scope_ref) : undefined, title: req.body?.title ? String(req.body.title) : undefined, summary: String(req.body.summary), content: req.body?.content && typeof req.body.content === 'object' ? req.body.content : {}, confidence: req.body?.confidence === undefined ? undefined : Number(req.body.confidence), ttlSeconds: req.body?.ttl_seconds === undefined ? Number(run.scan_config?.agent_memory?.default_ttl_seconds || 86400) : Number(req.body.ttl_seconds), dependsOn: Array.isArray(req.body?.depends_on) ? req.body.depends_on.map(String) : [], provenance: { source: 'ai_scan_api', operator_supplied: true } });
    res.status(201).json({ data: memory, error: null });
  } catch (error: any) {
    res.status(400).json({ data: null, error: error.message });
  }
});

router.get('/:id/browser-contexts', async (req: Request, res: Response) => {
  try {
    const contexts = await runtime().getRepository().listBrowserContexts(String(req.params.id));
    res.json({ data: contexts, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.post('/:id/browser-contexts/:contextKey/close', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const scanRunId = String(req.params.id);
    const contextKey = decodeURIComponent(String(req.params.contextKey));
    await closePersistentBrowserContext(repo, scanRunId, contextKey, 'closed');
    res.json({ data: { context_key: contextKey, status: 'closed' }, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.get('/:id/planner-decisions', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const decisions = await repo.listPlannerDecisions(String(req.params.id), req.query.task_id ? String(req.query.task_id) : undefined);
    res.json({ data: decisions, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.get('/:id/traffic', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const run = await repo.getRun(String(req.params.id));
    if (!run) throw new Error(`AI scan run not found: ${req.params.id}`);
    const persisted = await repo.getLatestTrafficSnapshot(run.id);
    res.json({ data: getScanTrafficSnapshot(run.id) || persisted || { scan_run_id: run.id, total_requests: 0, in_flight: 0, class_counts: {}, endpoint_counts: {}, limits: normalizeScanTrafficLimits(run.scan_config?.traffic_budget) }, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.get('/:id/generated-assets', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const status = req.query.status ? String(req.query.status) : undefined;
    if (status && !['ephemeral', 'reusable', 'promoted', 'cleaned'].includes(status)) {
      return res.status(400).json({ data: null, error: `Invalid generated asset lifecycle status: ${status}` });
    }
    const assets = await repo.listGeneratedAssets(String(req.params.id), status as any);
    res.json({ data: assets, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.post('/:id/generated-assets/:assetRegistryId/promote', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const asset = await repo.promoteGeneratedAsset(String(req.params.id), String(req.params.assetRegistryId));
    res.json({ data: asset, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.post('/:id/generated-assets/cleanup', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const scanRunId = String(req.params.id);
    const run = await repo.getRun(scanRunId);
    if (!run) return res.status(404).json({ data: null, error: `AI scan run not found: ${scanRunId}` });
    if (!['completed', 'failed'].includes(run.status)) {
      return res.status(409).json({ data: null, error: `Generated assets can only be cleaned after the scan reaches completed or failed status; current status is ${run.status}` });
    }
    const result = await repo.cleanupEphemeralGeneratedAssets(scanRunId);
    await repo.createArtifact({ scan_run_id: scanRunId, artifact_type: 'ai_generated_asset_cleanup', title: `Explicit AI generated asset cleanup: ${result.cleaned} cleaned`, content_json: result as unknown as Record<string, any> });
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const snapshot = await runtime().getRepository().getSnapshot(String(req.params.id));
    res.json({ data: snapshot, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    const maxSteps = req.body?.max_steps === undefined ? undefined : Number(req.body.max_steps);
    const maxParallelAgents = req.body?.max_parallel_agents === undefined ? undefined : Number(req.body.max_parallel_agents);
    const language = requestLanguage({ body: req.body, query: req.query, headers: req.headers as any });
    await runtime().getRepository().updateRun(String(req.params.id), { language } as any);
    const result = await runtime().run(String(req.params.id), { max_steps: maxSteps, max_parallel_agents: maxParallelAgents });
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/:id/select-vulns', async (req: Request, res: Response) => {
  try {
    const rt = runtime();
    const repo = rt.getRepository();
    const scanRunId = String(req.params.id);
    const language = requestLanguage({ body: req.body, query: req.query, headers: req.headers as any });
    const selected = selectedTypesFromBody(req.body?.selected_vuln_types);
    if (selected.length === 0) {
      res.status(400).json({ data: null, error: 'selected_vuln_types must be a non-empty array' });
      return;
    }
    await repo.updateRun(scanRunId, { selected_vuln_types: selected, language, status: 'planning', current_phase: 'expanding_selected_vulnerabilities' } as any);

    const tasks = await repo.listTasks(scanRunId);
    for (const task of tasks.filter(task => task.status === 'waiting_selection')) {
      await repo.updateTask(task.id, {
        status: 'completed',
        phase: 'selection_completed',
        result_summary: localText(language, `Selected: ${selected.join(', ')}`, `已选择：${selected.join(', ')}`),
      });
    }

    await rt.expandSelectedVulnerabilities(scanRunId, selected);

    res.json({ data: await repo.getSnapshot(scanRunId), error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

export default router;
