import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import { executeTemplateRun } from '../services/template-runner.js';
import { executeWorkflowRun } from '../services/workflow-runner.js';
import { executeGateRun } from '../services/gate-runner.js';

const router = Router();

router.post('/template', async (req: Request, res: Response) => {
  try {
    const { template_ids, account_ids, environment_id, test_run_id } = req.body;

    if (!template_ids || !Array.isArray(template_ids) || template_ids.length === 0) {
      res.status(400).json({ data: null, error: 'template_ids is required and must be a non-empty array' });
      return;
    }

    let runId = test_run_id;

    if (!runId) {
      const db = dbManager.getActive();
      const testRun = await db.repos.testRuns.create({
        status: 'pending',
        execution_type: 'template',
        template_ids,
        account_ids,
        environment_id,
        progress: { total: 0, completed: 0, findings: 0 },
        progress_percent: 0,
      } as any);
      runId = testRun.id;
    }

    const result = await executeTemplateRun({
      test_run_id: runId,
      template_ids,
      account_ids: account_ids || [],
      environment_id,
    });

    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/workflow', async (req: Request, res: Response) => {
  try {
    const { workflow_id, account_ids, environment_id, test_run_id } = req.body;

    if (!workflow_id) {
      res.status(400).json({ data: null, error: 'workflow_id is required' });
      return;
    }

    let runId = test_run_id;

    if (!runId) {
      const db = dbManager.getActive();
      const testRun = await db.repos.testRuns.create({
        status: 'pending',
        execution_type: 'workflow',
        workflow_id,
        account_ids,
        environment_id,
        progress: { total: 0, completed: 0, findings: 0 },
        progress_percent: 0,
      } as any);
      runId = testRun.id;
    }

    const result = await executeWorkflowRun({
      test_run_id: runId,
      workflow_id,
      account_ids: account_ids || [],
      environment_id,
    });

    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/gate', async (req: Request, res: Response) => {
  try {
    const { policy_id, template_ids, workflow_ids, account_ids, environment_id, metadata } = req.body;

    if ((!template_ids || template_ids.length === 0) && (!workflow_ids || workflow_ids.length === 0)) {
      res.status(400).json({
        data: null,
        error: 'At least one template_id or workflow_id is required',
        exit_code: 4,
      });
      return;
    }

    const result = await executeGateRun({
      policy_id,
      template_ids: template_ids || [],
      workflow_ids: workflow_ids || [],
      account_ids: account_ids || [],
      environment_id,
      metadata,
    });

    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(500).json({
      data: null,
      error: error.message,
      exit_code: 3,
      gate_result: 'BLOCK',
    });
  }
});

export default router;
