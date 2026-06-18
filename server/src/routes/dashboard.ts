import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';

const router = Router();

router.get('/summary', async (req: Request, res: Response) => {
  try {
    const provider = dbManager.getActive();
    const repos = provider.repos;

    const dbStatus = await dbManager.getStatus();

    const environmentsTotal = await repos.environments.count({} as any);
    const environmentsActive = await repos.environments.count({ is_active: 1 } as any);

    const accountsTotal = await repos.accounts.count({} as any);
    const accountsActive = await repos.accounts.count({ status: 'active' } as any);

    const templatesTotal = await repos.apiTemplates.count({} as any);
    const templatesActive = await repos.apiTemplates.count({ is_active: 1 } as any);

    const workflowsTotal = await repos.workflows.count({} as any);
    const baselineWorkflows = await repos.workflows.count({ workflow_type: 'baseline' } as any);
    const mutationWorkflows = await repos.workflows.count({ workflow_type: 'mutation' } as any);
    const baselineLearned = await repos.workflows.count({
      workflow_type: 'baseline',
      learning_status: 'learned'
    } as any);

    const gatePoliciesTotal = await repos.cicdGatePolicies.count({} as any);
    const gatePoliciesEnabled = await repos.cicdGatePolicies.count({ is_enabled: 1 } as any);

    const runsTotal = await repos.testRuns.count({} as any);
    const runsRunning = await repos.testRuns.count({ status: 'running' } as any);
    const runsCompleted = await repos.testRuns.count({ status: 'completed' } as any);
    const runsFailed = await repos.testRuns.count({ status: 'failed' } as any);
    const runsCompletedWithErrors = await repos.testRuns.count({
      status: 'completed',
      has_execution_error: 1
    } as any);

    const findingsTotal = await repos.findings.count({} as any);
    const findingsNew = await repos.findings.count({ status: 'new' } as any);
    const findingsConfirmed = await repos.findings.count({ status: 'confirmed' } as any);
    const findingsOpen = findingsNew + findingsConfirmed;

    const countOpenBySeverity = async (severity: string) => {
      const newCount = await repos.findings.count({ status: 'new', severity } as any);
      const confirmedCount = await repos.findings.count({ status: 'confirmed', severity } as any);
      return newCount + confirmedCount;
    };

    const findingsCritical = await countOpenBySeverity('critical');
    const findingsHigh = await countOpenBySeverity('high');
    const findingsMedium = await countOpenBySeverity('medium');
    const findingsLow = await countOpenBySeverity('low');
    const findingsInfo = await countOpenBySeverity('info');

    const allBaselines = await repos.workflows.findAll({
      where: { workflow_type: 'baseline' }
    });

    const baselineVersionMap = new Map<string, number>();
    allBaselines.forEach(b => {
      baselineVersionMap.set(b.id, b.learning_version || 0);
    });

    const allMutations = await repos.workflows.findAll({
      where: { workflow_type: 'mutation' }
    });

    const mutationMismatches: Array<{
      mutation_workflow_id: string;
      mutation_name: string;
      baseline_workflow_id: string;
      baseline_version: number;
      mutation_version: number;
    }> = [];

    allMutations.forEach(mut => {
      if (mut.base_workflow_id) {
        const baselineVersion = baselineVersionMap.get(mut.base_workflow_id) || 0;
        const mutationVersion = mut.learning_version || 0;
        if (baselineVersion !== mutationVersion) {
          mutationMismatches.push({
            mutation_workflow_id: mut.id,
            mutation_name: mut.name,
            baseline_workflow_id: mut.base_workflow_id,
            baseline_version: baselineVersion,
            mutation_version: mutationVersion,
          });
        }
      }
    });

    const recentRuns = await repos.testRuns.findAll({
      limit: 10,
    });

    const recentFindings = await repos.findings.findAll({
      limit: 10,
    });

    const summary = {
      db: {
        connected: dbStatus.connected,
        schemaVersion: dbStatus.schemaVersion,
        activeProfileName: dbStatus.activeProfileName,
        runningRunsCount: dbStatus.runningRunsCount,
      },

      counts: {
        environments: {
          total: environmentsTotal,
          active: environmentsActive,
        },
        accounts: {
          total: accountsTotal,
          active: accountsActive,
        },
        templates: {
          total: templatesTotal,
          active: templatesActive,
        },
        workflows: {
          total: workflowsTotal,
          baseline: baselineWorkflows,
          mutation: mutationWorkflows,
          baseline_learned: baselineLearned,
        },
        gatePolicies: {
          total: gatePoliciesTotal,
          enabled: gatePoliciesEnabled,
        },
      },

      runs: {
        total: runsTotal,
        running: runsRunning,
        completed: runsCompleted,
        failed: runsFailed,
        completed_with_errors: runsCompletedWithErrors,
      },

      findings: {
        total: findingsTotal,
        open: findingsOpen,
        bySeverity: {
          critical: findingsCritical,
          high: findingsHigh,
          medium: findingsMedium,
          low: findingsLow,
          info: findingsInfo,
        },
      },

      mutationHealth: {
        versionMismatchCount: mutationMismatches.length,
        mismatches: mutationMismatches,
      },

      recent: {
        runs: recentRuns,
        findings: recentFindings,
      },
    };

    res.json({ data: summary, error: null });
  } catch (error: any) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ data: null, error: error.message });
  }
});

export default router;
