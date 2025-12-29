import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { DbProvider, DbRepositories, Repository, DbConfig } from '../types/index.js';
import { SQLITE_SCHEMA, SCHEMA_VERSION } from './schema.js';

const JSON_FIELD_DEFAULTS: Record<string, any> = {
  tags: [],
  auth_profile: {},
  variables: [],
  fields: {},
  parsed_structure: {},
  failure_patterns: [],
  baseline_config: {},
  advanced_config: {},
  critical_step_orders: [],
  session_jar_config: {},
  step_assertions: [],
  failure_patterns_override: [],
  step_variable_mappings: [],
  transform: null,
  config: {},
  payloads: [],
  rule_ids: [],
  template_ids: [],
  account_ids: [],
  execution_params: {},
  progress: {},
  validation_report: null,
  variable_values: {},
  response_headers: {},
  request_evidence: {},
  response_evidence: {},
  ai_analysis: {},
  evidence_comparison: {},
  account_source_map: {},
  victim_account_ids: [],
  baseline_response: null,
  mutated_response: null,
  response_diff: null,
  rules_test: [],
  rules_workflow: [],
  metadata: {},
  account_scope_ids: [],
};

function getJsonDefault(field: string): any {
  return JSON_FIELD_DEFAULTS[field] ?? null;
}

function parseJson<T>(value: string | null | undefined, defaultValue: T): T {
  if (!value) return defaultValue;
  try { return JSON.parse(value); } catch { return defaultValue; }
}

function toJson(value: any): string {
  return JSON.stringify(value ?? null);
}

function boolToInt(value: boolean | undefined): number {
  return value ? 1 : 0;
}

function intToBool(value: number | undefined): boolean {
  return value === 1;
}

function createSqliteRepository<T extends { id: string }>(
  db: Database.Database,
  tableName: string,
  jsonFields: string[] = [],
  boolFields: string[] = []
): Repository<T> {
  const parseRow = (row: any): T => {
    if (!row) return row;
    const result = { ...row };
    for (const field of jsonFields) {
      if (result[field] !== undefined) {
        result[field] = parseJson(result[field], getJsonDefault(field));
      }
    }
    for (const field of boolFields) {
      if (result[field] !== undefined) {
        result[field] = intToBool(result[field]);
      }
    }
    return result as T;
  };

  const prepareValue = (key: string, value: any): any => {
    if (jsonFields.includes(key)) return toJson(value);
    if (boolFields.includes(key)) return boolToInt(value);
    return value;
  };

  return {
    async findAll(options = {}): Promise<T[]> {
      let sql = `SELECT * FROM ${tableName}`;
      const params: any[] = [];

      if (options.where && Object.keys(options.where).length > 0) {
        const conditions = Object.entries(options.where).map(([key, value]) => {
          params.push(prepareValue(key, value));
          return `${key} = ?`;
        });
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      sql += ` ORDER BY created_at DESC`;

      if (options.limit) {
        sql += ` LIMIT ?`;
        params.push(options.limit);
      }
      if (options.offset) {
        sql += ` OFFSET ?`;
        params.push(options.offset);
      }

      const rows = db.prepare(sql).all(...params);
      return rows.map(parseRow);
    },

    async findById(id: string): Promise<T | null> {
      const row = db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id);
      return parseRow(row);
    },

    async create(data: Omit<T, 'id' | 'created_at' | 'updated_at'>): Promise<T> {
      const id = uuidv4();
      const now = new Date().toISOString();
      const fullData = { ...data, id, created_at: now, updated_at: now };

      const keys = Object.keys(fullData);
      const values = keys.map(k => prepareValue(k, (fullData as any)[k]));
      const placeholders = keys.map(() => '?').join(', ');

      db.prepare(`INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders})`).run(...values);
      return this.findById(id) as Promise<T>;
    },

    async update(id: string, data: Partial<T>): Promise<T | null> {
      const updateData = { ...data, updated_at: new Date().toISOString() };
      delete (updateData as any).id;
      delete (updateData as any).created_at;

      const keys = Object.keys(updateData);
      if (keys.length === 0) return this.findById(id);

      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values = keys.map(k => prepareValue(k, (updateData as any)[k]));
      values.push(id);

      db.prepare(`UPDATE ${tableName} SET ${setClause} WHERE id = ?`).run(...values);
      return this.findById(id);
    },

    async delete(id: string): Promise<boolean> {
      const result = db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
      return result.changes > 0;
    },

    async count(where?: Partial<T>): Promise<number> {
      let sql = `SELECT COUNT(*) as count FROM ${tableName}`;
      const params: any[] = [];

      if (where && Object.keys(where).length > 0) {
        const conditions = Object.entries(where).map(([key, value]) => {
          params.push(prepareValue(key, value));
          return `${key} = ?`;
        });
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      const row = db.prepare(sql).get(...params) as { count: number };
      return row.count;
    }
  };
}

export class SqliteProvider implements DbProvider {
  kind = 'sqlite' as const;
  profileId: string;
  private db: Database.Database | null = null;
  private config: DbConfig;
  repos!: DbRepositories;

  constructor(profileId: string, config: DbConfig) {
    this.profileId = profileId;
    this.config = config;
  }

  async connect(): Promise<void> {
    const filePath = this.config.file || './data/app.db';
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initRepositories();
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async ping(): Promise<boolean> {
    if (!this.db) return false;
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async getSchemaVersion(): Promise<string> {
    if (!this.db) throw new Error('Database not connected');
    try {
      const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get() as { value: string } | undefined;
      return row?.value || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  async migrate(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    const statements = SQLITE_SCHEMA.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        this.db.prepare(stmt).run();
      }
    }

    const alterStatements = [
      { table: 'api_templates', column: 'rate_limit_override', type: 'INTEGER' },
      { table: 'test_runs', column: 'dropped_count', type: 'INTEGER DEFAULT 0' },
      { table: 'test_runs', column: 'findings_count_effective', type: 'INTEGER DEFAULT 0' },
      { table: 'test_runs', column: 'suppressed_count_rule', type: 'INTEGER DEFAULT 0' },
      { table: 'test_runs', column: 'suppressed_count_rate_limit', type: 'INTEGER DEFAULT 0' },
      { table: 'findings', column: 'suppressed_reason', type: 'TEXT' },
      { table: 'workflows', column: 'workflow_type', type: 'TEXT DEFAULT "baseline"' },
      { table: 'workflows', column: 'base_workflow_id', type: 'TEXT' },
      { table: 'workflows', column: 'learning_status', type: 'TEXT DEFAULT "unlearned"' },
      { table: 'workflows', column: 'learning_version', type: 'INTEGER DEFAULT 0' },
      { table: 'workflows', column: 'template_mode', type: 'TEXT DEFAULT "reference"' },
      { table: 'workflows', column: 'mutation_profile', type: 'TEXT' },
      { table: 'workflow_steps', column: 'request_snapshot_raw', type: 'TEXT' },
      { table: 'workflow_steps', column: 'failure_patterns_snapshot', type: 'TEXT' },
      { table: 'workflow_steps', column: 'snapshot_template_name', type: 'TEXT' },
      { table: 'workflow_steps', column: 'snapshot_template_id', type: 'TEXT' },
      { table: 'workflow_steps', column: 'snapshot_created_at', type: 'TEXT' },
    ];

    for (const { table, column, type } of alterStatements) {
      try {
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
      } catch {
      }
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)
    `).run(SCHEMA_VERSION);
  }

  async runRawQuery<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    if (!this.db) throw new Error('Database not connected');
    const stmt = this.db.prepare(sql);
    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      return stmt.all(...params) as T[];
    }
    stmt.run(...params);
    return [];
  }

  private initRepositories(): void {
    if (!this.db) throw new Error('Database not connected');

    this.repos = {
      environments: createSqliteRepository(this.db, 'environments', [], ['is_active']),
      accounts: createSqliteRepository(this.db, 'accounts', ['tags', 'auth_profile', 'variables', 'fields'], []),
      apiTemplates: createSqliteRepository(this.db, 'api_templates', ['parsed_structure', 'variables', 'failure_patterns', 'baseline_config', 'advanced_config'], ['is_active', 'enable_baseline']),
      workflows: createSqliteRepository(this.db, 'workflows', ['critical_step_orders', 'baseline_config', 'session_jar_config', 'mutation_profile'], ['is_active', 'enable_baseline', 'enable_extractor', 'enable_session_jar']),
      workflowSteps: createSqliteRepository(this.db, 'workflow_steps', ['step_assertions', 'failure_patterns_override', 'failure_patterns_snapshot'], []),
      workflowVariableConfigs: createSqliteRepository(this.db, 'workflow_variable_configs', ['step_variable_mappings', 'advanced_config', 'account_scope_ids'], ['is_attacker_field']),
      workflowExtractors: createSqliteRepository(this.db, 'workflow_extractors', ['transform'], ['required']),
      checklists: createSqliteRepository(this.db, 'checklists', ['config'], []),
      securityRules: createSqliteRepository(this.db, 'security_rules', ['payloads'], []),
      testRuns: createSqliteRepository(this.db, 'test_runs', ['rule_ids', 'template_ids', 'account_ids', 'execution_params', 'progress', 'validation_report'], ['has_execution_error']),
      findings: createSqliteRepository(this.db, 'findings', ['variable_values', 'response_headers', 'request_evidence', 'response_evidence', 'ai_analysis', 'evidence_comparison', 'account_source_map', 'victim_account_ids', 'baseline_response', 'mutated_response', 'response_diff'], ['is_suppressed']),
      cicdGatePolicies: createSqliteRepository(this.db, 'cicd_gate_policies', ['rules_test', 'rules_workflow'], ['is_enabled']),
      securitySuites: createSqliteRepository(this.db, 'security_suites', ['template_ids', 'workflow_ids', 'account_ids'], ['is_enabled']),
      securityRuns: createSqliteRepository(this.db, 'security_runs', ['metadata'], []),
      findingSuppressionRules: createSqliteRepository(this.db, 'finding_suppression_rules', [], ['is_enabled']),
      findingDropRules: createSqliteRepository(this.db, 'finding_drop_rules', [], ['is_enabled']),
      dbProfiles: createSqliteRepository(this.db, 'db_profiles', ['config'], ['is_active']),
    } as any;
  }
}
