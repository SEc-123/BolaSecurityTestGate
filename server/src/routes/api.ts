import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import { createCrudRouter } from './crud.js';
import { checkDropRules, previewDropRule } from '../services/drop-filter.js';
import { getGovernanceSettings, updateGovernanceSettings } from '../services/rate-limiter.js';
import { runRetentionCleanup } from '../services/retention-cleaner.js';
import { normalizeTemplateBaselineConfig } from '../services/baseline-normalize.js';
import dashboardRouter from './dashboard.js';
import debugRouter from './debug.js';

const router = Router();

router.use('/dashboard', dashboardRouter);
router.use('/debug', debugRouter);

router.use('/environments', createCrudRouter(() => dbManager.getActive().repos.environments));

router.use('/accounts', createCrudRouter(() => dbManager.getActive().repos.accounts));

router.use('/api-templates', createCrudRouter(
  () => dbManager.getActive().repos.apiTemplates,
  {
    beforeCreate: async (data) => {
      return normalizeTemplateBaselineConfig(data);
    },
    beforeUpdate: async (id, data) => {
      return normalizeTemplateBaselineConfig(data);
    },
  }
));

router.use('/workflows', createCrudRouter(
  () => dbManager.getActive().repos.workflows,
  {
    beforeCreate: async (data) => {
      if (data.mutation_profile) {
        validateMutationProfile(data.mutation_profile, data.id);
      }
      return data;
    },
    beforeUpdate: async (id, data) => {
      if (data.mutation_profile) {
        validateMutationProfile(data.mutation_profile, id);
      }
      return data;
    },
  }
));

function validateMutationProfile(profile: any, workflowId?: string): void {
  const cr = profile.concurrent_replay;
  const pg = profile.parallel_groups;

  if (cr) {
    if (typeof cr.step_order !== 'number' || cr.step_order < 1) {
      throw new Error('concurrent_replay.step_order must be a positive number');
    }

    if (typeof cr.concurrency !== 'number' || cr.concurrency < 2 || cr.concurrency > 50) {
      throw new Error('concurrent_replay.concurrency must be between 2 and 50');
    }

    if (cr.timeout_ms !== undefined && (typeof cr.timeout_ms !== 'number' || cr.timeout_ms < 100)) {
      throw new Error('concurrent_replay.timeout_ms must be at least 100ms');
    }

    if (cr.pick_primary !== undefined) {
      const validOptions = ['first_success', 'first', 'majority_success'];
      if (!validOptions.includes(cr.pick_primary)) {
        throw new Error(`concurrent_replay.pick_primary must be one of: ${validOptions.join(', ')}`);
      }
    }

    if (profile.skip_steps && profile.skip_steps.includes(cr.step_order)) {
      throw new Error(`concurrent_replay.step_order ${cr.step_order} cannot be in skip_steps`);
    }

    if (profile.repeat_steps && profile.repeat_steps[cr.step_order]) {
      throw new Error(`concurrent_replay.step_order ${cr.step_order} cannot be in repeat_steps`);
    }
  }

  if (pg) {
    if (!Array.isArray(pg)) {
      throw new Error('parallel_groups must be an array');
    }

    pg.forEach((group: any, idx: number) => {
      if (typeof group.anchor_step_order !== 'number' || group.anchor_step_order < 1) {
        throw new Error(`parallel_groups[${idx}].anchor_step_order must be a positive number`);
      }

      if (!Array.isArray(group.extras) || group.extras.length < 1) {
        throw new Error(`parallel_groups[${idx}].extras must be a non-empty array`);
      }

      if (group.timeout_ms !== undefined && (typeof group.timeout_ms !== 'number' || group.timeout_ms < 100)) {
        throw new Error(`parallel_groups[${idx}].timeout_ms must be at least 100ms`);
      }

      group.extras.forEach((extra: any, eIdx: number) => {
        if (!extra.request_snapshot_raw || typeof extra.request_snapshot_raw !== 'string') {
          throw new Error(`parallel_groups[${idx}].extras[${eIdx}].request_snapshot_raw must be a non-empty string`);
        }
        if (!extra.name || typeof extra.name !== 'string') {
          throw new Error(`parallel_groups[${idx}].extras[${eIdx}].name must be a non-empty string`);
        }
      });

      if (profile.skip_steps && profile.skip_steps.includes(group.anchor_step_order)) {
        throw new Error(`parallel_groups[${idx}].anchor_step_order ${group.anchor_step_order} cannot be in skip_steps`);
      }

      if (profile.repeat_steps && profile.repeat_steps[group.anchor_step_order]) {
        throw new Error(`parallel_groups[${idx}].anchor_step_order ${group.anchor_step_order} cannot be in repeat_steps`);
      }

      if (cr && cr.step_order === group.anchor_step_order) {
        throw new Error(`parallel_groups[${idx}].anchor_step_order ${group.anchor_step_order} conflicts with concurrent_replay.step_order`);
      }
    });

    const anchorSteps = pg.map((g: any) => g.anchor_step_order);
    const duplicates = anchorSteps.filter((step: number, idx: number) => anchorSteps.indexOf(step) !== idx);
    if (duplicates.length > 0) {
      throw new Error(`Duplicate anchor_step_order values in parallel_groups: ${duplicates.join(', ')}`);
    }
  }
}

router.get('/workflows/:id/full', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const workflow = await db.repos.workflows.findById(req.params.id);

    if (!workflow) {
      res.status(404).json({ data: null, error: 'Workflow not found' });
      return;
    }

    const steps = await db.repos.workflowSteps.findAll({ where: { workflow_id: workflow.id } as any });
    const variableConfigs = await db.repos.workflowVariableConfigs.findAll({ where: { workflow_id: workflow.id } as any });
    const extractors = await db.repos.workflowExtractors.findAll({ where: { workflow_id: workflow.id } as any });

    const stepsWithTemplates = await Promise.all(
      steps.map(async (step) => {
        const template = await db.repos.apiTemplates.findById(step.api_template_id);
        return { ...step, api_template: template };
      })
    );

    res.json({
      data: {
        ...workflow,
        steps: stepsWithTemplates.sort((a, b) => a.step_order - b.step_order),
        variable_configs: variableConfigs,
        extractors: extractors,
      },
      error: null,
    });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/workflows/:id/steps', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const steps = await db.repos.workflowSteps.findAll({ where: { workflow_id: req.params.id } as any });
    const stepsWithTemplates = await Promise.all(
      steps.map(async (step) => {
        const template = await db.repos.apiTemplates.findById(step.api_template_id);
        return { ...step, api_template: template };
      })
    );
    res.json({ data: stepsWithTemplates.sort((a, b) => a.step_order - b.step_order), error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.put('/workflows/:id/steps', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const workflowId = req.params.id;
    const { template_ids } = req.body;

    const workflow = await db.repos.workflows.findById(workflowId);
    const useSnapshot = workflow?.template_mode === 'snapshot' ||
                        workflow?.workflow_type === 'baseline' ||
                        workflow?.workflow_type === 'mutation';

    const existingSteps = await db.repos.workflowSteps.findAll({ where: { workflow_id: workflowId } as any });
    for (const step of existingSteps) {
      await db.repos.workflowSteps.delete(step.id);
    }

    if (!template_ids || template_ids.length === 0) {
      res.json({ data: [], error: null });
      return;
    }

    const newSteps = [];
    const now = new Date().toISOString();

    for (let i = 0; i < template_ids.length; i++) {
      const template = await db.repos.apiTemplates.findById(template_ids[i]);

      const stepData: any = {
        workflow_id: workflowId,
        api_template_id: template_ids[i],
        step_order: i + 1,
      };

      if (useSnapshot && template) {
        stepData.request_snapshot_raw = template.raw_request;
        stepData.failure_patterns_snapshot = template.failure_patterns;
        stepData.snapshot_template_name = template.name;
        stepData.snapshot_template_id = template.id;
        stepData.snapshot_created_at = now;
      }

      const step = await db.repos.workflowSteps.create(stepData);
      newSteps.push({ ...step, api_template: template });
    }

    res.json({ data: newSteps, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/workflows/:id/variable-configs', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const configs = await db.repos.workflowVariableConfigs.findAll({ where: { workflow_id: req.params.id } as any });
    res.json({ data: configs, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.put('/workflows/:id/variable-configs', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const workflowId = req.params.id;
    const { configs } = req.body;

    const existingConfigs = await db.repos.workflowVariableConfigs.findAll({ where: { workflow_id: workflowId } as any });
    for (const config of existingConfigs) {
      await db.repos.workflowVariableConfigs.delete(config.id);
    }

    if (!configs || configs.length === 0) {
      res.json({ data: [], error: null });
      return;
    }

    const newConfigs = [];
    for (const config of configs) {
      const created = await db.repos.workflowVariableConfigs.create({
        ...config,
        workflow_id: workflowId,
      } as any);
      newConfigs.push(created);
    }

    res.json({ data: newConfigs, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/workflows/:id/extractors', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const extractors = await db.repos.workflowExtractors.findAll({ where: { workflow_id: req.params.id } as any });
    res.json({ data: extractors.sort((a, b) => a.step_order - b.step_order), error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.put('/workflows/:id/extractors', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const workflowId = req.params.id;
    const { extractors } = req.body;

    const existingExtractors = await db.repos.workflowExtractors.findAll({ where: { workflow_id: workflowId } as any });
    for (const extractor of existingExtractors) {
      await db.repos.workflowExtractors.delete(extractor.id);
    }

    if (!extractors || extractors.length === 0) {
      res.json({ data: [], error: null });
      return;
    }

    const newExtractors = [];
    for (const extractor of extractors) {
      const created = await db.repos.workflowExtractors.create({
        ...extractor,
        workflow_id: workflowId,
      } as any);
      newExtractors.push(created);
    }

    res.json({ data: newExtractors, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.use('/workflow-steps', createCrudRouter(() => dbManager.getActive().repos.workflowSteps));

router.put('/workflow-steps/:id/assertions', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const { assertions, assertions_mode } = req.body;
    const updated = await db.repos.workflowSteps.update(req.params.id, {
      step_assertions: assertions,
      assertions_mode: assertions_mode,
    } as any);
    res.json({ data: updated ? [updated] : [], error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.use('/workflow-variable-configs', createCrudRouter(() => dbManager.getActive().repos.workflowVariableConfigs));

router.use('/workflow-extractors', createCrudRouter(() => dbManager.getActive().repos.workflowExtractors));

router.use('/checklists', createCrudRouter(() => dbManager.getActive().repos.checklists));

router.use('/security-rules', createCrudRouter(() => dbManager.getActive().repos.securityRules));

router.use('/test-runs', createCrudRouter(() => dbManager.getActive().repos.testRuns));

router.use('/findings', createCrudRouter(() => dbManager.getActive().repos.findings));

router.use('/gate-policies', createCrudRouter(() => dbManager.getActive().repos.cicdGatePolicies));

router.use('/security-runs', createCrudRouter(() => dbManager.getActive().repos.securityRuns));

router.use('/suppression-rules', createCrudRouter(() => dbManager.getActive().repos.findingSuppressionRules));

router.use('/drop-rules', createCrudRouter(() => dbManager.getActive().repos.findingDropRules));

router.post('/drop-rules/preview', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const { method, path, service_id, template_id, workflow_id, source_type } = req.body;

    const rules = await db.repos.findingDropRules.findAll();
    const result = checkDropRules(rules, {
      method: method || 'GET',
      path: path || '/',
      requestRaw: service_id ? `Service-Id: ${service_id}` : '',
      templateId: template_id,
      workflowId: workflow_id,
      sourceType: source_type || 'test_run',
    });

    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/governance/settings', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const settings = await getGovernanceSettings(db);
    res.json({ data: settings, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.put('/governance/settings', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();

    let oldIntervalValue: number | null = null;
    if ('cleanup_interval_hours' in req.body) {
      const oldSettings = await getGovernanceSettings(db);
      oldIntervalValue = oldSettings.cleanup_interval_hours;
    }

    const settings = await updateGovernanceSettings(db, req.body);

    if (
      oldIntervalValue !== null &&
      oldIntervalValue !== settings.cleanup_interval_hours &&
      !process.env.CLEANUP_INTERVAL_HOURS
    ) {
      const scheduler = (globalThis as any).__cleanupScheduler;
      if (scheduler?.reset) {
        await scheduler.reset();
      }
    }

    res.json({ data: settings, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/governance/cleanup', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const result = await runRetentionCleanup(db);
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/template-variables/search', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const { search_type, pattern, scopes, match_mode } = req.body;

    const templates = await db.repos.apiTemplates.findAll();
    const matches: any[] = [];

    for (const template of templates) {
      const variables = template.variables || [];
      for (const variable of variables) {
        let isMatch = false;

        if (search_type === 'keyword') {
          const searchIn = scopes.includes('body') ? variable.json_path || '' : '';
          isMatch = match_mode === 'exact'
            ? searchIn === pattern
            : searchIn.toLowerCase().includes(pattern.toLowerCase());
        } else if (search_type === 'jsonpath') {
          isMatch = variable.json_path === pattern;
        } else if (search_type === 'header_key' && scopes.includes('header')) {
          isMatch = variable.location === 'header' && (
            match_mode === 'exact'
              ? variable.name === pattern
              : variable.name?.toLowerCase().includes(pattern.toLowerCase())
          );
        } else if (search_type === 'query_param' && scopes.includes('query')) {
          isMatch = variable.location === 'query' && (
            match_mode === 'exact'
              ? variable.name === pattern
              : variable.name?.toLowerCase().includes(pattern.toLowerCase())
          );
        }

        if (isMatch) {
          matches.push({
            template_id: template.id,
            template_name: template.name,
            variable_name: variable.name,
            json_path: variable.json_path,
            location: variable.location,
            current_value: variable.default_value,
          });
        }
      }
    }

    res.json({ data: { matches, total_count: matches.length }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/template-variables/bulk-update', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const { selected_matches, patch, dry_run } = req.body;

    const templateGroups = new Map<string, any[]>();
    for (const match of selected_matches) {
      if (!templateGroups.has(match.template_id)) {
        templateGroups.set(match.template_id, []);
      }
      templateGroups.get(match.template_id)!.push(match);
    }

    const updates: any[] = [];
    let affectedCount = 0;

    for (const [templateId, matches] of templateGroups) {
      const template = await db.repos.apiTemplates.findById(templateId);
      if (!template) continue;

      const variables = [...(template.variables || [])];
      let hasChanges = false;

      for (const match of matches) {
        const varIndex = variables.findIndex((v: any) => v.name === match.variable_name);
        if (varIndex === -1) continue;

        if (patch.new_value !== undefined) {
          variables[varIndex] = { ...variables[varIndex], default_value: patch.new_value };
          hasChanges = true;
          affectedCount++;
        }
      }

      if (hasChanges) {
        if (!dry_run) {
          await db.repos.apiTemplates.update(templateId, { variables } as any);
        }
        updates.push({ template_id: templateId, template_name: template.name, changes: matches.length });
      }
    }

    res.json({
      data: {
        success: true,
        dry_run,
        affected_count: affectedCount,
        updated_templates: updates.length,
        updates,
      },
      error: null,
    });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

export default router;
