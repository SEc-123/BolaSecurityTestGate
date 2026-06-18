import { v4 as uuidv4 } from 'uuid';
import type { DbProvider, DbRepositories, Repository, DbConfig, DbKind } from '../types/index.js';

// Simple in-memory repository implementation
class MemoryRepository<T> implements Repository<T> {
  private data: Map<string, T> = new Map();

  async findAll(options?: { where?: Partial<T>; limit?: number; offset?: number }): Promise<T[]> {
    let result = Array.from(this.data.values());
    
    if (options?.where) {
      result = result.filter(item => {
        return Object.entries(options.where!).every(([key, value]) => {
          return (item as any)[key] === value;
        });
      });
    }
    
    if (options?.offset) {
      result = result.slice(options.offset);
    }
    
    if (options?.limit) {
      result = result.slice(0, options.limit);
    }
    
    return result;
  }

  async findById(id: string): Promise<T | null> {
    return this.data.get(id) || null;
  }

  async create(data: Omit<T, 'id' | 'created_at' | 'updated_at'>): Promise<T> {
    const item = {
      ...data,
      id: uuidv4(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as unknown as T;
    
    this.data.set((item as any).id, item);
    return item;
  }

  async update(id: string, data: Partial<T>): Promise<T | null> {
    const existing = this.data.get(id);
    if (!existing) return null;
    
    const updated = {
      ...existing,
      ...data,
      updated_at: new Date().toISOString(),
    };
    
    this.data.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.data.delete(id);
  }

  async count(where?: Partial<T>): Promise<number> {
    if (!where) return this.data.size;
    
    return Array.from(this.data.values()).filter(item => {
      return Object.entries(where).every(([key, value]) => {
        return (item as any)[key] === value;
      });
    }).length;
  }
}

export class MemoryProvider implements DbProvider {
  private _repos: DbRepositories;
  private extraTables: Record<string, Map<string, any>> = { workflow_learning_suggestions: new Map(), workflow_learning_evidence: new Map(), workflow_variables: new Map(), workflow_mappings: new Map(), app_settings: new Map() };
  private connected = false;
  public kind: DbKind = 'memory';
  public profileId: string;

  constructor(name: string, config: DbConfig) {
    this.profileId = name;
    this._repos = {
      environments: new MemoryRepository(),
      accounts: new MemoryRepository(),
      apiTemplates: new MemoryRepository(),
      failurePatternTemplates: new MemoryRepository(),
      accountBindingTemplates: new MemoryRepository(),
      workflows: new MemoryRepository(),
      workflowSteps: new MemoryRepository(),
      workflowVariableConfigs: new MemoryRepository(),
      workflowExtractors: new MemoryRepository(),
      checklists: new MemoryRepository(),
      securityRules: new MemoryRepository(),
      recordingSessions: new MemoryRepository(),
      recordingEvents: new MemoryRepository(),
      recordingFieldTargets: new MemoryRepository(),
      recordingFieldHits: new MemoryRepository(),
      recordingRuntimeContext: new MemoryRepository(),
      recordingAccountApplyLogs: new MemoryRepository(),
      recordingAuditLogs: new MemoryRepository(),
      recordingDeadLetters: new MemoryRepository(),
      workflowDrafts: new MemoryRepository(),
      workflowDraftSteps: new MemoryRepository(),
      recordingExtractorCandidates: new MemoryRepository(),
      recordingVariableCandidates: new MemoryRepository(),
      testRunDrafts: new MemoryRepository(),
      testRunPresets: new MemoryRepository(),
      draftPublishLogs: new MemoryRepository(),
      testRuns: new MemoryRepository(),
      findings: new MemoryRepository(),
      cicdGatePolicies: new MemoryRepository(),
      securitySuites: new MemoryRepository(),
      securityRuns: new MemoryRepository(),
      findingSuppressionRules: new MemoryRepository(),
      findingDropRules: new MemoryRepository(),
      dbProfiles: new MemoryRepository(),
    };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async migrate(): Promise<void> {
    // No migration needed for in-memory database
  }

  get repos(): DbRepositories {
    if (!this.connected) {
      throw new Error('Database not connected');
    }
    return this._repos;
  }

  async ping(): Promise<boolean> {
    return this.connected;
  }

  async getSchemaVersion(): Promise<string> {
    return '1.0.0';
  }

  async runRawQuery(query: string, params: any[] = []): Promise<any[]> {
    const sql = query.trim();
    const upper = sql.toUpperCase();
    const tableMap: Record<string, any> = {
      environments: this._repos.environments,
      accounts: this._repos.accounts,
      api_templates: this._repos.apiTemplates,
      workflows: this._repos.workflows,
      workflow_steps: this._repos.workflowSteps,
      workflow_variable_configs: this._repos.workflowVariableConfigs,
      workflow_extractors: this._repos.workflowExtractors,
      checklists: this._repos.checklists,
      security_rules: this._repos.securityRules,
      recording_sessions: this._repos.recordingSessions,
      recording_events: this._repos.recordingEvents,
      recording_field_targets: this._repos.recordingFieldTargets,
      recording_field_hits: this._repos.recordingFieldHits,
      recording_runtime_context: this._repos.recordingRuntimeContext,
      recording_account_apply_logs: this._repos.recordingAccountApplyLogs,
      recording_audit_logs: this._repos.recordingAuditLogs,
      recording_dead_letters: this._repos.recordingDeadLetters,
      workflow_drafts: this._repos.workflowDrafts,
      workflow_draft_steps: this._repos.workflowDraftSteps,
      recording_extractor_candidates: this._repos.recordingExtractorCandidates,
      recording_variable_candidates: this._repos.recordingVariableCandidates,
      test_run_drafts: this._repos.testRunDrafts,
      test_run_presets: this._repos.testRunPresets,
      draft_publish_logs: this._repos.draftPublishLogs,
      test_runs: this._repos.testRuns,
      findings: this._repos.findings,
      cicd_gate_policies: this._repos.cicdGatePolicies,
      security_suites: this._repos.securitySuites,
      security_runs: this._repos.securityRuns,
      finding_suppression_rules: this._repos.findingSuppressionRules,
      finding_drop_rules: this._repos.findingDropRules,
      db_profiles: this._repos.dbProfiles,
      workflow_variables: null,
      workflow_mappings: null,
    };

    const getRows = async (table: string) => {
      const repo = tableMap[table];
      if (repo) return await repo.findAll();
      const extra = this.extraTables[table];
      if (extra) return Array.from(extra.values());
      return [];
    };

    if (upper.startsWith('SELECT')) {
      const match = sql.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      if (!match) return [];
      const table = match[1];
      let rows = await getRows(table);
      const wherePart = sql.match(/WHERE\s+(.+?)(ORDER BY|LIMIT|$)/i);
      if (wherePart) {
        const conditions = wherePart[1].split(/\s+AND\s+/i).map((part) => part.trim());
        rows = rows.filter((row: any) => {
          let paramIndex = 0;
          return conditions.every((condition) => {
            const inMatch = condition.match(/([a-zA-Z0-9_]+)\s+IN\s*\(([^)]+)\)/i);
            if (inMatch) {
              const col = inMatch[1];
              const placeholders = (inMatch[2].match(/\?/g) || []).length;
              const values = params.slice(paramIndex, paramIndex + placeholders);
              paramIndex += placeholders;
              return values.includes(row[col]);
            }
            const nullMatch = condition.match(/([a-zA-Z0-9_]+)\s+IS\s+NULL/i);
            if (nullMatch) return row[nullMatch[1]] == null;
            const eqMatch = condition.match(/([a-zA-Z0-9_]+)\s*=\s*\?/i);
            if (eqMatch) return row[eqMatch[1]] === params[paramIndex++];
            return true;
          });
        });
      }
      const orderMatch = sql.match(/ORDER BY\s+([a-zA-Z0-9_]+)(\s+DESC)?/i);
      if (orderMatch) {
        const key = orderMatch[1];
        const desc = !!orderMatch[2];
        rows = rows.sort((a: any, b: any) => {
          const av = a[key]; const bv = b[key];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (desc ? -1 : 1);
        });
      }
      return rows;
    }

    if (upper.startsWith('INSERT INTO')) {
      const match = sql.match(/INSERT INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)/i);
      if (!match) return [];
      const table = match[1];
      const cols = match[2].split(',').map((c) => c.trim());
      const row: any = {};
      cols.forEach((col, idx) => { row[col] = params[idx]; });
      if (!row.id) row.id = uuidv4();
      const extra = this.extraTables[table];
      if (extra) extra.set(row.id, row);
      return [];
    }

    if (upper.startsWith('UPDATE')) {
      const match = sql.match(/UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+?)\s+WHERE\s+(.+)/i);
      if (!match) return [];
      const table = match[1];
      const setClauses = match[2].split(',').map((c) => c.trim());
      const whereClause = match[3];
      let rows = await getRows(table);
      let whereParamIndex = setClauses.length;
      const whereMatch = whereClause.match(/([a-zA-Z0-9_]+)\s*=\s*\?/i);
      if (whereMatch) rows = rows.filter((row: any) => row[whereMatch[1]] === params[whereParamIndex]);
      for (const row of rows as any[]) {
        setClauses.forEach((clause, idx) => {
          const col = clause.split('=')[0].trim();
          row[col] = params[idx];
        });
        const repo = tableMap[table];
        if (repo && row.id) await repo.update(row.id, row);
        const extra = this.extraTables[table];
        if (extra && row.id) extra.set(row.id, row);
      }
      return [];
    }

    if (upper.startsWith('DELETE FROM')) {
      const match = sql.match(/DELETE FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+))?/i);
      if (!match) return [];
      const table = match[1];
      const whereClause = match[2];
      const rows = await getRows(table);
      if (!whereClause) {
        for (const row of rows as any[]) {
          const repo = tableMap[table];
          if (repo && row.id) await repo.delete(row.id);
          const extra = this.extraTables[table];
          if (extra && row.id) extra.delete(row.id);
        }
        return [];
      }
      const eqMatch = whereClause.match(/([a-zA-Z0-9_]+)\s*=\s*\?/i);
      if (eqMatch) {
        const key = eqMatch[1];
        const value = params[0];
        for (const row of rows as any[]) {
          if (row[key] === value) {
            const repo = tableMap[table];
            if (repo && row.id) await repo.delete(row.id);
            const extra = this.extraTables[table];
            if (extra && row.id) extra.delete(row.id);
          }
        }
      }
      return [];
    }

    return [];
  }

  async getStatus(): Promise<{ connected: boolean; schemaVersion: string; activeProfileName: string; runningRunsCount: number }> {
    return {
      connected: this.connected,
      schemaVersion: '1.0.0',
      activeProfileName: 'memory',
      runningRunsCount: 0,
    };
  }
}
