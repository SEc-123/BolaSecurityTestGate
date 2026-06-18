import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import { AIScanAgentRuntime } from '../agent/agent-runtime.js';

const router = Router();

function runtime() {
  return new AIScanAgentRuntime(dbManager.getActive());
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('base_url is required');
  }
  const url = new URL(value.trim());
  return url.toString();
}

function selectedTypesFromBody(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item).trim()).filter(Boolean);
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
    const baseUrl = normalizeBaseUrl(req.body?.base_url);
    const selected = selectedTypesFromBody(req.body?.selected_vuln_types);
    const db = dbManager.getActive();

    const env = await db.repos.environments.create({
      name: req.body?.name || `AI Scan Target ${new URL(baseUrl).host}`,
      description: `Auto-created by AI Scan for ${baseUrl}`,
      base_url: baseUrl,
      is_active: true,
    } as any);

    const run = await repo.createRun({
      base_url: baseUrl,
      name: req.body?.name,
      user_prompt: req.body?.user_prompt || req.body?.prompt || '',
      selected_vuln_types: selected,
      scan_config: req.body?.scan_config || {},
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
    const selected = selectedTypesFromBody(req.body?.selected_vuln_types);
    if (selected.length === 0) {
      res.status(400).json({ data: null, error: 'selected_vuln_types must be a non-empty array' });
      return;
    }
    await repo.updateRun(scanRunId, { selected_vuln_types: selected, status: 'planning', current_phase: 'expanding_selected_vulnerabilities' });

    const tasks = await repo.listTasks(scanRunId);
    for (const task of tasks.filter(task => task.status === 'waiting_selection')) {
      await repo.updateTask(task.id, { status: 'completed', phase: 'selection_completed', result_summary: `Selected: ${selected.join(', ')}` });
    }

    await rt.expandSelectedVulnerabilities(scanRunId, selected);

    res.json({ data: await repo.getSnapshot(scanRunId), error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

export default router;
