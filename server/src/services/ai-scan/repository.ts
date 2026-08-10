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
  AIGeneratedAsset,
  AIGeneratedAssetLifecycleStatus,
  AIScanSnapshot,
  AIScanTaskStatus,
  AIScanStatus,
} from './types.js';
import { normalizeOutputLanguage } from '../i18n/language.js';

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
    language: normalizeOutputLanguage(row.language),
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

function normalizeGeneratedAsset(row: any): AIGeneratedAsset {
  return {
    ...row,
    metadata_json: jsonParse<Record<string, any>>(row.metadata_json, {}),
  } as AIGeneratedAsset;
}

function normalizeInvocation(row: any): AIToolInvocation {
  return {
    ...row,
    input_json: jsonParse<Record<string, any>>(row.input_json, {}),
    output_json: jsonParse<Record<string, any>>(row.output_json, {}),
    contract_json: jsonParse<Record<string, any>>(row.contract_json, {}),
    traffic_json: jsonParse<Record<string, any>>(row.traffic_json, {}),
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
    language?: 'en' | 'zh';
    selected_vuln_types?: string[];
    scan_config?: Record<string, any>;
    environment_id?: string;
  }): Promise<AIScanRun> {
    const id = uuidv4();
    await dbRun(
      this.db,
      `INSERT INTO ai_scan_runs (id, name, base_url, user_prompt, language, status, current_phase, selected_vuln_types, scan_config, summary, environment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name || `AI Scan ${new Date().toISOString()}`,
        input.base_url,
        input.user_prompt || '',
        normalizeOutputLanguage(input.language),
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

  async registerGeneratedAsset(input: {
    scan_run_id: string;
    task_id?: string;
    asset_type: string;
    asset_id: string;
    lifecycle_status?: AIGeneratedAssetLifecycleStatus;
    retention_policy?: string;
    metadata_json?: Record<string, any>;
  }): Promise<AIGeneratedAsset> {
    const run = input.lifecycle_status ? null : await this.getRun(input.scan_run_id);
    const configuredDefault = run?.scan_config?.asset_lifecycle?.default_status === 'reusable' ? 'reusable' : 'ephemeral';
    const requestedStatus: AIGeneratedAssetLifecycleStatus = input.lifecycle_status || configuredDefault;
    const existing = await dbGet<any>(this.db, 'SELECT * FROM ai_generated_assets WHERE asset_type = ? AND asset_id = ? LIMIT 1', [input.asset_type, input.asset_id]);
    if (existing) {
      const currentStatus = String(existing.lifecycle_status || 'ephemeral') as AIGeneratedAssetLifecycleStatus;
      const rank: Record<AIGeneratedAssetLifecycleStatus, number> = { cleaned: -1, ephemeral: 0, reusable: 1, promoted: 2 };
      const nextStatus = currentStatus === 'cleaned'
        ? requestedStatus
        : (rank[requestedStatus] > rank[currentStatus] ? requestedStatus : currentStatus);
      const nextRetention = nextStatus === 'promoted'
        ? 'permanent'
        : nextStatus === 'reusable'
          ? (input.retention_policy || existing.retention_policy || 'retain_for_replay')
          : (input.retention_policy || existing.retention_policy || 'scan');
      await dbRun(this.db, `UPDATE ai_generated_assets SET lifecycle_status = ?, retention_policy = ?, metadata_json = ?, cleaned_at = CASE WHEN ? = 'cleaned' THEN cleaned_at ELSE NULL END, updated_at = ${nowExpression(this.db)} WHERE id = ?`, [
        nextStatus,
        nextRetention,
        jsonStringify({ ...jsonParse<Record<string, any>>(existing.metadata_json, {}), ...(input.metadata_json || {}) }),
        nextStatus,
        existing.id,
      ]);
      const row = await dbGet<any>(this.db, 'SELECT * FROM ai_generated_assets WHERE id = ?', [existing.id]);
      return normalizeGeneratedAsset(row);
    }
    const id = uuidv4();
    await dbRun(this.db, `INSERT INTO ai_generated_assets (id, scan_run_id, task_id, asset_type, asset_id, lifecycle_status, retention_policy, generated_by, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai_agent', ?)`, [
      id,
      input.scan_run_id,
      input.task_id || null,
      input.asset_type,
      input.asset_id,
      requestedStatus,
      input.retention_policy || (requestedStatus === 'reusable' ? 'retain_for_replay' : requestedStatus === 'promoted' ? 'permanent' : 'scan'),
      jsonStringify(input.metadata_json || {}),
    ]);
    const row = await dbGet<any>(this.db, 'SELECT * FROM ai_generated_assets WHERE id = ?', [id]);
    return normalizeGeneratedAsset(row);
  }

  async registerGeneratedAssets(scanRunId: string, taskId: string | undefined, assets: Array<{ asset_type: string; asset_id?: string | null; metadata_json?: Record<string, any> }>): Promise<AIGeneratedAsset[]> {
    const results: AIGeneratedAsset[] = [];
    for (const asset of assets) {
      if (!asset.asset_id) continue;
      results.push(await this.registerGeneratedAsset({ scan_run_id: scanRunId, task_id: taskId, asset_type: asset.asset_type, asset_id: asset.asset_id, metadata_json: asset.metadata_json }));
    }
    return results;
  }

  async listGeneratedAssets(scanRunId: string, status?: AIGeneratedAssetLifecycleStatus): Promise<AIGeneratedAsset[]> {
    const rows = status
      ? await dbAll<any>(this.db, 'SELECT * FROM ai_generated_assets WHERE scan_run_id = ? AND lifecycle_status = ? ORDER BY created_at ASC', [scanRunId, status])
      : await dbAll<any>(this.db, 'SELECT * FROM ai_generated_assets WHERE scan_run_id = ? ORDER BY created_at ASC', [scanRunId]);
    return rows.map(normalizeGeneratedAsset);
  }

  async promoteGeneratedAsset(scanRunId: string, registryId: string): Promise<AIGeneratedAsset> {
    const existing = await dbGet<any>(this.db, 'SELECT * FROM ai_generated_assets WHERE id = ? AND scan_run_id = ?', [registryId, scanRunId]);
    if (!existing) throw new Error(`Generated asset not found: ${registryId}`);
    if (existing.lifecycle_status === 'cleaned') throw new Error(`Generated asset has already been cleaned and cannot be promoted: ${registryId}`);
    await dbRun(this.db, `UPDATE ai_generated_assets SET lifecycle_status = 'promoted', retention_policy = 'permanent', promoted_at = COALESCE(promoted_at, ${nowExpression(this.db)}), updated_at = ${nowExpression(this.db)} WHERE id = ? AND scan_run_id = ?`, [registryId, scanRunId]);
    const row = await dbGet<any>(this.db, 'SELECT * FROM ai_generated_assets WHERE id = ? AND scan_run_id = ?', [registryId, scanRunId]);
    return normalizeGeneratedAsset(row);
  }

  async retainGeneratedAssetsForReplay(scanRunId: string, assetIds: string[]): Promise<void> {
    const ids = Array.from(new Set(assetIds.filter(Boolean)));
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await dbRun(this.db, `UPDATE ai_generated_assets SET lifecycle_status = CASE WHEN lifecycle_status = 'promoted' THEN lifecycle_status ELSE 'reusable' END, retention_policy = CASE WHEN lifecycle_status = 'promoted' THEN retention_policy ELSE 'retain_for_replay' END, updated_at = ${nowExpression(this.db)} WHERE scan_run_id = ? AND asset_id IN (${placeholders})`, [scanRunId, ...ids]);
  }

  async cleanupEphemeralGeneratedAssets(scanRunId: string): Promise<{ cleaned: number; failed: Array<{ registry_id: string; asset_type: string; asset_id: string; error: string }> }> {
    const assets = await this.listGeneratedAssets(scanRunId, 'ephemeral');
    const tableByType: Record<string, string> = {
      workflow_mapping: 'workflow_mappings',
      workflow_extractor: 'workflow_extractors',
      workflow_variable_config: 'workflow_variable_configs',
      workflow_variable: 'workflow_variables',
      test_run: 'test_runs',
      workflow: 'workflows',
      api_template: 'api_templates',
      security_rule: 'security_rules',
      checklist: 'checklists',
      account: 'accounts',
      environment: 'environments',
    };
    const order: Record<string, number> = { workflow_mapping: 1, workflow_extractor: 2, workflow_variable_config: 3, workflow_variable: 4, test_run: 5, workflow: 6, api_template: 7, security_rule: 8, checklist: 9, account: 10, environment: 11 };
    assets.sort((a, b) => (order[a.asset_type] || 50) - (order[b.asset_type] || 50));
    let cleaned = 0;
    const failed: Array<{ registry_id: string; asset_type: string; asset_id: string; error: string }> = [];
    for (const asset of assets) {
      const table = tableByType[asset.asset_type];
      try {
        if (!table) throw new Error(`Unsupported generated asset type for cleanup: ${asset.asset_type}`);
        await dbRun(this.db, `DELETE FROM ${table} WHERE id = ?`, [asset.asset_id]);
        await dbRun(this.db, `UPDATE ai_generated_assets SET lifecycle_status = 'cleaned', cleaned_at = ${nowExpression(this.db)}, updated_at = ${nowExpression(this.db)} WHERE id = ?`, [asset.id]);
        cleaned += 1;
      } catch (error: any) {
        failed.push({ registry_id: asset.id, asset_type: asset.asset_type, asset_id: asset.asset_id, error: error?.message || String(error) });
      }
    }
    return { cleaned, failed };
  }

  async resolveFindingProvenance(task: AIScanTask, endpointId?: string): Promise<{ ai_scan_run_id: string; ai_scan_task_id: string; ai_campaign_task_id?: string; ai_candidate_id?: string; ai_feature_id?: string; ai_endpoint_id?: string }> {
    let campaignTaskId: string | undefined;
    let cursor: AIScanTask | null = task;
    const seen = new Set<string>();
    while (cursor?.parent_task_id && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parent = await this.getTask(cursor.parent_task_id);
      if (!parent) break;
      if (parent.task_type === 'vulnerability_campaign' || parent.execution_plan?.intent === 'vulnerability_campaign') campaignTaskId = parent.id;
      cursor = parent;
    }
    if (!campaignTaskId && task.parent_task_id) campaignTaskId = task.parent_task_id;
    const candidates = await this.listCandidates(task.scan_run_id);
    const candidate = candidates.find(item => item.id === task.execution_plan?.candidate_id)
      || candidates.find(item => item.vuln_type === task.vuln_type && (!endpointId || item.endpoint_ids.includes(endpointId)) && (!task.feature_id || item.feature_id === task.feature_id));
    return {
      ai_scan_run_id: task.scan_run_id,
      ai_scan_task_id: task.id,
      ai_campaign_task_id: campaignTaskId,
      ai_candidate_id: candidate?.id,
      ai_feature_id: task.feature_id || candidate?.feature_id,
      ai_endpoint_id: endpointId,
    };
  }

  async recordFindingProvenance(findingId: string, provenance: {
    ai_scan_run_id: string;
    ai_scan_task_id: string;
    ai_campaign_task_id?: string;
    ai_candidate_id?: string;
    ai_feature_id?: string;
    ai_endpoint_id?: string;
  }, evidenceContractId?: string): Promise<void> {
    const existing = await dbGet<any>(this.db, 'SELECT finding_id FROM ai_finding_provenance WHERE finding_id = ? LIMIT 1', [findingId]);
    const values = [
      provenance.ai_scan_run_id,
      provenance.ai_scan_task_id,
      provenance.ai_campaign_task_id || null,
      provenance.ai_candidate_id || null,
      provenance.ai_feature_id || null,
      provenance.ai_endpoint_id || null,
      evidenceContractId || null,
    ];
    if (existing?.finding_id) {
      // Preserve the first canonical origin of a deduplicated finding. Later duplicate
      // paths may enrich missing optional links but must not reassign ownership to a
      // different task/campaign and make earlier campaign summaries disappear.
      await dbRun(this.db, `UPDATE ai_finding_provenance
        SET campaign_task_id = COALESCE(campaign_task_id, ?),
            candidate_id = COALESCE(candidate_id, ?),
            feature_id = COALESCE(feature_id, ?),
            endpoint_id = COALESCE(endpoint_id, ?),
            evidence_contract_id = COALESCE(evidence_contract_id, ?),
            updated_at = ${nowExpression(this.db)}
        WHERE finding_id = ?`, [
        provenance.ai_campaign_task_id || null,
        provenance.ai_candidate_id || null,
        provenance.ai_feature_id || null,
        provenance.ai_endpoint_id || null,
        evidenceContractId || null,
        findingId,
      ]);
      return;
    }
    await dbRun(this.db, `INSERT INTO ai_finding_provenance (
      finding_id, scan_run_id, task_id, campaign_task_id, candidate_id, feature_id, endpoint_id, evidence_contract_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [findingId, ...values]);
  }

  async getFindingProvenance(findingId: string): Promise<Record<string, any> | null> {
    return dbGet<any>(this.db, 'SELECT * FROM ai_finding_provenance WHERE finding_id = ? LIMIT 1', [findingId]);
  }

  async createToolInvocation(input: {
    scan_run_id: string;
    task_id?: string;
    tool_name: string;
    input_json?: Record<string, any>;
    output_json?: Record<string, any>;
    contract_json?: Record<string, any>;
    traffic_json?: Record<string, any>;
    status?: string;
    error_message?: string;
    started_at?: string;
    completed_at?: string;
  }): Promise<AIToolInvocation> {
    const id = uuidv4();
    await dbRun(
      this.db,
      `INSERT INTO ai_tool_invocations (id, scan_run_id, task_id, tool_name, input_json, output_json, contract_json, traffic_json, status, error_message, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.scan_run_id,
        input.task_id || null,
        input.tool_name,
        jsonStringify(input.input_json || {}),
        jsonStringify(input.output_json || {}),
        jsonStringify(input.contract_json || {}),
        jsonStringify(input.traffic_json || {}),
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

  async getLatestTrafficSnapshot(scanRunId: string): Promise<Record<string, any> | null> {
    const rows = await dbAll<any>(this.db, 'SELECT traffic_json FROM ai_tool_invocations WHERE scan_run_id = ? ORDER BY completed_at DESC, created_at DESC LIMIT 20', [scanRunId]);
    for (const row of rows) {
      const value = jsonParse<Record<string, any>>(row.traffic_json, {});
      if (Number(value.total_requests || 0) > 0 || Object.keys(value.endpoint_counts || {}).length > 0) return value;
    }
    return null;
  }

  async getSnapshot(scanRunId: string): Promise<AIScanSnapshot> {
    const run = await this.getRun(scanRunId);
    if (!run) throw new Error(`AI scan run not found: ${scanRunId}`);
    const [tasks, endpoints, features, candidates, artifacts, sharedResources, generatedAssets, toolInvocations] = await Promise.all([
      this.listTasks(scanRunId),
      this.listEndpoints(scanRunId),
      this.listFeatures(scanRunId),
      this.listCandidates(scanRunId),
      this.listArtifacts(scanRunId),
      this.listSharedResources(scanRunId),
      this.listGeneratedAssets(scanRunId),
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
      generated_assets: generatedAssets,
      tool_invocations: toolInvocations,
    };
  }
}
