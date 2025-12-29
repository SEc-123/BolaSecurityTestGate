import { Router, Request, Response } from 'express';
import { FieldDictionary } from '../services/field-dictionary.js';
import { LearningEngine, StepSnapshot } from '../services/learning-engine.js';
import { createVariable, createMapping } from '../services/variable-pool.js';
import { checkFailurePatterns, applyVariableToRequest } from '../services/execution-utils.js';
import { evaluateStepAssertions } from '../services/workflow-runner.js';

function safeJson<T>(v: any, def: T): T {
  if (v === null || v === undefined) return def;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return def;
    }
  }
  if (Array.isArray(v) || typeof v === 'object') return v as T;
  return def;
}

export function createLearningRoutes(getDb: () => any): Router {
  const router = Router();

  router.get('/dictionary', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const scope = (req.query.scope as string) || 'global';
      const scopeId = req.query.scope_id as string | undefined;

      let query = `SELECT * FROM field_dictionary WHERE scope = 'global'`;
      const params: any[] = [];

      if (scope === 'project' && scopeId) {
        query += ` OR (scope = 'project' AND scope_id = ?)`;
        params.push(scopeId);
      }

      query += ` ORDER BY priority DESC, created_at DESC`;

      const results = await db.runRawQuery(query, params);
      res.json(results || []);
    } catch (error: any) {
      console.error('Error fetching dictionary:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/dictionary', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const dictionary = new FieldDictionary(db);
      const rule = await dictionary.addRule(req.body);
      res.status(201).json(rule);
    } catch (error: any) {
      console.error('Error creating dictionary rule:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/dictionary/:id', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const dictionary = new FieldDictionary(db);
      await dictionary.updateRule(req.params.id, req.body);
      res.json({ success: true });
    } catch (error: any) {
      console.error('Error updating dictionary rule:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/dictionary/:id', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const dictionary = new FieldDictionary(db);
      await dictionary.deleteRule(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error('Error deleting dictionary rule:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/workflows/:id/learn', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const workflowId = req.params.id;

      const workflowQuery = `SELECT * FROM workflows WHERE id = ?`;
      const workflows = await db.runRawQuery(workflowQuery, [workflowId]);
      const workflow = workflows?.[0];

      if (!workflow) {
        return res.status(404).json({ error: 'Workflow not found' });
      }

      if (workflow.workflow_type === 'mutation') {
        return res.status(400).json({ error: 'Cannot run learning mode on mutation workflows' });
      }

      const stepsQuery = `
        SELECT ws.*, at.name as template_name, at.raw_request, at.failure_patterns, at.failure_logic
        FROM workflow_steps ws
        JOIN api_templates at ON ws.api_template_id = at.id
        WHERE ws.workflow_id = ?
        ORDER BY ws.step_order
      `;
      const steps = await db.runRawQuery(stepsQuery, [workflowId]);

      if (!steps || steps.length === 0) {
        return res.status(400).json({ error: 'Workflow has no steps' });
      }

      const stepSnapshots: StepSnapshot[] = [];
      const stepValidations: { stepOrder: number; success: boolean; reason?: string }[] = [];

      const { accountId, environmentId } = req.body;

      let account = null;
      if (accountId) {
        const accountQuery = `SELECT * FROM accounts WHERE id = ?`;
        const accounts = await db.runRawQuery(accountQuery, [accountId]);
        account = accounts?.[0];
      }

      let environment = null;
      if (environmentId) {
        const envQuery = `SELECT * FROM environments WHERE id = ?`;
        const envs = await db.runRawQuery(envQuery, [environmentId]);
        environment = envs?.[0];
      }

      const variableConfigsQuery = `SELECT * FROM workflow_variable_configs WHERE workflow_id = ?`;
      const variableConfigs = await db.runRawQuery(variableConfigsQuery, [workflowId]);

      const sessionCookies: Record<string, string> = {};

      for (const step of steps) {
        const rawRequest = step.request_snapshot_raw || step.raw_request;
        let parsedRequest = parseRawRequest(rawRequest, environment);
        const variableValues: Record<string, string> = {};

        if (account && variableConfigs && variableConfigs.length > 0) {
          for (const config of variableConfigs) {
            if (config.data_source !== 'account_field') continue;
            if (!config.account_field_name) continue;

            const fieldValue = account.fields?.[config.account_field_name];
            if (fieldValue === undefined || fieldValue === null) continue;

            const v = String(fieldValue);
            variableValues[config.name] = v;

            const stepMappings = safeJson<any[]>(config.step_variable_mappings, []);
            for (const m of stepMappings) {
              if (m.step_order !== step.step_order) continue;

              const advancedConfig = safeJson<any>(config.advanced_config, {});

              const requestForApply = {
                ...parsedRequest,
                body: typeof parsedRequest.body === 'string'
                  ? parsedRequest.body
                  : (parsedRequest.body ? JSON.stringify(parsedRequest.body) : undefined),
              };

              const modifiedPath = applyVariableToRequest(requestForApply, m.json_path, v, advancedConfig);

              const baseUrl = new URL(parsedRequest.url.startsWith('http') ? parsedRequest.url : `http://placeholder${parsedRequest.url}`);
              const newPath = new URL(modifiedPath.path, 'http://placeholder');
              baseUrl.pathname = newPath.pathname;
              baseUrl.search = newPath.search;

              parsedRequest = {
                ...parsedRequest,
                ...modifiedPath,
                url: parsedRequest.url.startsWith('http') ? baseUrl.toString() : baseUrl.pathname + baseUrl.search,
                path: newPath.pathname + newPath.search,
              };
            }
          }
        }

        for (const [key, value] of Object.entries(sessionCookies)) {
          if (!parsedRequest.headers['Cookie']) {
            parsedRequest.headers['Cookie'] = '';
          }
          const cookieString = `${key}=${value}`;
          if (!parsedRequest.headers['Cookie'].includes(key)) {
            parsedRequest.headers['Cookie'] = parsedRequest.headers['Cookie']
              ? `${parsedRequest.headers['Cookie']}; ${cookieString}`
              : cookieString;
          }
        }

        const response = await executeRequest(parsedRequest, account);

        if (response.cookies) {
          for (const [key, value] of Object.entries(response.cookies)) {
            sessionCookies[key] = String(value);
          }
        }

        const failurePatterns = safeJson<any[]>(
          step.failure_patterns_override ?? step.failure_patterns,
          []
        );
        const failureLogic = (step.failure_logic || 'OR') as 'OR' | 'AND';
        const matchedFailure = checkFailurePatterns(failurePatterns, failureLogic, response.status, response.body, response.headers);

        const isStatusSuccess = response.status >= 200 && response.status < 300;
        const stepAssertions = safeJson<any[]>(step.step_assertions, []);
        const assertionsMode = (step.assertions_mode || 'all') as 'all' | 'any';
        const assertionsResult = evaluateStepAssertions(stepAssertions, assertionsMode, response, variableValues, { extractedValues: {}, cookies: sessionCookies, sessionFields: {} });

        const hasErrorStatus = response.status >= 400;
        const noValidationConfigured = failurePatterns.length === 0 && stepAssertions.length === 0;

        let stepSuccess = isStatusSuccess && !matchedFailure;
        let failureReason: string | undefined = undefined;

        if (!isStatusSuccess) {
          failureReason = `HTTP ${response.status}`;
        } else if (matchedFailure) {
          failureReason = 'failure pattern matched';
        } else if (!assertionsResult.passed) {
          failureReason = 'assertions failed';
          stepSuccess = false;
        }

        if (hasErrorStatus && noValidationConfigured) {
          failureReason = `HTTP ${response.status} (no validation configured)`;
          stepSuccess = false;
        }

        stepValidations.push({
          stepOrder: step.step_order,
          success: stepSuccess,
          reason: failureReason,
        });

        stepSnapshots.push({
          stepOrder: step.step_order,
          templateId: step.api_template_id,
          templateName: step.template_name,
          request: parsedRequest,
          response,
        });

        if (!step.request_snapshot_raw) {
          const updateQuery = `UPDATE workflow_steps SET request_snapshot_raw = ?, snapshot_template_name = ?, snapshot_template_id = ?, snapshot_created_at = ? WHERE id = ?`;
          const now = new Date().toISOString();
          await db.runRawQuery(updateQuery, [rawRequest, step.template_name, step.api_template_id, now, step.id]);
        }
      }

      const allStepsPassed = stepValidations.every(v => v.success);
      const baselineValid = allStepsPassed;

      if (!baselineValid) {
        const failedSteps = stepValidations.filter(v => !v.success);
        return res.status(400).json({
          error: 'Baseline execution failed',
          details: `Cannot learn when baseline is not successful. Failed steps: ${failedSteps.map(s => `step ${s.stepOrder} (${s.reason})`).join(', ')}`,
          failedSteps,
        });
      }

      const engine = new LearningEngine(db);
      const result = await engine.learn(workflowId, stepSnapshots);

      res.json({
        workflowId: result.workflowId,
        learningVersion: result.learningVersion,
        candidateFields: result.candidateFields,
        requestFields: result.requestFields,
        mappingCandidates: result.mappingCandidates,
      });
    } catch (error: any) {
      console.error('Error running learning mode:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/workflows/:id/mappings/apply', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const workflowId = req.params.id;
      const { acceptedCandidates, editedMappings, variables, learningVersion, applyMode = 'merge_keep_manual' } = req.body;

      if (applyMode === 'replace_all') {
        const deleteVarsQuery = `DELETE FROM workflow_variables WHERE workflow_id = ?`;
        await db.runRawQuery(deleteVarsQuery, [workflowId]);

        const deleteMappingsQuery = `DELETE FROM workflow_mappings WHERE workflow_id = ?`;
        await db.runRawQuery(deleteMappingsQuery, [workflowId]);
      } else {
        const deleteVarsQuery = `DELETE FROM workflow_variables WHERE workflow_id = ? AND source != 'manual' AND (is_locked = 0 OR is_locked IS NULL)`;
        await db.runRawQuery(deleteVarsQuery, [workflowId]);

        const deleteMappingsQuery = `DELETE FROM workflow_mappings WHERE workflow_id = ? AND reason != 'manual'`;
        await db.runRawQuery(deleteMappingsQuery, [workflowId]);
      }

      const createdVariables = [];
      for (const v of variables || []) {
        const created = await createVariable(db, workflowId, {
          name: v.name,
          type: v.type || 'GENERIC',
          source: v.source || 'extracted',
          write_policy: v.write_policy || 'overwrite',
          is_locked: v.is_locked || false,
          description: v.description,
          current_value: v.current_value,
        });
        createdVariables.push(created);
      }

      const createdMappings = [];
      const allMappings = [...(acceptedCandidates || []), ...(editedMappings || [])];

      for (const m of allMappings) {
        const created = await createMapping(db, workflowId, {
          from_step_order: m.fromStepOrder || m.from_step_order,
          from_location: m.fromLocation || m.from_location,
          from_path: m.fromPath || m.from_path,
          to_step_order: m.toStepOrder || m.to_step_order,
          to_location: m.toLocation || m.to_location,
          to_path: m.toPath || m.to_path,
          variable_name: m.variableName || m.variable_name,
          confidence: m.confidence || 1.0,
          reason: m.reason || 'manual',
          is_enabled: m.is_enabled !== false,
        });
        createdMappings.push(created);
      }

      const updateWorkflowQuery = `UPDATE workflows SET learning_status = 'learned', learning_version = ?, updated_at = ? WHERE id = ?`;
      const now = new Date().toISOString();
      await db.runRawQuery(updateWorkflowQuery, [learningVersion || 1, now, workflowId]);

      res.json({
        success: true,
        variables: createdVariables,
        mappings: createdMappings,
      });
    } catch (error: any) {
      console.error('Error applying mappings:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/workflows/:id/variables', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const workflowId = req.params.id;

      const query = `SELECT * FROM workflow_variables WHERE workflow_id = ? ORDER BY name`;
      const results = await db.runRawQuery(query, [workflowId]);
      res.json(results || []);
    } catch (error: any) {
      console.error('Error fetching variables:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/workflows/:id/variables', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const workflowId = req.params.id;
      const variable = await createVariable(db, workflowId, req.body);
      res.status(201).json(variable);
    } catch (error: any) {
      console.error('Error creating variable:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/workflows/:id/variables/:varId', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const { varId } = req.params;
      const updates = req.body;

      const setClauses: string[] = [];
      const values: any[] = [];

      for (const [key, value] of Object.entries(updates)) {
        if (key !== 'id' && key !== 'workflow_id' && key !== 'created_at') {
          setClauses.push(`${key} = ?`);
          if (key === 'is_locked') {
            values.push(value ? 1 : 0);
          } else {
            values.push(value);
          }
        }
      }

      setClauses.push(`updated_at = ?`);
      values.push(new Date().toISOString());
      values.push(varId);

      const query = `UPDATE workflow_variables SET ${setClauses.join(', ')} WHERE id = ?`;
      await db.runRawQuery(query, values);

      res.json({ success: true });
    } catch (error: any) {
      console.error('Error updating variable:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/workflows/:id/variables/:varId', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const { varId } = req.params;

      const query = `DELETE FROM workflow_variables WHERE id = ?`;
      await db.runRawQuery(query, [varId]);

      res.json({ success: true });
    } catch (error: any) {
      console.error('Error deleting variable:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/workflows/:id/mappings', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const workflowId = req.params.id;

      const query = `SELECT * FROM workflow_mappings WHERE workflow_id = ? ORDER BY from_step_order, to_step_order`;
      const results = await db.runRawQuery(query, [workflowId]);
      res.json(results || []);
    } catch (error: any) {
      console.error('Error fetching mappings:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/workflows/:id/mappings', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const workflowId = req.params.id;
      const mapping = await createMapping(db, workflowId, req.body);
      res.status(201).json(mapping);
    } catch (error: any) {
      console.error('Error creating mapping:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/workflows/:id/mappings/:mappingId', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const { mappingId } = req.params;
      const updates = req.body;

      const setClauses: string[] = [];
      const values: any[] = [];

      for (const [key, value] of Object.entries(updates)) {
        if (key !== 'id' && key !== 'workflow_id' && key !== 'created_at') {
          setClauses.push(`${key} = ?`);
          if (key === 'is_enabled') {
            values.push(value ? 1 : 0);
          } else {
            values.push(value);
          }
        }
      }

      values.push(mappingId);

      const query = `UPDATE workflow_mappings SET ${setClauses.join(', ')} WHERE id = ?`;
      await db.runRawQuery(query, values);

      res.json({ success: true });
    } catch (error: any) {
      console.error('Error updating mapping:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/workflows/:id/mappings/:mappingId', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const { mappingId } = req.params;

      const query = `DELETE FROM workflow_mappings WHERE id = ?`;
      await db.runRawQuery(query, [mappingId]);

      res.json({ success: true });
    } catch (error: any) {
      console.error('Error deleting mapping:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/workflows/:id/steps/import-from-template', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const workflowId = req.params.id;
      const { api_template_id, step_order } = req.body;

      const templateQuery = `SELECT * FROM api_templates WHERE id = ?`;
      const templates = await db.runRawQuery(templateQuery, [api_template_id]);
      const template = templates?.[0];

      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }

      const stepId = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const now = new Date().toISOString();

      const insertQuery = `INSERT INTO workflow_steps
        (id, workflow_id, api_template_id, step_order, request_snapshot_raw, snapshot_template_name, snapshot_template_id, snapshot_created_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      await db.runRawQuery(insertQuery, [
        stepId,
        workflowId,
        api_template_id,
        step_order,
        template.raw_request,
        template.name,
        template.id,
        now,
        now
      ]);

      res.status(201).json({
        id: stepId,
        workflow_id: workflowId,
        api_template_id,
        step_order,
        request_snapshot_raw: template.raw_request,
        snapshot_template_name: template.name,
        snapshot_template_id: template.id,
        snapshot_created_at: now,
        created_at: now,
      });
    } catch (error: any) {
      console.error('Error importing template to step:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/workflows/:baselineId/mutations', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const baselineId = req.params.baselineId;
      const { name, description, mutation_profile } = req.body;

      const baselineQuery = `SELECT * FROM workflows WHERE id = ?`;
      const baselines = await db.runRawQuery(baselineQuery, [baselineId]);
      const baseline = baselines?.[0];

      if (!baseline) {
        return res.status(404).json({ error: 'Baseline workflow not found' });
      }

      if (baseline.workflow_type === 'mutation') {
        return res.status(400).json({ error: 'Cannot create mutation from another mutation' });
      }

      const mutationId = `wf_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const now = new Date().toISOString();

      const insertQuery = `INSERT INTO workflows
        (id, name, description, workflow_type, base_workflow_id, learning_status, learning_version, template_mode, mutation_profile, created_at, updated_at)
        VALUES (?, ?, ?, 'mutation', ?, 'unlearned', ?, 'snapshot', ?, ?, ?)`;

      await db.runRawQuery(insertQuery, [
        mutationId,
        name || `${baseline.name} - Mutation`,
        description,
        baselineId,
        baseline.learning_version || 0,
        JSON.stringify(mutation_profile || {}),
        now,
        now
      ]);

      res.status(201).json({
        id: mutationId,
        name: name || `${baseline.name} - Mutation`,
        description,
        workflow_type: 'mutation',
        base_workflow_id: baselineId,
        learning_version: baseline.learning_version || 0,
        mutation_profile: mutation_profile || {},
        created_at: now,
        updated_at: now,
      });
    } catch (error: any) {
      console.error('Error creating mutation:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/workflows/:baselineId/mutations', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const baselineId = req.params.baselineId;

      const query = `SELECT * FROM workflows WHERE base_workflow_id = ? AND workflow_type = 'mutation' ORDER BY created_at DESC`;
      const results = await db.runRawQuery(query, [baselineId]);

      const mutations = (results || []).map((m: any) => ({
        ...m,
        mutation_profile: m.mutation_profile ? JSON.parse(m.mutation_profile) : {},
      }));

      res.json(mutations);
    } catch (error: any) {
      console.error('Error fetching mutations:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/mutations/:id', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const { id } = req.params;
      const { name, description, mutation_profile } = req.body;

      const setClauses: string[] = [];
      const values: any[] = [];

      if (name !== undefined) {
        setClauses.push('name = ?');
        values.push(name);
      }
      if (description !== undefined) {
        setClauses.push('description = ?');
        values.push(description);
      }
      if (mutation_profile !== undefined) {
        setClauses.push('mutation_profile = ?');
        values.push(JSON.stringify(mutation_profile));
      }

      setClauses.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(id);

      const query = `UPDATE workflows SET ${setClauses.join(', ')} WHERE id = ? AND workflow_type = 'mutation'`;
      await db.runRawQuery(query, values);

      res.json({ success: true });
    } catch (error: any) {
      console.error('Error updating mutation:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

function parseRawRequest(rawRequest: string, environment?: any): any {
  const lines = rawRequest.split('\n');
  const firstLine = lines[0].trim();
  const [method, ...urlParts] = firstLine.split(' ');
  let url = urlParts.join(' ');

  const headers: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const query: Record<string, string> = {};
  let bodyStartIndex = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') {
      bodyStartIndex = i + 1;
      break;
    }
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();
      if (key.toLowerCase() === 'cookie') {
        const cookiePairs = value.split(';');
        for (const pair of cookiePairs) {
          const [k, v] = pair.split('=').map(s => s.trim());
          if (k && v) cookies[k] = v;
        }
      } else {
        headers[key] = value;
      }
    }
  }

  let body: any = null;
  if (bodyStartIndex > 0 && bodyStartIndex < lines.length) {
    const bodyText = lines.slice(bodyStartIndex).join('\n').trim();
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
  }

  if (environment?.base_url && !url.startsWith('http')) {
    url = environment.base_url + url;
  }

  const urlObj = new URL(url.startsWith('http') ? url : `http://example.com${url}`);
  urlObj.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  return {
    method: method || 'GET',
    url,
    path: urlObj.pathname + urlObj.search,
    headers,
    cookies,
    query,
    body,
  };
}

async function executeRequest(request: any, account?: any): Promise<any> {
  try {
    const headers: Record<string, string> = { ...request.headers };

    if (account?.fields) {
      let fields = account.fields;
      if (typeof fields === 'string') {
        try { fields = JSON.parse(fields); } catch {}
      }

      if (fields.token && !headers['Authorization']) {
        headers['Authorization'] = `Bearer ${fields.token}`;
      }
      if (fields.accessToken && !headers['Authorization']) {
        headers['Authorization'] = `Bearer ${fields.accessToken}`;
      }
      if (fields.access_token && !headers['Authorization']) {
        headers['Authorization'] = `Bearer ${fields.access_token}`;
      }
      if (fields.authorization && !headers['Authorization']) {
        headers['Authorization'] = fields.authorization;
      }
      if (fields.apiKey && !headers['X-API-Key']) {
        headers['X-API-Key'] = fields.apiKey;
      }
      if (fields.api_key && !headers['X-API-Key']) {
        headers['X-API-Key'] = fields.api_key;
      }
      if (fields.cookie) {
        const existingCookie = headers['Cookie'] || '';
        headers['Cookie'] = existingCookie ? `${existingCookie}; ${fields.cookie}` : fields.cookie;
      }
    }

    if (Object.keys(request.cookies).length > 0) {
      headers['Cookie'] = Object.entries(request.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    }

    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
    };

    if (request.body && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
      fetchOptions.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(request.url, fetchOptions);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const responseCookies: Record<string, string> = {};
    const anyHeaders: any = response.headers as any;
    const setCookie = typeof anyHeaders.getSetCookie === 'function'
      ? anyHeaders.getSetCookie()
      : response.headers.get('set-cookie');

    if (setCookie) {
      const cookieStrings: string[] = Array.isArray(setCookie) ? setCookie : [setCookie];

      for (const cookieStr of cookieStrings) {
        const parts: string[] = [];
        let currentPart = '';
        let i = 0;

        while (i < cookieStr.length) {
          if (cookieStr[i] === ',' && i + 1 < cookieStr.length) {
            const afterComma = cookieStr.substring(i + 1).trim();
            if (/^[a-zA-Z0-9_-]+=/.test(afterComma)) {
              parts.push(currentPart);
              currentPart = '';
              i++;
              continue;
            }
          }
          currentPart += cookieStr[i];
          i++;
        }
        if (currentPart) parts.push(currentPart);

        for (const part of parts) {
          const cookiePart = part.split(';')[0].trim();
          const eqIndex = cookiePart.indexOf('=');
          if (eqIndex > 0) {
            const name = cookiePart.substring(0, eqIndex).trim();
            const value = cookiePart.substring(eqIndex + 1).trim();
            responseCookies[name] = value;
          }
        }
      }
    }

    const bodyText = await response.text();

    return {
      status: response.status,
      headers: responseHeaders,
      cookies: responseCookies,
      body: bodyText,
    };
  } catch (error: any) {
    console.error('Error executing request:', error);
    return {
      status: 0,
      headers: {},
      cookies: {},
      body: { error: error.message },
    };
  }
}
