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

router.post('/gate-by-suite', async (req: Request, res: Response) => {
  try {
    const { suite, env, git_sha, pipeline_url } = req.body;

    if (!suite || !env) {
      res.status(400).json({
        data: null,
        error: 'suite and env are required',
        exit_code: 4,
      });
      return;
    }

    const db = dbManager.getActive();

    const suites = await db.repos.securitySuites.findAll({ where: { name: suite, is_enabled: 1 } as any });
    if (!suites || suites.length === 0) {
      res.status(404).json({
        data: null,
        error: `Security suite not found or disabled: ${suite}`,
        exit_code: 4,
      });
      return;
    }

    const suiteConfig = suites[0];

    let environmentId = suiteConfig.environment_id;
    if (!environmentId && (suiteConfig.environment_name || env)) {
      const envName = suiteConfig.environment_name || env;
      const envs = await db.repos.environments.findAll({ where: { name: envName } as any });
      if (envs && envs.length > 0) {
        environmentId = envs[0].id;
      }
    }

    if (!environmentId) {
      const envs = await db.repos.environments.findAll({ where: { name: env } as any });
      if (envs && envs.length > 0) {
        environmentId = envs[0].id;
      }
    }

    const templateIds = Array.isArray(suiteConfig.template_ids) ? suiteConfig.template_ids : JSON.parse(suiteConfig.template_ids || '[]');
    const workflowIds = Array.isArray(suiteConfig.workflow_ids) ? suiteConfig.workflow_ids : JSON.parse(suiteConfig.workflow_ids || '[]');
    const accountIds = Array.isArray(suiteConfig.account_ids) ? suiteConfig.account_ids : JSON.parse(suiteConfig.account_ids || '[]');

    if (templateIds.length === 0 && workflowIds.length === 0) {
      res.status(400).json({
        data: null,
        error: `Suite ${suite} has no templates or workflows configured`,
        exit_code: 4,
      });
      return;
    }

    const result = await executeGateRun({
      policy_id: suiteConfig.policy_id,
      template_ids: templateIds,
      workflow_ids: workflowIds,
      account_ids: accountIds,
      environment_id: environmentId,
      metadata: {
        suite,
        env,
        git_sha,
        pipeline_url,
      },
    });

    const weightedScore = (result.details?.test_weighted_score || 0) + (result.details?.workflow_weighted_score || 0);

    const standardizedResult = {
      decision: result.gate_result,
      exit_code: result.exit_code,
      test_run_findings: result.test_findings_count,
      workflow_findings: result.workflow_findings_count,
      weighted_score: weightedScore,
      security_run_id: result.security_run_id,
      summary: result.errors && result.errors.length > 0 ? result.errors.join('; ') : undefined,
      raw_details: result.details,
    };

    res.json({ data: standardizedResult, error: null });
  } catch (error: any) {
    res.status(500).json({
      data: null,
      error: error.message,
      exit_code: 3,
      gate_result: 'BLOCK',
    });
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

    const weightedScore = (result.details?.test_weighted_score || 0) + (result.details?.workflow_weighted_score || 0);

    const standardizedResult = {
      decision: result.gate_result,
      exit_code: result.exit_code,
      test_run_findings: result.test_findings_count,
      workflow_findings: result.workflow_findings_count,
      weighted_score: weightedScore,
      security_run_id: result.security_run_id,
      summary: result.errors && result.errors.length > 0 ? result.errors.join('; ') : undefined,
      raw_details: result.details,
    };

    res.json({ data: standardizedResult, error: null });
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
