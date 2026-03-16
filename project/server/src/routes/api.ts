import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import { createCrudRouter } from './crud.js';
import { checkDropRules, previewDropRule } from '../services/drop-filter.js';
import { getGovernanceSettings, updateGovernanceSettings } from '../services/rate-limiter.js';
import { runRetentionCleanup } from '../services/retention-cleaner.js';
import { normalizeTemplateBaselineConfig } from '../services/baseline-normalize.js';
import { parseRawRequest } from '../services/execution-utils.js';
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

router.use('/security-suites', createCrudRouter(() => dbManager.getActive().repos.securitySuites));

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
            group_name: template.group_name,
            method: template.parsed_structure?.method,
            path: template.parsed_structure?.path,
            variable_type: variable.location || 'body',
            variable_name: variable.name,
            json_path: variable.json_path,
            current_config: {
              operation_type: variable.operation_type,
              data_source: variable.data_source || 'original',
              checklist_id: variable.checklist_id,
              account_field_name: variable.account_field_name,
              security_rule_id: variable.security_rule_id,
              is_attacker_field: variable.is_attacker_field,
              path_replacement_mode: variable.path_replacement_mode,
              body_content_type: variable.body_content_type,
            },
            raw_snippet: variable.original_value,
          });
        }
      }
    }

    res.json({ data: { matches, total_count: matches.length }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

function normalizeJsonPath(jsonPath: string): string {
  let p = (jsonPath || "").trim();

  p = p.replace(/^\$\./, "");
  p = p.replace(/^body\./, "");
  p = p.replace(/^content\./, "");

  return p;
}

function setDeepValue(obj: any, path: string, value: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  if (!path) return false;

  const parts = path.split(".").filter(Boolean);

  let cur: any = obj;
  for (let i = 0; i < parts.length; i++) {
    let key = parts[i];

    const m = key.match(/^([^\[]+)\[(\d+)\]$/);
    if (m) {
      const arrKey = m[1];
      const idx = Number(m[2]);

      if (!cur[arrKey]) return false;
      if (!Array.isArray(cur[arrKey])) return false;
      if (i === parts.length - 1) {
        cur[arrKey][idx] = value;
        return true;
      }
      cur = cur[arrKey][idx];
      continue;
    }

    if (/^\d+$/.test(key)) {
      const idx = Number(key);
      if (!Array.isArray(cur)) return false;
      if (!cur[idx]) return false;
      if (i === parts.length - 1) {
        cur[idx] = value;
        return true;
      }
      cur = cur[idx];
      continue;
    }

    if (i === parts.length - 1) {
      cur[key] = value;
      return true;
    }

    if (cur[key] === undefined || cur[key] === null) return false;
    cur = cur[key];
  }

  return false;
}

function updateRawRequestJsonBody(rawRequest: string, jsonPath: string, newValue: any): { updated: boolean; rawRequest: string } {
  const sep = rawRequest.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const idx = rawRequest.indexOf(sep);
  if (idx < 0) return { updated: false, rawRequest };

  const head = rawRequest.slice(0, idx);
  const body = rawRequest.slice(idx + sep.length);

  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return { updated: false, rawRequest };
  }

  const norm = normalizeJsonPath(jsonPath);
  const candidates: string[] = [];

  if (norm.startsWith("content.")) {
    candidates.push(norm);
    candidates.push(norm.replace(/^content\./, ""));
  } else {
    candidates.push(norm);
    candidates.push("content." + norm);
  }

  let ok = false;
  for (const p of candidates) {
    if (setDeepValue(json, p, newValue)) {
      ok = true;
      break;
    }
  }
  if (!ok) return { updated: false, rawRequest };

  const newBody = JSON.stringify(json);

  const newHead = head
    .split(/\r?\n/)
    .filter(line => !/^content-length:/i.test(line.trim()))
    .join("\r\n");

  const rebuilt = newHead + "\r\n\r\n" + newBody;
  return { updated: true, rawRequest: rebuilt };
}

router.post('/template-variables/bulk-update', async (req: Request, res: Response) => {
  try {
    const db = dbManager.getActive();
    const { selected_matches, patch, dry_run } = req.body;

    function validatePatch(patch: any): { valid: boolean; error?: string } {
      if (patch.data_source === 'account_field' && !patch.account_field_name) {
        return { valid: false, error: 'account_field_name is required when data_source is account_field' };
      }
      if (patch.data_source === 'checklist' && !patch.checklist_id) {
        return { valid: false, error: 'checklist_id is required when data_source is checklist' };
      }
      if (patch.data_source === 'security_rule' && !patch.security_rule_id) {
        return { valid: false, error: 'security_rule_id is required when data_source is security_rule' };
      }
      if (patch.data_source === 'workflow_context' && (patch.checklist_id || patch.account_field_name || patch.security_rule_id)) {
        return { valid: false, error: 'workflow_context cannot have checklist_id, account_field_name, or security_rule_id' };
      }
      return { valid: true };
    }

    const validation = validatePatch(patch);
    if (!validation.valid) {
      res.status(400).json({ data: null, error: validation.error });
      return;
    }

    const templateGroups = new Map<string, any[]>();
    for (const match of selected_matches) {
      if (!templateGroups.has(match.template_id)) {
        templateGroups.set(match.template_id, []);
      }
      templateGroups.get(match.template_id)!.push(match);
    }

    const updates: any[] = [];
    const warnings: any[] = [];
    let affectedCount = 0;

    for (const [templateId, matches] of templateGroups) {
      const template = await db.repos.apiTemplates.findById(templateId);
      if (!template) {
        warnings.push({ template_id: templateId, reason: 'Template not found' });
        continue;
      }

      const variables = [...(template.variables || [])];
      let hasChanges = false;
      const matchUpdates: any[] = [];

      for (const match of matches) {
        const varIndex = variables.findIndex((v: any) => {
          const nameMatch = v.name === match.variable_name;
          const typeMatch = !match.variable_type || v.location === match.variable_type;
          const pathMatch = !match.json_path || v.json_path === match.json_path;
          return nameMatch && typeMatch && pathMatch;
        });
        if (varIndex === -1) {
          warnings.push({
            template_id: templateId,
            variable_name: match.variable_name,
            variable_type: match.variable_type,
            json_path: match.json_path,
            reason: 'Variable not found'
          });
          continue;
        }

        const before = { ...variables[varIndex] };
        const after = { ...variables[varIndex] };

        if (patch.default_value !== undefined) {
          after.default_value = patch.default_value;
          after.original_value = patch.default_value;
        }
        if (patch.operation_type !== undefined) {
          after.operation_type = patch.operation_type;
        }
        if (patch.data_source !== undefined) {
          after.data_source = patch.data_source;
          if (patch.data_source === 'workflow_context' || patch.data_source === 'original') {
            delete after.checklist_id;
            delete after.account_field_name;
            delete after.security_rule_id;
          }
        }
        if (patch.checklist_id !== undefined) {
          after.checklist_id = patch.checklist_id;
        }
        if (patch.account_field_name !== undefined) {
          after.account_field_name = patch.account_field_name;
        }
        if (patch.security_rule_id !== undefined) {
          after.security_rule_id = patch.security_rule_id;
        }
        if (patch.binding_strategy !== undefined) {
          after.binding_strategy = patch.binding_strategy;
        }

        variables[varIndex] = after;
        hasChanges = true;
        affectedCount++;

        matchUpdates.push({
          template_id: templateId,
          template_name: template.name,
          variable_name: match.variable_name,
          variable_type: match.variable_type,
          json_path: match.json_path,
          before,
          after,
          raw_request_updated: undefined,
        });
      }

      if (hasChanges) {
        let updatedRawRequest = template.raw_request;
        let anyRawRequestUpdated = false;

        if (patch.default_value !== undefined) {
          for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            const updateIndex = matchUpdates.findIndex(u =>
              u.variable_name === match.variable_name &&
              u.json_path === match.json_path
            );

            if (match.variable_type === 'body' && match.json_path && typeof updatedRawRequest === 'string') {
              const res = updateRawRequestJsonBody(updatedRawRequest, match.json_path, patch.default_value);

              if (res.updated) {
                updatedRawRequest = res.rawRequest;
                anyRawRequestUpdated = true;
                if (updateIndex >= 0) {
                  matchUpdates[updateIndex].raw_request_updated = true;
                }

                if (!dry_run) {
                  try {
                    const parsed = parseRawRequest(updatedRawRequest);
                    if (parsed) {
                      template.parsed_structure = parsed;
                    }
                  } catch (e) {
                    warnings.push({
                      template_id: templateId,
                      message: 'raw_request updated but re-parse failed; parsed_structure not refreshed',
                    });
                  }
                }
              } else {
                if (updateIndex >= 0) {
                  matchUpdates[updateIndex].raw_request_updated = false;
                }
                warnings.push({
                  template_id: templateId,
                  message: `default_value applied to original_value but raw_request JSON path not found: ${match.json_path}`,
                });
              }
            }
          }
        }

        if (!dry_run) {
          const updateData: any = { variables };
          if (anyRawRequestUpdated && updatedRawRequest !== template.raw_request) {
            updateData.raw_request = updatedRawRequest;
            if (template.parsed_structure) {
              updateData.parsed_structure = template.parsed_structure;
            }
          }

          await db.repos.apiTemplates.update(templateId, updateData);
        }
      }

      updates.push(...matchUpdates);
    }

    res.json({
      data: {
        success: true,
        dry_run,
        affected_count: affectedCount,
        updated_templates: templateGroups.size,
        updates,
        warnings,
      },
      error: null,
    });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

export default router;
