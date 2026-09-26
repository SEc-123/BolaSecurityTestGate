import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import { AIScanAgentRuntime } from '../agent/agent-runtime.js';
import { localText, requestLanguage } from '../services/i18n/language.js';
import { assertSafeHttpTarget } from '../services/security/target-policy.js';

const router = Router();

function runtime() {
  return new AIScanAgentRuntime(dbManager.getActive());
}

async function normalizeBaseUrl(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('base_url is required');
  }
  return assertSafeHttpTarget(value.trim(), 'AI scan base_url');
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
  'known_vulnerable_component',
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
    const baseUrl = await normalizeBaseUrl(req.body?.base_url);
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

    await rt.bootstrapRun(run);
    res.status(201).json({ data: await repo.getSnapshot(run.id), error: null });
  } catch (error: any) {
    res.status(400).json({ data: null, error: error.message });
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
