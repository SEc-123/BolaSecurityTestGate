import { v4 as uuidv4 } from 'uuid';
import type { DbProvider } from '../../types/index.js';
import { dbAll, dbGet, dbRun } from '../../db/sql-helpers.js';
import type {
  AIScanRun,
  AIScanTask,
  AIScanArtifact,
  AIDiscoveredEndpoint,
  AIFeatureNode,
  AIVulnerabilityCandidate,
  AIToolInvocation,
  AIScanSharedResource,
  AIScanSnapshot,
  AIScanTaskStatus,
  AIScanStatus,
} from './types.js';

function jsonParse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function nowExpression(db: DbProvider): string {
  return db.kind === 'postgres' ? 'now()' : "datetime('now')";
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function normalizeRun(row: any): AIScanRun {
  const summary = jsonParse<Record<string, any>>(row.summary, {});
  const enrichedSummary = { ...summary };
  const countFields: Array<[string, string]> = [
    ['endpoints_total', 'endpoints_total'],
    ['features_total', 'features_total'],
    ['candidates_total', 'candidates_total'],
    ['artifacts_total', 'artifacts_total'],
    ['tool_calls_total', 'tool_calls_total'],
    ['tasks_total_count', 'tasks_total'],
    ['tasks_completed_count', 'tasks_completed'],
    ['tasks_failed_count', 'tasks_failed'],
    ['tasks_running_count', 'tasks_running'],
  ];
  for (const [rowKey, summaryKey] of countFields) {
    if (row[rowKey] !== undefined && enrichedSummary[summaryKey] === undefined) {
      enrichedSummary[summaryKey] = Number(row[rowKey] || 0);
    }
  }

  return {
    ...row,
    selected_vuln_types: jsonParse<string[]>(row.selected_vuln_types, []),
    scan_config: jsonParse<Record<string, any>>(row.scan_config, {}),
    summary: enrichedSummary,
  } as AIScanRun;
}

function normalizeTask(row: any): AIScanTask {
  return {
    ...row,
    endpoint_ids: jsonParse<string[]>(row.endpoint_ids, []),
    dependencies: jsonParse<string[]>(row.dependencies, []),
    execution_plan: jsonParse<Record<string, any>>(row.execution_plan, {}),
    created_assets_json: jsonParse<Record<string, any>>(row.created_assets_json, {}),
  } as AIScanTask;
}

function normalizeEndpoint(row: any): AIDiscoveredEndpoint {
  return { ...row, auth_required: toBool(row.auth_required) } as AIDiscoveredEndpoint;
}

function normalizeFeature(row: any): AIFeatureNode {
  return {
    ...row,
    evidence_artifact_ids: jsonParse<string[]>(row.evidence_artifact_ids, []),
    endpoint_ids: jsonParse<string[]>(row.endpoint_ids, []),
  } as AIFeatureNode;
}

function normalizeCandidate(row: any): AIVulnerabilityCandidate {
  return {
    ...row,
    endpoint_ids: jsonParse<string[]>(row.endpoint_ids, []),
    required_accounts: jsonParse<string[]>(row.required_accounts, []),
  } as AIVulnerabilityCandidate;
}

function normalizeArtifact(row: any): AIScanArtifact {
  return {
    ...row,
    content_json: jsonParse<Record<string, any>>(row.content_json, {}),
  } as AIScanArtifact;
}


function normalizeSharedResource(row: any): AIScanSharedResource {
  return {
    ...row,
    content_json: jsonParse<Record<string, any>>(row.content_json, {}),
    usage_count: Number(row.usage_count || 0),
  } as AIScanSharedResource;
}

function normalizeInvocation(row: any): AIToolInvocation {
  return {
    ...row,
    input_json: jsonParse<Record<string, any>>(row.input_json, {}),
    output_json: jsonParse<Record<string, any>>(row.output_json, {}),
  } as AIToolInvocation;
}


function dependencyStatusesSatisfied(task: AIScanTask, allTasks: AIScanTask[]): boolean {
  const byId = new Map(allTasks.map(item => [item.id, item]));
  const terminal = new Set(['completed', 'skipped', 'failed', 'blocked']);
  const completed = new Set(['completed', 'skipped']);
  const summarize = task.task_type === 'summarize_vulnerability_campaign' || task.execution_plan?.intent === 'summarize_vulnerability_campaign';
  return (task.dependencies || []).every(dep => {
    const dependency = byId.get(dep);
    if (!dependency) return false;
    return summarize ? terminal.has(dependency.status) : completed.has(dependency.status);
  });
}

export class AIScanRepository {
  constructor(private readonly db: DbProvider) {}

  async createRun(input: {
    base_url: string;
    name?: string;
    user_prompt?: string;
    selected_vuln_types?: string[];
    scan_config?: Record<string, any>;
    environment_id?: string;
  }): Promise<AIScanRun> {
    const id = uuidv4();
    await dbRun(
      this.db,
      `INSERT INTO ai_scan_runs (id, name, base_url, user_prompt, status, current_phase, selected_vuln_types, scan_config, summary, environment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name || `AI Scan ${new Date().toISOString()}`,
        input.base_url,
        input.user_prompt || '',
        'created',
        'initialized',
        jsonStringify(input.selected_vuln_types || []),
        jsonStringify(input.scan_config || {}),
        jsonStringify({}),
        input.environment_id || null,
      ]
    );
    const run = await this.getRun(id);
    if (!run) throw new Error('Failed to create AI scan run');
    return run;
  }

  async getRun(id: string): Promise<AIScanRun | null> {
    const row = await dbGet<any>(this.db, 'SELECT * FROM ai_scan_runs WHERE id = ?', [id]);
    return row ? normalizeRun(row) : null;
  }

  async listRuns(): Promise<AIScanRun[]> {
    const rows = await dbAll<any>(
      this.db,
      `SELECT r.*,
        (SELECT COUNT(*) FROM ai_discovered_endpoints e WHERE e.scan_run_id = r.id) AS endpoints_total,
        (SELECT COUNT(*) FROM ai_feature_nodes f WHERE f.scan_run_id = r.id) AS features_total,
        (SELECT COUNT(*) FROM ai_vulnerability_candidates c WHERE c.scan_run_id = r.id) AS candidates_total,
        (SELECT COUNT(*) FROM ai_scan_artifacts a WHERE a.scan_run_id = r.id) AS artifacts_total,
        (SELECT COUNT(*) FROM ai_tool_invocations i WHERE i.scan_run_id = r.id) AS tool_calls_total,
        (SELECT COUNT(*) FROM ai_scan_tasks t WHERE t.scan_run_id = r.id) AS tasks_total_count,
        (SELECT COUNT(*) FROM ai_scan_tasks t WHERE t.scan_run_id = r.id AND t.status = 'completed') AS tasks_completed_count,
        (SELECT COUNT(*) FROM ai_scan_tasks t WHERE t.scan_run_id = r.id AND t.status = 'failed') AS tasks_failed_count,
        (SELECT COUNT(*) FROM ai_scan_tasks t WHERE t.scan_run_id = r.id AND t.status = 'running') AS tasks_running_count
       FROM ai_scan_runs r
       ORDER BY r.created_at DESC`
    );
    return rows.map(normalizeRun);
  }

  async updateRun(id: string, patch: Partial<Omit<AIScanRun, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const columns: string[] = [];
    const values: any[] = [];
    const jsonFields = new Set(['selected_vuln_types', 'scan_config', 'summary']);
    for (const [key, value] of Object.entries(patch)) {
      columns.push(`${key} = ?`);
      values.push(jsonFields.has(key) ? jsonStringify(value) : value ?? null);
    }
    if (columns.length === 0) return;
    columns.push(`updated_at = ${nowExpression(this.db)}`);
    values.push(id);
    await dbRun(this.db, `UPDATE ai_scan_runs SET ${columns.join(', ')} WHERE id = ?`, values);
  }

  async createTask(input: {
    scan_run_id: string;
    parent_task_id?: string;
    title: string;
    task_type: string;
    vuln_type?: string;
    feature_id?: string;
    endpoint_ids?: string[];
    status?: AIScanTaskStatus;
    phase?: string;
    priority?: number;
    dependencies?: string[];
    agent_goal?: string;
    execution_plan?: Record<string, any>;
    created_assets_json?: Record<string, any>;
  }): Promise<AIScanTask> {
    const id = uuidv4();
    await dbRun(
      this.db,
      `INSERT INTO ai_scan_tasks (
        id, scan_run_id, parent_task_id, title, task_type, vuln_type, feature_id, endpoint_ids, status, phase, priority,
        dependencies, agent_goal, execution_plan, created_assets_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.scan_run_id,
        input.parent_task_id || null,
        input.title,
        input.task_type,
        input.vuln_type || null,
        input.feature_id || null,
        jsonStringify(input.endpoint_ids || []),
        input.status || 'pending',
        input.phase || 'created',
        input.priority ?? 100,
        jsonStringify(input.dependencies || []),
        input.agent_goal || '',
        jsonStringify(input.execution_plan || {}),
        jsonStringify(input.created_assets_json || {}),
      ]
    );
    const task = await this.getTask(id);
    if (!task) throw new Error('Failed to create AI scan task');
    return task;
  }

  async getTask(id: string): Promise<AIScanTask | null> {
    const row = await dbGet<any>(this.db, 'SELECT * FROM ai_scan_tasks WHERE id = ?', [id]);
    return row ? normalizeTask(row) : null;
  }

  async listTasks(scanRunId: string): Promise<AIScanTask[]> {
    const rows = await dbAll<any>(this.db, 'SELECT * FROM ai_scan_tasks WHERE scan_run_id = ? ORDER BY priority ASC, created_at ASC', [scanRunId]);
    return rows.map(normalizeTask);
  }

  async findNextPendingTask(scanRunId: string): Promise<AIScanTask | null> {
    const rows = await dbAll<any>(
      this.db,
      `SELECT * FROM ai_scan_tasks
       WHERE scan_run_id = ? AND status = 'pending'
       ORDER BY priority ASC, created_at ASC`,
      [scanRunId]
    );
    const tasks = rows.map(normalizeTask);
    if (tasks.length === 0) return null;
    const allTasks = await this.listTasks(scanRunId);
    return tasks.find(task => dependencyStatusesSatisfied(task, allTasks)) || null;
  }


  async findRunnablePendingTasks(scanRunId: string, limit = 10): Promise<AIScanTask[]> {
    const rows = await dbAll<any>(
      this.db,
      `SELECT * FROM ai_scan_tasks
       WHERE scan_run_id = ? AND status = 'pending'
       ORDER BY priority ASC, created_at ASC`,
      [scanRunId]
    );
    const pending = rows.map(normalizeTask);
    if (pending.length === 0) return [];
    const allTasks = await this.listTasks(scanRunId);
    const runnable = pending.filter(task => dependencyStatusesSatisfied(task, allTasks));
    const firstSerial = runnable.find(task => task.execution_plan?.parallel_capable === false);
    if (firstSerial) return [firstSerial];
    return runnable.slice(0, Math.max(1, limit));
  }

  async claimRunnableTasks(scanRunId: string, limit = 10, workerPrefix = 'agent'): Promise<AIScanTask[]> {
    const runnable = await this.findRunnablePendingTasks(scanRunId, limit);
    const claimed: AIScanTask[] = [];
    for (let index = 0; index < runnable.length; index += 1) {
      const task = runnable[index];
      const workerId = `${workerPrefix}-${index + 1}`;
      const current = await this.getTask(task.id);
      if (!current || current.status !== 'pending') continue;
      await this.updateTask(task.id, {
        status: 'running',
        phase: `claimed_by:${workerId}`,
        started_at: new Date().toISOString(),
        execution_plan: {
          ...(current.execution_plan || {}),
          agent_worker_id: workerId,
          claimed_at: new Date().toISOString(),
          parallel_claimed: runnable.length > 1,
        },
      });
      const updated = await this.getTask(task.id);
      if (updated) claimed.push(updated);
    }
    return claimed;
  }

  async updateTask(id: string, patch: Partial<Omit<AIScanTask, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const columns: string[] = [];
    const values: any[] = [];
    const jsonFields = new Set(['endpoint_ids', 'dependencies', 'execution_plan', 'created_assets_json']);
    for (const [key, value] of Object.entries(patch)) {
      columns.push(`${key} = ?`);
      values.push(jsonFields.has(key) ? jsonStringify(value) : value ?? null);
    }
    if (columns.length === 0) return;
    columns.push(`updated_at = ${nowExpression(this.db)}`);
    values.push(id);
    await dbRun(this.db, `UPDATE ai_scan_tasks SET ${columns.join(', ')} WHERE id = ?`, values);
  }

  async createArtifact(input: {
    scan_run_id: string;
    task_id?: string;
    artifact_type: string;
    title?: string;
    content_json?: Record<string, any>;
    content_text?: string;
    source_ref?: string;
  }): Promise<AIScanArtifact> {
    const id = uuidv4();
    await dbRun(
      this.db,
      `INSERT INTO ai_scan_artifacts (id, scan_run_id, task_id, artifact_type, title, content_json, content_text, source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.scan_run_id,
        input.task_id || null,
        input.artifact_type,
        input.title || null,
        jsonStringify(input.content_json || {}),
        input.content_text || null,
        input.source_ref || null,
      ]
    );
    const artifact = await dbGet<any>(this.db, 'SELECT * FROM ai_scan_artifacts WHERE id = ?', [id]);
    if (!artifact) throw new Error('Failed to create AI scan artifact');
    return normalizeArtifact(artifact);
  }

  async listArtifacts(scanRunId: string, taskId?: string): Promise<AIScanArtifact[]> {
    const rows = taskId
      ? await dbAll<any>(this.db, 'SELECT * FROM ai_scan_artifacts WHERE scan_run_id = ? AND task_id = ? ORDER BY created_at DESC', [scanRunId, taskId])
      : await dbAll<any>(this.db, 'SELECT * FROM ai_scan_artifacts WHERE scan_run_id = ? ORDER BY created_at DESC', [scanRunId]);
    return rows.map(normalizeArtifact);
  }

  async upsertEndpoint(input: {
    scan_run_id: string;
    method: string;
    path: string;
    url?: string;
    request_summary?: string;
    response_summary?: string;
    auth_required?: boolean;
    content_type?: string;
    feature_guess?: string;
    source_type?: string;
    source_id?: string;
    raw_event_id?: string;
  }): Promise<AIDiscoveredEndpoint> {
    const existing = await dbGet<any>(
      this.db,
      'SELECT * FROM ai_discovered_endpoints WHERE scan_run_id = ? AND method = ? AND path = ? LIMIT 1',
      [input.scan_run_id, input.method.toUpperCase(), input.path]
    );
    if (existing) {
      await dbRun(
        this.db,
        `UPDATE ai_discovered_endpoints
         SET url = COALESCE(url, ?), request_summary = COALESCE(request_summary, ?), response_summary = COALESCE(response_summary, ?),
             auth_required = CASE WHEN auth_required = 1 THEN 1 ELSE ? END, content_type = COALESCE(content_type, ?), feature_guess = COALESCE(feature_guess, ?), source_type = COALESCE(source_type, ?),
             source_id = COALESCE(source_id, ?), raw_event_id = COALESCE(raw_event_id, ?), updated_at = ${nowExpression(this.db)}
         WHERE id = ?`,
        [
          input.url || null,
          input.request_summary || null,
          input.response_summary || null,
          input.auth_required ? 1 : 0,
          input.content_type || null,
          input.feature_guess || null,
          input.source_type || null,
          input.source_id || null,
          input.raw_event_id || null,
          existing.id,
        ]
      );
      const updated = await dbGet<any>(this.db, 'SELECT * FROM ai_discovered_endpoints WHERE id = ?', [existing.id]);
      return normalizeEndpoint(updated);
    }

    const id = uuidv4();
    await dbRun(
      this.db,
      `INSERT INTO ai_discovered_endpoints (
        id, scan_run_id, method, path, url, request_summary, response_summary, auth_required, content_type, feature_guess, source_type, source_id, raw_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.scan_run_id,
        input.method.toUpperCase(),
        input.path,
        input.url || null,
        input.request_summary || null,
        input.response_summary || null,
        input.auth_required ? 1 : 0,
        input.content_type || null,
        input.feature_guess || null,
        input.source_type || null,
        input.source_id || null,
        input.raw_event_id || null,
      ]
    );
    const created = await dbGet<any>(this.db, 'SELECT * FROM ai_discovered_endpoints WHERE id = ?', [id]);
    return normalizeEndpoint(created);
  }

  async listEndpoints(scanRunId: string): Promise<AIDiscoveredEndpoint[]> {
    const rows = await dbAll<any>(this.db, 'SELECT * FROM ai_discovered_endpoints WHERE scan_run_id = ? ORDER BY method, path', [scanRunId]);
    return rows.map(normalizeEndpoint);
  }

  async createFeature(input: {
    scan_run_id: string;
    parent_id?: string;
    name: string;
    node_type: string;
    description?: string;
    confidence?: number;
    evidence_artifact_ids?: string[];
    endpoint_ids?: string[];
  }): Promise<AIFeatureNode> {
    const id = uuidv4();
    await dbRun(
      this.db,
      `INSERT INTO ai_feature_nodes (id, scan_run_id, parent_id, name, node_type, description, confidence, evidence_artifact_ids, endpoint_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.scan_run_id,
        input.parent_id || null,
        input.name,
        input.node_type,
        input.description || null,
        input.confidence ?? 0.5,
        jsonStringify(input.evidence_artifact_ids || []),
        jsonStringify(input.endpoint_ids || []),
      ]
    );
    const row = await dbGet<any>(this.db, 'SELECT * FROM ai_feature_nodes WHERE id = ?', [id]);
    return normalizeFeature(row);
  }


  async updateFeature(id: string, patch: Partial<Omit<AIFeatureNode, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const columns: string[] = [];
    const values: any[] = [];
    const jsonFields = new Set(['evidence_artifact_ids', 'endpoint_ids']);
    for (const [key, value] of Object.entries(patch)) {
      columns.push(`${key} = ?`);
      values.push(jsonFields.has(key) ? jsonStringify(value) : value ?? null);
    }
    if (columns.length === 0) return;
    columns.push(`updated_at = ${nowExpression(this.db)}`);
    values.push(id);
    await dbRun(this.db, `UPDATE ai_feature_nodes SET ${columns.join(', ')} WHERE id = ?`, values);
  }

  async clearFeatures(scanRunId: string): Promise<void> {
    await dbRun(this.db, 'DELETE FROM ai_feature_nodes WHERE scan_run_id = ?', [scanRunId]);
  }

  async listFeatures(scanRunId: string): Promise<AIFeatureNode[]> {
    const rows = await dbAll<any>(this.db, 'SELECT * FROM ai_feature_nodes WHERE scan_run_id = ? ORDER BY parent_id, created_at', [scanRunId]);
    return rows.map(normalizeFeature);
  }

  async createCandidate(input: {
    scan_run_id: string;
    feature_id?: string;
    vuln_type: string;
    title: string;
    reason?: string;
    confidence?: number;
    endpoint_ids?: string[];
    required_accounts?: string[];
    status?: string;
  }): Promise<AIVulnerabilityCandidate> {
    const id = uuidv4();
    await dbRun(
      this.db,
      `INSERT INTO ai_vulnerability_candidates (id, scan_run_id, feature_id, vuln_type, title, reason, confidence, endpoint_ids, required_accounts, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.scan_run_id,
        input.feature_id || null,
        input.vuln_type,
        input.title,
        input.reason || '',
        input.confidence ?? 0.5,
        jsonStringify(input.endpoint_ids || []),
        jsonStringify(input.required_accounts || []),
        input.status || 'candidate',
      ]
    );
    const row = await dbGet<any>(this.db, 'SELECT * FROM ai_vulnerability_candidates WHERE id = ?', [id]);
    return normalizeCandidate(row);
  }

  async clearCandidates(scanRunId: string): Promise<void> {
    await dbRun(this.db, 'DELETE FROM ai_vulnerability_candidates WHERE scan_run_id = ?', [scanRunId]);
  }

  async listCandidates(scanRunId: string): Promise<AIVulnerabilityCandidate[]> {
    const rows = await dbAll<any>(this.db, 'SELECT * FROM ai_vulnerability_candidates WHERE scan_run_id = ? ORDER BY vuln_type, confidence DESC', [scanRunId]);
    return rows.map(normalizeCandidate);
  }


  async upsertSharedResource(input: {
    scan_run_id: string;
    resource_type: string;
    resource_key: string;
    title?: string;
    content_json?: Record<string, any>;
    owner_task_id?: string;
    increment_usage?: boolean;
  }): Promise<AIScanSharedResource> {
    const existing = await dbGet<any>(
      this.db,
      'SELECT * FROM ai_scan_shared_resources WHERE scan_run_id = ? AND resource_type = ? AND resource_key = ? LIMIT 1',
      [input.scan_run_id, input.resource_type, input.resource_key]
    );
    if (existing) {
      await dbRun(
        this.db,
        `UPDATE ai_scan_shared_resources
         SET title = COALESCE(?, title), content_json = ?, owner_task_id = COALESCE(?, owner_task_id),
             usage_count = usage_count + ?, updated_at = ${nowExpression(this.db)}
         WHERE id = ?`,
        [input.title || null, jsonStringify(input.content_json || {}), input.owner_task_id || null, input.increment_usage ? 1 : 0, existing.id]
      );
      const row = await dbGet<any>(this.db, 'SELECT * FROM ai_scan_shared_resources WHERE id = ?', [existing.id]);
      return normalizeSharedResource(row);
    }
    const id = uuidv4();
    await dbRun(
      this.db,
      `INSERT INTO ai_scan_shared_resources (id, scan_run_id, resource_type, resource_key, title, content_json, owner_task_id, usage_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.scan_run_id, input.resource_type, input.resource_key, input.title || null, jsonStringify(input.content_json || {}), input.owner_task_id || null, input.increment_usage ? 1 : 0]
    );
    const row = await dbGet<any>(this.db, 'SELECT * FROM ai_scan_shared_resources WHERE id = ?', [id]);
    return normalizeSharedResource(row);
  }

  async listSharedResources(scanRunId: string, resourceType?: string): Promise<AIScanSharedResource[]> {
    const rows = resourceType
      ? await dbAll<any>(this.db, 'SELECT * FROM ai_scan_shared_resources WHERE scan_run_id = ? AND resource_type = ? ORDER BY resource_type, resource_key', [scanRunId, resourceType])
      : await dbAll<any>(this.db, 'SELECT * FROM ai_scan_shared_resources WHERE scan_run_id = ? ORDER BY resource_type, resource_key', [scanRunId]);
    return rows.map(normalizeSharedResource);
  }

  async getSharedResource(scanRunId: string, resourceType: string, resourceKey: string): Promise<AIScanSharedResource | null> {
    const row = await dbGet<any>(this.db, 'SELECT * FROM ai_scan_shared_resources WHERE scan_run_id = ? AND resource_type = ? AND resource_key = ? LIMIT 1', [scanRunId, resourceType, resourceKey]);
    return row ? normalizeSharedResource(row) : null;
  }

  async touchSharedResource(scanRunId: string, resourceType: string, resourceKey: string): Promise<void> {
    await dbRun(this.db, `UPDATE ai_scan_shared_resources SET usage_count = usage_count + 1, updated_at = ${nowExpression(this.db)} WHERE scan_run_id = ? AND resource_type = ? AND resource_key = ?`, [scanRunId, resourceType, resourceKey]);
  }

  async createToolInvocation(input: {
    scan_run_id: string;
    task_id?: string;
    tool_name: string;
    input_json?: Record<string, any>;
    output_json?: Record<string, any>;
    status?: string;
    error_message?: string;
    started_at?: string;
    completed_at?: string;
  }): Promise<AIToolInvocation> {
    const id = uuidv4();
    await dbRun(
      this.db,
      `INSERT INTO ai_tool_invocations (id, scan_run_id, task_id, tool_name, input_json, output_json, status, error_message, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.scan_run_id,
        input.task_id || null,
        input.tool_name,
        jsonStringify(input.input_json || {}),
        jsonStringify(input.output_json || {}),
        input.status || 'completed',
        input.error_message || null,
        input.started_at || new Date().toISOString(),
        input.completed_at || new Date().toISOString(),
      ]
    );
    const row = await dbGet<any>(this.db, 'SELECT * FROM ai_tool_invocations WHERE id = ?', [id]);
    return normalizeInvocation(row);
  }

  async listToolInvocations(scanRunId: string, taskId?: string): Promise<AIToolInvocation[]> {
    const rows = taskId
      ? await dbAll<any>(this.db, 'SELECT * FROM ai_tool_invocations WHERE scan_run_id = ? AND task_id = ? ORDER BY created_at DESC', [scanRunId, taskId])
      : await dbAll<any>(this.db, 'SELECT * FROM ai_tool_invocations WHERE scan_run_id = ? ORDER BY created_at DESC LIMIT 200', [scanRunId]);
    return rows.map(normalizeInvocation);
  }

  async getSnapshot(scanRunId: string): Promise<AIScanSnapshot> {
    const run = await this.getRun(scanRunId);
    if (!run) throw new Error(`AI scan run not found: ${scanRunId}`);
    const [tasks, endpoints, features, candidates, artifacts, sharedResources, toolInvocations] = await Promise.all([
      this.listTasks(scanRunId),
      this.listEndpoints(scanRunId),
      this.listFeatures(scanRunId),
      this.listCandidates(scanRunId),
      this.listArtifacts(scanRunId),
      this.listSharedResources(scanRunId),
      this.listToolInvocations(scanRunId),
    ]);
    return {
      run,
      tasks,
      endpoints,
      features,
      candidates,
      artifacts,
      shared_resources: sharedResources,
      tool_invocations: toolInvocations,
    };
  }
}
