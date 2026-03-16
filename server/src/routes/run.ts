import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import { executeTemplateRun } from '../services/template-runner.js';
import { executeWorkflowRun } from '../services/workflow-runner.js';
import { executeGateRun } from '../services/gate-runner.js';
import { getSecuritySuiteLaunchConfig } from '../services/security-suite.js';

const router = Router();

function parseIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(v => String(v)).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map(v => String(v)).filter(Boolean);
      }
    } catch {
    }
  }
  return [];
}

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

router.post('/suite', async (req: Request, res: Response) => {
  try {
    const { suite_id, execution_mode, workflow_id, name } = req.body;

    if (!suite_id) {
      res.status(400).json({ data: null, error: 'suite_id is required' });
      return;
    }

    const db = dbManager.getActive();
    const launchConfig = await getSecuritySuiteLaunchConfig(db, suite_id, execution_mode, workflow_id);

    if (!launchConfig.environment?.id) {
      res.status(400).json({
        data: null,
        error: `Security suite "${launchConfig.suite.name}" must have a valid environment before it can run`,
      });
      return;
    }

    const suiteExecutionParams = {
      source: 'security_suite',
      security_suite: {
        id: launchConfig.suite.id,
        name: launchConfig.suite.name,
        checklist_ids: launchConfig.checklist_ids,
        security_rule_ids: launchConfig.security_rule_ids,
        workflow_ids: launchConfig.workflow_ids,
        selected_workflow_id: launchConfig.workflow_id,
      },
    };

    if (launchConfig.execution_mode === 'template') {
      const testRun = await db.repos.testRuns.create({
        name: name || `Suite: ${launchConfig.suite.name} - ${new Date().toLocaleString()}`,
        status: 'pending',
        execution_type: 'template',
        trigger_type: 'security_suite',
        template_ids: launchConfig.template_ids,
        account_ids: launchConfig.account_ids,
        environment_id: launchConfig.environment.id,
        rule_ids: [],
        execution_params: suiteExecutionParams,
        progress: { total: 0, completed: 0, findings: 0 },
        progress_percent: 0,
        started_at: new Date().toISOString(),
      } as any);

      const result = await executeTemplateRun({
        test_run_id: testRun.id,
        template_ids: launchConfig.template_ids,
        account_ids: launchConfig.account_ids,
        environment_id: launchConfig.environment.id,
      });

      res.json({
        data: {
          ...result,
          suite_id: launchConfig.suite.id,
          suite_name: launchConfig.suite.name,
          execution_mode: launchConfig.execution_mode,
          warnings: launchConfig.warnings,
        },
        error: null,
      });
      return;
    }

    const testRun = await db.repos.testRuns.create({
      name: name || `Suite Workflow: ${launchConfig.suite.name} - ${new Date().toLocaleString()}`,
      status: 'pending',
      execution_type: 'workflow',
      trigger_type: 'security_suite',
      workflow_id: launchConfig.workflow_id,
      template_ids: [],
      account_ids: launchConfig.account_ids,
      environment_id: launchConfig.environment.id,
      rule_ids: [],
      execution_params: suiteExecutionParams,
      progress: { total: 0, completed: 0, findings: 0 },
      progress_percent: 0,
      started_at: new Date().toISOString(),
    } as any);

    const result = await executeWorkflowRun({
      test_run_id: testRun.id,
      workflow_id: launchConfig.workflow_id!,
      account_ids: launchConfig.account_ids,
      environment_id: launchConfig.environment.id,
    });

    res.json({
      data: {
        ...result,
        suite_id: launchConfig.suite.id,
        suite_name: launchConfig.suite.name,
        execution_mode: launchConfig.execution_mode,
        workflow_id: launchConfig.workflow_id,
        warnings: launchConfig.warnings,
      },
      error: null,
    });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/preset', async (req: Request, res: Response) => {
  try {
    const { preset_id, account_ids, environment_id, name } = req.body;

    if (!preset_id) {
      res.status(400).json({ data: null, error: 'preset_id is required' });
      return;
    }

    const db = dbManager.getActive();
    const preset = await db.repos.testRunPresets.findById(preset_id);
    if (!preset) {
      res.status(404).json({ data: null, error: `Test run preset not found: ${preset_id}` });
      return;
    }

    const executionAccountIds = parseIdList(account_ids);
    const finalAccountIds = executionAccountIds.length > 0
      ? executionAccountIds
      : (preset.default_account_id ? [preset.default_account_id] : []);
    const finalEnvironmentId = environment_id || preset.environment_id;

    const testRun = await db.repos.testRuns.create({
      name: name || preset.name,
      status: 'pending',
      execution_type: 'template',
      trigger_type: 'preset',
      template_ids: [preset.template_id],
      account_ids: finalAccountIds,
      environment_id: finalEnvironmentId,
      rule_ids: [],
      execution_params: {
        source: 'test_run_preset',
        preset: {
          id: preset.id,
          name: preset.name,
          source_draft_id: preset.source_draft_id,
          preset_config: preset.preset_config,
        },
      },
      source_recording_session_id: preset.preset_config?.source_recording_session_id,
      progress: { total: 0, completed: 0, findings: 0 },
      progress_percent: 0,
      started_at: new Date().toISOString(),
    } as any);

    const result = await executeTemplateRun({
      test_run_id: testRun.id,
      template_ids: [preset.template_id],
      account_ids: finalAccountIds,
      environment_id: finalEnvironmentId,
    });

    res.json({
      data: {
        ...result,
        preset_id: preset.id,
        preset_name: preset.name,
      },
      error: null,
    });
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

    const templateIds = parseIdList(suiteConfig.template_ids);
    const workflowIds = parseIdList(suiteConfig.workflow_ids);
    const accountIds = parseIdList(suiteConfig.account_ids);
    const checklistIds = parseIdList((suiteConfig as any).checklist_ids);
    const securityRuleIds = parseIdList((suiteConfig as any).security_rule_ids);

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
        checklist_ids: checklistIds,
        security_rule_ids: securityRuleIds,
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
