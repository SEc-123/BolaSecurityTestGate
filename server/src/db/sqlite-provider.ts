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
  checklist_ids: [],
  security_rule_ids: [],
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
  target_fields: [],
  requested_field_names: [],
  capture_filters: {},
  aliases: [],
  from_sources: [],
  summary: {},
  details: {},
  payload: {},
  target_snapshot: {},
  field_changes: [],
  auth_profile_changes: [],
  variable_changes: [],
  query_params: {},
  request_headers: {},
  request_cookies: {},
  parsed_request_body: null,
  response_cookies: {},
  parsed_response_body: null,
  draft_payload: {},
  request_template_payload: {},
  response_signature: {},
  preset_config: {},
  suggestion_payload: {},
  evidence_payload: {},
};

function getJsonDefault(field: string): any {
  return JSON_FIELD_DEFAULTS[field] ?? null;
}

function rebuildRecordingSessionsTable(db: Database.Database): void {
  db.prepare('PRAGMA foreign_keys = OFF').run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS recording_sessions_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('workflow', 'api')),
      intent TEXT DEFAULT 'workflow_seed' CHECK (intent IN ('account_capture', 'api_test_seed', 'workflow_seed', 'learning_seed')),
      status TEXT DEFAULT 'recording' CHECK (status IN ('recording', 'processing', 'completed', 'finished', 'published', 'failed')),
      source_tool TEXT,
      account_label TEXT,
      requested_field_names TEXT DEFAULT '[]',
      capture_filters TEXT DEFAULT '{}',
      environment_id TEXT,
      account_id TEXT,
      role TEXT,
      target_fields TEXT DEFAULT '[]',
      event_count INTEGER DEFAULT 0,
      field_hit_count INTEGER DEFAULT 0,
      runtime_context_count INTEGER DEFAULT 0,
      generated_result_count INTEGER DEFAULT 0,
      published_result_count INTEGER DEFAULT 0,
      summary TEXT DEFAULT '{}',
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
    )
  `).run();
  db.prepare(`
    INSERT OR REPLACE INTO recording_sessions_new (
      id, name, mode, intent, status, source_tool, account_label, requested_field_names, capture_filters, environment_id, account_id, role, target_fields,
      event_count, field_hit_count, runtime_context_count, generated_result_count, published_result_count,
      summary, started_at, finished_at, created_at, updated_at
    )
    SELECT
      id, name, mode,
      CASE
        WHEN mode = 'api' THEN 'api_test_seed'
        ELSE 'workflow_seed'
      END,
      status, source_tool, NULL, '[]', '{}', environment_id, account_id, role, target_fields,
      event_count, field_hit_count, runtime_context_count, generated_result_count, published_result_count,
      summary, started_at, finished_at, created_at, updated_at
    FROM recording_sessions
  `).run();
  db.prepare('DROP TABLE recording_sessions').run();
  db.prepare('ALTER TABLE recording_sessions_new RENAME TO recording_sessions').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_recording_sessions_status ON recording_sessions(status, mode)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_recording_sessions_environment ON recording_sessions(environment_id)').run();
  db.prepare('PRAGMA foreign_keys = ON').run();
}

function rebuildTestRunDraftsTable(db: Database.Database): void {
  db.prepare('PRAGMA foreign_keys = OFF').run();
  const columns = db.prepare(`PRAGMA table_info(test_run_drafts)`).all() as Array<{ name: string }>;
  const hasPublishedPresetId = columns.some(column => column.name === 'published_preset_id');
  const hasSuggestionSummary = columns.some(column => column.name === 'suggestion_summary');
  const hasReviewDecisions = columns.some(column => column.name === 'review_decisions');
  const hasIntent = columns.some(column => column.name === 'intent');
  const hasDraftStatus = columns.some(column => column.name === 'draft_status');
  const hasPublishedTemplateId = columns.some(column => column.name === 'published_template_id');
  db.prepare(`
    CREATE TABLE IF NOT EXISTS test_run_drafts_new (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'generated' CHECK (status IN ('generated', 'reviewing', 'approved', 'preconfigured', 'published', 'run_created', 'archived')),
      sequence INTEGER,
      source_event_id TEXT,
      summary TEXT DEFAULT '{}',
      suggestion_summary TEXT DEFAULT '{}',
      review_decisions TEXT DEFAULT '{}',
      draft_payload TEXT DEFAULT '{}',
      intent TEXT DEFAULT 'api_test_seed',
      draft_status TEXT DEFAULT 'generated',
      published_template_id TEXT,
      published_preset_id TEXT,
      published_test_run_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (source_event_id) REFERENCES recording_events(id) ON DELETE SET NULL
    )
  `).run();
  if (hasPublishedPresetId) {
    db.prepare(`
      INSERT OR REPLACE INTO test_run_drafts_new (
        id, session_id, name, status, sequence, source_event_id, summary, suggestion_summary, review_decisions, draft_payload,
        intent, draft_status, published_template_id, published_preset_id, published_test_run_id, created_at, updated_at
      )
      SELECT
        id, session_id, name,
        CASE
          WHEN status NOT IN ('generated', 'reviewing', 'approved', 'preconfigured', 'published', 'run_created', 'archived') THEN 'generated'
          ELSE status
        END,
        sequence, source_event_id, summary,
        __HAS_SUGGESTION_SUMMARY__,
        __HAS_REVIEW_DECISIONS__,
        draft_payload,
        __HAS_INTENT__,
        __HAS_DRAFT_STATUS__,
        __HAS_PUBLISHED_TEMPLATE__,
        published_preset_id, published_test_run_id, created_at, updated_at
      FROM test_run_drafts
    `
      .replace('__HAS_SUGGESTION_SUMMARY__', hasSuggestionSummary ? 'suggestion_summary' : "'{}'")
      .replace('__HAS_REVIEW_DECISIONS__', hasReviewDecisions ? 'review_decisions' : "'{}'")
      .replace('__HAS_INTENT__', hasIntent ? 'intent' : "'api_test_seed'")
      .replace('__HAS_DRAFT_STATUS__', hasDraftStatus ? 'draft_status' : "CASE WHEN status = 'published' THEN 'published' ELSE 'generated' END")
      .replace('__HAS_PUBLISHED_TEMPLATE__', hasPublishedTemplateId ? 'published_template_id' : 'NULL')
    ).run();
  } else {
    db.prepare(`
      INSERT OR REPLACE INTO test_run_drafts_new (
        id, session_id, name, status, sequence, source_event_id, summary, suggestion_summary, review_decisions, draft_payload,
        intent, draft_status, published_template_id, published_preset_id, published_test_run_id, created_at, updated_at
      )
      SELECT
        id, session_id, name,
        CASE
          WHEN status NOT IN ('generated', 'reviewing', 'approved', 'preconfigured', 'published', 'run_created', 'archived') THEN 'generated'
          ELSE status
        END,
        sequence, source_event_id, summary, '{}', '{}', draft_payload,
        'api_test_seed', CASE WHEN status = 'published' THEN 'published' ELSE 'generated' END, NULL,
        published_test_run_id, NULL, created_at, updated_at
      FROM test_run_drafts
    `).run();
  }
  db.prepare('DROP TABLE test_run_drafts').run();
  db.prepare('ALTER TABLE test_run_drafts_new RENAME TO test_run_drafts').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_test_run_drafts_session_id ON test_run_drafts(session_id)').run();
  db.prepare('PRAGMA foreign_keys = ON').run();
}

function rebuildFieldDictionaryTable(db: Database.Database): void {
  db.prepare('PRAGMA foreign_keys = OFF').run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS field_dictionary_new (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      scope_id TEXT,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('AUTH', 'IDENTITY', 'FLOW_TICKET', 'OBJECT_ID', 'NOISE')),
      priority INTEGER DEFAULT 0,
      is_enabled INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare(`
    INSERT OR REPLACE INTO field_dictionary_new (
      id, scope, scope_id, pattern, category, priority, is_enabled, notes, created_at, updated_at
    )
    SELECT
      id, scope, scope_id, pattern,
      CASE
        WHEN id IN ('dict_001', 'dict_002') THEN 'AUTH'
        ELSE category
      END,
      priority, is_enabled, notes, created_at, updated_at
    FROM field_dictionary
  `).run();
  db.prepare('DROP TABLE field_dictionary').run();
  db.prepare('ALTER TABLE field_dictionary_new RENAME TO field_dictionary').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_field_dictionary_enabled ON field_dictionary(is_enabled, priority DESC)').run();
  db.prepare('PRAGMA foreign_keys = ON').run();
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

    const existingSchemaVersion = await this.getSchemaVersion();

    const statements = SQLITE_SCHEMA.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        try {
          this.db.prepare(stmt).run();
        } catch (error: any) {
          if (!String(error?.message || '').includes('no such column')) {
            throw error;
          }
        }
      }
    }

    const alterStatements = [
      { table: 'api_templates', column: 'rate_limit_override', type: 'INTEGER' },
      { table: 'api_templates', column: 'source_recording_session_id', type: 'TEXT' },
      { table: 'api_templates', column: 'failure_template_id', type: 'TEXT' },
      { table: 'api_templates', column: 'account_binding_template_id', type: 'TEXT' },
      { table: 'test_runs', column: 'dropped_count', type: 'INTEGER DEFAULT 0' },
      { table: 'test_runs', column: 'findings_count_effective', type: 'INTEGER DEFAULT 0' },
      { table: 'test_runs', column: 'suppressed_count_rule', type: 'INTEGER DEFAULT 0' },
      { table: 'test_runs', column: 'suppressed_count_rate_limit', type: 'INTEGER DEFAULT 0' },
      { table: 'test_runs', column: 'source_recording_session_id', type: 'TEXT' },
      { table: 'test_runs', column: 'updated_at', type: 'TEXT' },
      { table: 'findings', column: 'suppressed_reason', type: 'TEXT' },
      { table: 'findings', column: 'workflow_name', type: 'TEXT' },
      { table: 'workflows', column: 'workflow_type', type: 'TEXT DEFAULT "baseline"' },
      { table: 'workflows', column: 'base_workflow_id', type: 'TEXT' },
      { table: 'workflows', column: 'learning_status', type: 'TEXT DEFAULT "unlearned"' },
      { table: 'workflows', column: 'learning_version', type: 'INTEGER DEFAULT 0' },
      { table: 'workflows', column: 'learning_source_preference', type: 'TEXT DEFAULT "execution_only"' },
      { table: 'workflows', column: 'last_learning_session_id', type: 'TEXT' },
      { table: 'workflows', column: 'last_learning_mode', type: 'TEXT' },
      { table: 'workflows', column: 'template_mode', type: 'TEXT DEFAULT "reference"' },
      { table: 'workflows', column: 'mutation_profile', type: 'TEXT' },
      { table: 'workflows', column: 'source_recording_session_id', type: 'TEXT' },
      { table: 'security_suites', column: 'checklist_ids', type: 'TEXT DEFAULT "[]"' },
      { table: 'security_suites', column: 'security_rule_ids', type: 'TEXT DEFAULT "[]"' },
      { table: 'workflow_steps', column: 'request_snapshot_raw', type: 'TEXT' },
      { table: 'workflow_steps', column: 'failure_patterns_snapshot', type: 'TEXT' },
      { table: 'workflow_steps', column: 'snapshot_template_name', type: 'TEXT' },
      { table: 'workflow_steps', column: 'snapshot_template_id', type: 'TEXT' },
        { table: 'workflow_steps', column: 'snapshot_created_at', type: 'TEXT' },
        { table: 'workflow_steps', column: 'updated_at', type: 'TEXT' },
        { table: 'workflow_variable_configs', column: 'updated_at', type: 'TEXT' },
      { table: 'workflow_extractors', column: 'updated_at', type: 'TEXT' },
      { table: 'recording_variable_candidates', column: 'advanced_config', type: 'TEXT DEFAULT "{}"' },
      { table: 'recording_field_hits', column: 'value_text', type: 'TEXT' },
      { table: 'draft_publish_logs', column: 'source_recording_session_id', type: 'TEXT' },
      { table: 'test_run_drafts', column: 'published_preset_id', type: 'TEXT' },
      { table: 'test_run_drafts', column: 'published_template_id', type: 'TEXT' },
      { table: 'test_run_drafts', column: 'suggestion_summary', type: 'TEXT DEFAULT "{}"' },
      { table: 'test_run_drafts', column: 'review_decisions', type: 'TEXT DEFAULT "{}"' },
      { table: 'test_run_drafts', column: 'intent', type: 'TEXT DEFAULT "api_test_seed"' },
      { table: 'test_run_drafts', column: 'draft_status', type: 'TEXT DEFAULT "generated"' },
      ];

      for (const { table, column, type } of alterStatements) {
        try {
          this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
        } catch {
        }
      }

      const postAlterIndexStatements = [
      'CREATE INDEX IF NOT EXISTS idx_api_templates_source_recording_session ON api_templates(source_recording_session_id)',
      'CREATE INDEX IF NOT EXISTS idx_api_templates_failure_template_id ON api_templates(failure_template_id)',
      'CREATE INDEX IF NOT EXISTS idx_api_templates_account_binding_template_id ON api_templates(account_binding_template_id)',
      'CREATE INDEX IF NOT EXISTS idx_failure_pattern_templates_name ON failure_pattern_templates(name)',
      'CREATE INDEX IF NOT EXISTS idx_account_binding_templates_name ON account_binding_templates(name)',
      'CREATE INDEX IF NOT EXISTS idx_workflows_source_recording_session ON workflows(source_recording_session_id)',
      'CREATE INDEX IF NOT EXISTS idx_test_runs_source_recording_session ON test_runs(source_recording_session_id)',
      'CREATE INDEX IF NOT EXISTS idx_draft_publish_logs_target_asset ON draft_publish_logs(target_asset_type, target_asset_id)',
      'CREATE INDEX IF NOT EXISTS idx_draft_publish_logs_source_recording_session ON draft_publish_logs(source_recording_session_id)',
      'CREATE INDEX IF NOT EXISTS idx_recording_audit_logs_session_id ON recording_audit_logs(session_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_recording_audit_logs_action ON recording_audit_logs(action, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_recording_dead_letters_status ON recording_dead_letters(status, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_recording_dead_letters_session_id ON recording_dead_letters(session_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_learning_suggestions_workflow_id ON workflow_learning_suggestions(workflow_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_learning_suggestions_source_recording ON workflow_learning_suggestions(source_recording_session_id)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_learning_evidence_suggestion_id ON workflow_learning_evidence(suggestion_id)',
      ];
      for (const stmt of postAlterIndexStatements) {
        try {
          this.db.prepare(stmt).run();
        } catch {
        }
      }

      if (existingSchemaVersion !== SCHEMA_VERSION) {
        try {
          rebuildRecordingSessionsTable(this.db);
        } catch {
        }
        try {
          rebuildTestRunDraftsTable(this.db);
        } catch {
        }
        try {
          rebuildFieldDictionaryTable(this.db);
        } catch {
        }

        try {
          this.db.prepare(`
            UPDATE test_run_drafts
            SET published_preset_id = COALESCE(published_preset_id, published_test_run_id),
                published_test_run_id = NULL
            WHERE published_test_run_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM test_run_presets
                WHERE test_run_presets.id = test_run_drafts.published_test_run_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM test_runs
                WHERE test_runs.id = test_run_drafts.published_test_run_id
              )
          `).run();
        } catch {
        }
      }

      try {
        this.db.prepare(`
          UPDATE field_dictionary
          SET category = 'AUTH', updated_at = datetime('now')
          WHERE id IN ('dict_001', 'dict_002')
        `).run();
      } catch {
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
      failurePatternTemplates: createSqliteRepository(this.db, 'failure_pattern_templates', ['failure_patterns', 'tags'], []),
      accountBindingTemplates: createSqliteRepository(this.db, 'account_binding_templates', ['baseline_config', 'tags'], ['enable_baseline']),
      workflows: createSqliteRepository(this.db, 'workflows', ['critical_step_orders', 'baseline_config', 'session_jar_config', 'mutation_profile'], ['is_active', 'enable_baseline', 'enable_extractor', 'enable_session_jar']),
      workflowSteps: createSqliteRepository(this.db, 'workflow_steps', ['step_assertions', 'failure_patterns_override', 'failure_patterns_snapshot'], []),
      workflowVariableConfigs: createSqliteRepository(this.db, 'workflow_variable_configs', ['step_variable_mappings', 'advanced_config', 'account_scope_ids'], ['is_attacker_field']),
      workflowExtractors: createSqliteRepository(this.db, 'workflow_extractors', ['transform'], ['required']),
      checklists: createSqliteRepository(this.db, 'checklists', ['config'], []),
      securityRules: createSqliteRepository(this.db, 'security_rules', ['payloads'], []),
      recordingSessions: createSqliteRepository(this.db, 'recording_sessions', ['requested_field_names', 'capture_filters', 'target_fields', 'summary'], []),
      recordingEvents: createSqliteRepository(this.db, 'recording_events', ['query_params', 'request_headers', 'request_cookies', 'parsed_request_body', 'response_headers', 'response_cookies', 'parsed_response_body'], []),
      recordingFieldTargets: createSqliteRepository(this.db, 'recording_field_targets', ['aliases', 'from_sources'], []),
      recordingFieldHits: createSqliteRepository(this.db, 'recording_field_hits', [], []),
      recordingRuntimeContext: createSqliteRepository(this.db, 'recording_runtime_context', [], []),
      recordingAccountApplyLogs: createSqliteRepository(this.db, 'recording_account_apply_logs', ['target_snapshot', 'field_changes', 'auth_profile_changes', 'variable_changes', 'summary'], ['persisted']),
      recordingAuditLogs: createSqliteRepository(this.db, 'recording_audit_logs', ['details'], []),
      recordingDeadLetters: createSqliteRepository(this.db, 'recording_dead_letters', ['payload'], []),
      workflowDrafts: createSqliteRepository(this.db, 'workflow_drafts', ['summary', 'draft_payload'], []),
      workflowDraftSteps: createSqliteRepository(this.db, 'workflow_draft_steps', ['summary', 'request_template_payload', 'response_signature'], ['enabled']),
      recordingExtractorCandidates: createSqliteRepository(this.db, 'recording_extractor_candidates', ['transform'], ['required']),
        recordingVariableCandidates: createSqliteRepository(this.db, 'recording_variable_candidates', ['step_variable_mappings', 'advanced_config'], []),
      testRunDrafts: createSqliteRepository(this.db, 'test_run_drafts', ['summary', 'draft_payload'], []),
      testRunPresets: createSqliteRepository(this.db, 'test_run_presets', ['preset_config'], []),
      draftPublishLogs: createSqliteRepository(this.db, 'draft_publish_logs', [], []),
      testRuns: createSqliteRepository(this.db, 'test_runs', ['rule_ids', 'template_ids', 'account_ids', 'execution_params', 'progress', 'validation_report'], ['has_execution_error']),
      findings: createSqliteRepository(this.db, 'findings', ['variable_values', 'response_headers', 'request_evidence', 'response_evidence', 'ai_analysis', 'evidence_comparison', 'account_source_map', 'victim_account_ids', 'baseline_response', 'mutated_response', 'response_diff'], ['is_suppressed']),
      cicdGatePolicies: createSqliteRepository(this.db, 'cicd_gate_policies', ['rules_test', 'rules_workflow'], ['is_enabled']),
      securitySuites: createSqliteRepository(this.db, 'security_suites', ['template_ids', 'workflow_ids', 'account_ids', 'checklist_ids', 'security_rule_ids'], ['is_enabled']),
      securityRuns: createSqliteRepository(this.db, 'security_runs', ['metadata'], []),
      findingSuppressionRules: createSqliteRepository(this.db, 'finding_suppression_rules', [], ['is_enabled']),
      findingDropRules: createSqliteRepository(this.db, 'finding_drop_rules', [], ['is_enabled']),
      dbProfiles: createSqliteRepository(this.db, 'db_profiles', ['config'], ['is_active']),
    } as any;
  }
}
