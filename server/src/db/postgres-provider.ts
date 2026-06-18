import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type { DbProvider, DbRepositories, Repository, DbConfig, DbKind } from '../types/index.js';
import { POSTGRES_SCHEMA, SCHEMA_VERSION } from './schema.js';

const { Pool } = pg;

function createPostgresRepository<T extends { id: string }>(
  pool: pg.Pool,
  tableName: string
): Repository<T> {
  return {
    async findAll(options = {}): Promise<T[]> {
      let sql = `SELECT * FROM ${tableName}`;
      const params: any[] = [];
      let paramIndex = 1;

      if (options.where && Object.keys(options.where).length > 0) {
        const conditions = Object.entries(options.where).map(([key, value]) => {
          params.push(value);
          return `${key} = $${paramIndex++}`;
        });
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      sql += ` ORDER BY created_at DESC`;

      if (options.limit) {
        sql += ` LIMIT $${paramIndex++}`;
        params.push(options.limit);
      }
      if (options.offset) {
        sql += ` OFFSET $${paramIndex++}`;
        params.push(options.offset);
      }

      const result = await pool.query(sql, params);
      return result.rows;
    },

    async findById(id: string): Promise<T | null> {
      const result = await pool.query(`SELECT * FROM ${tableName} WHERE id = $1`, [id]);
      return result.rows[0] || null;
    },

    async create(data: Omit<T, 'id' | 'created_at' | 'updated_at'>): Promise<T> {
      const id = uuidv4();
      const now = new Date().toISOString();
      const fullData = { ...data, id, created_at: now, updated_at: now };

      const keys = Object.keys(fullData);
      const values = keys.map(k => (fullData as any)[k]);
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

      await pool.query(
        `INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders})`,
        values
      );
      return this.findById(id) as Promise<T>;
    },

    async update(id: string, data: Partial<T>): Promise<T | null> {
      const updateData = { ...data, updated_at: new Date().toISOString() };
      delete (updateData as any).id;
      delete (updateData as any).created_at;

      const keys = Object.keys(updateData);
      if (keys.length === 0) return this.findById(id);

      const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      const values = keys.map(k => (updateData as any)[k]);
      values.push(id);

      await pool.query(
        `UPDATE ${tableName} SET ${setClause} WHERE id = $${values.length}`,
        values
      );
      return this.findById(id);
    },

    async delete(id: string): Promise<boolean> {
      const result = await pool.query(`DELETE FROM ${tableName} WHERE id = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    },

    async count(where?: Partial<T>): Promise<number> {
      let sql = `SELECT COUNT(*) as count FROM ${tableName}`;
      const params: any[] = [];
      let paramIndex = 1;

      if (where && Object.keys(where).length > 0) {
        const conditions = Object.entries(where).map(([key, value]) => {
          params.push(value);
          return `${key} = $${paramIndex++}`;
        });
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      const result = await pool.query(sql, params);
      return parseInt(result.rows[0].count, 10);
    }
  };
}

export class PostgresProvider implements DbProvider {
  kind: DbKind;
  profileId: string;
  private pool: pg.Pool | null = null;
  private config: DbConfig;
  repos!: DbRepositories;

  constructor(profileId: string, config: DbConfig, kind: DbKind = 'postgres') {
    this.profileId = profileId;
    this.config = config;
    this.kind = kind;
  }

  async connect(): Promise<void> {
    const connectionConfig: pg.PoolConfig = this.config.url
      ? { connectionString: this.config.url, ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined }
      : {
          host: this.config.host || 'localhost',
          port: this.config.port || 5432,
          database: this.config.database || 'postgres',
          user: this.config.user,
          password: this.config.password,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
        };

    this.pool = new Pool(connectionConfig);
    await this.pool.query('SELECT 1');
    this.initRepositories();
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async getSchemaVersion(): Promise<string> {
    if (!this.pool) throw new Error('Database not connected');
    try {
      const result = await this.pool.query("SELECT value FROM app_settings WHERE key = 'schema_version'");
      return result.rows[0]?.value || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  async migrate(): Promise<void> {
    if (!this.pool) throw new Error('Database not connected');

    const statements = POSTGRES_SCHEMA.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        try {
          await this.pool.query(stmt);
        } catch (error: any) {
          if (!String(error?.message || '').includes('does not exist')) {
            throw error;
          }
        }
      }
    }

    const alterStatements = [
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS validation_report JSONB;',
      "ALTER TABLE workflow_variable_configs ADD COLUMN IF NOT EXISTS account_scope_mode TEXT DEFAULT 'all';",
      "ALTER TABLE workflow_variable_configs ADD COLUMN IF NOT EXISTS account_scope_ids JSONB DEFAULT '[]'::jsonb;",
      'ALTER TABLE api_templates ADD COLUMN IF NOT EXISTS rate_limit_override INTEGER;',
      'ALTER TABLE api_templates ADD COLUMN IF NOT EXISTS source_recording_session_id UUID;',
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS dropped_count INTEGER DEFAULT 0;',
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS findings_count_effective INTEGER DEFAULT 0;',
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS suppressed_count_rule INTEGER DEFAULT 0;',
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS suppressed_count_rate_limit INTEGER DEFAULT 0;',
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS source_recording_session_id UUID;',
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();',
      'ALTER TABLE findings ADD COLUMN IF NOT EXISTS suppressed_reason TEXT;',
      'ALTER TABLE findings ADD COLUMN IF NOT EXISTS workflow_name TEXT;',
      "ALTER TABLE workflows ADD COLUMN IF NOT EXISTS learning_source_preference TEXT DEFAULT 'execution_only';",
      'ALTER TABLE workflows ADD COLUMN IF NOT EXISTS last_learning_session_id UUID;',
      'ALTER TABLE workflows ADD COLUMN IF NOT EXISTS last_learning_mode TEXT;',
      'ALTER TABLE workflows ADD COLUMN IF NOT EXISTS source_recording_session_id UUID;',
      "ALTER TABLE security_suites ADD COLUMN IF NOT EXISTS checklist_ids JSONB DEFAULT '[]'::jsonb;",
      "ALTER TABLE security_suites ADD COLUMN IF NOT EXISTS security_rule_ids JSONB DEFAULT '[]'::jsonb;",
      'ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();',
      'ALTER TABLE workflow_variable_configs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();',
      'ALTER TABLE workflow_extractors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();',
      'ALTER TABLE recording_field_hits ADD COLUMN IF NOT EXISTS value_text TEXT;',
      'ALTER TABLE draft_publish_logs ADD COLUMN IF NOT EXISTS source_recording_session_id UUID;',
      'ALTER TABLE test_run_drafts ADD COLUMN IF NOT EXISTS published_preset_id UUID;',
      'ALTER TABLE test_run_drafts ADD COLUMN IF NOT EXISTS published_template_id UUID;',
      "ALTER TABLE test_run_drafts ADD COLUMN IF NOT EXISTS suggestion_summary JSONB DEFAULT '{}'::jsonb;",
      "ALTER TABLE test_run_drafts ADD COLUMN IF NOT EXISTS review_decisions JSONB DEFAULT '{}'::jsonb;",
      "ALTER TABLE test_run_drafts ADD COLUMN IF NOT EXISTS intent TEXT DEFAULT 'api_test_seed';",
      "ALTER TABLE test_run_drafts ADD COLUMN IF NOT EXISTS draft_status TEXT DEFAULT 'generated';",
      `
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
        );
      `,
      `
      DO $$
      DECLARE constraint_name text;
      BEGIN
        SELECT conname INTO constraint_name
        FROM pg_constraint
        WHERE conrelid = 'recording_sessions'::regclass
          AND pg_get_constraintdef(oid) LIKE '%status IN%';

        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE recording_sessions DROP CONSTRAINT %I', constraint_name);
        END IF;

        BEGIN
          ALTER TABLE recording_sessions
            ADD CONSTRAINT recording_sessions_status_check
            CHECK (status IN ('recording', 'processing', 'completed', 'finished', 'published', 'failed'));
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END;
      END
      $$;
      `,
      `
      DO $$
      DECLARE constraint_name text;
      BEGIN
        SELECT conname INTO constraint_name
        FROM pg_constraint
        WHERE conrelid = 'test_run_drafts'::regclass
          AND pg_get_constraintdef(oid) LIKE '%status IN%';

        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE test_run_drafts DROP CONSTRAINT %I', constraint_name);
        END IF;

        BEGIN
          ALTER TABLE test_run_drafts
            ADD CONSTRAINT test_run_drafts_status_check
            CHECK (status IN ('generated', 'reviewing', 'approved', 'preconfigured', 'published', 'run_created', 'archived'));
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END;

        UPDATE test_run_drafts
        SET status = CASE WHEN status NOT IN ('generated', 'reviewing', 'approved', 'preconfigured', 'published', 'run_created', 'archived') THEN 'generated' ELSE status END;
      END
      $$;
      `,
      `
      DO $$
      DECLARE constraint_name text;
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_name = 'field_dictionary'
        ) THEN
          SELECT conname INTO constraint_name
          FROM pg_constraint
          WHERE conrelid = 'field_dictionary'::regclass
            AND pg_get_constraintdef(oid) LIKE '%category IN%';

          IF constraint_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE field_dictionary DROP CONSTRAINT %I', constraint_name);
          END IF;

          BEGIN
            ALTER TABLE field_dictionary
              ADD CONSTRAINT field_dictionary_category_check
              CHECK (category IN ('AUTH', 'IDENTITY', 'FLOW_TICKET', 'OBJECT_ID', 'NOISE'));
          EXCEPTION
            WHEN duplicate_object THEN NULL;
          END;
        END IF;
      END
      $$;
      `,
      'CREATE INDEX IF NOT EXISTS idx_recording_events_session_fingerprint_sequence ON recording_events(session_id, fingerprint, sequence);',
    ];
    for (const stmt of alterStatements) {
      await this.pool.query(stmt);
    }

    const postAlterIndexStatements = [
      'CREATE INDEX IF NOT EXISTS idx_api_templates_source_recording_session ON api_templates(source_recording_session_id);',
      'CREATE INDEX IF NOT EXISTS idx_workflows_source_recording_session ON workflows(source_recording_session_id);',
      'CREATE INDEX IF NOT EXISTS idx_test_runs_source_recording_session ON test_runs(source_recording_session_id);',
      'CREATE INDEX IF NOT EXISTS idx_draft_publish_logs_target_asset ON draft_publish_logs(target_asset_type, target_asset_id);',
      'CREATE INDEX IF NOT EXISTS idx_draft_publish_logs_source_recording_session ON draft_publish_logs(source_recording_session_id);',
      'CREATE INDEX IF NOT EXISTS idx_recording_audit_logs_session_id ON recording_audit_logs(session_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_recording_audit_logs_action ON recording_audit_logs(action, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_recording_dead_letters_status ON recording_dead_letters(status, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_recording_dead_letters_session_id ON recording_dead_letters(session_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_workflow_learning_suggestions_workflow_id ON workflow_learning_suggestions(workflow_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_workflow_learning_suggestions_source_recording ON workflow_learning_suggestions(source_recording_session_id);',
      'CREATE INDEX IF NOT EXISTS idx_workflow_learning_evidence_suggestion_id ON workflow_learning_evidence(suggestion_id);',
    ];
    for (const stmt of postAlterIndexStatements) {
      await this.pool.query(stmt);
    }

    await this.pool.query(`
      INSERT INTO field_dictionary (id, scope, scope_id, pattern, category, priority, is_enabled, notes, created_at, updated_at)
      VALUES
        ('dict_001', 'global', NULL, '(?i)^(authorization|access_token|auth_token|bearer|x-auth-token)$', 'AUTH', 100, true, 'Common auth headers', now(), now()),
        ('dict_002', 'global', NULL, '(?i)^(token|jwt|session_id|session)$', 'AUTH', 90, true, 'Session tokens', now(), now())
      ON CONFLICT (id) DO UPDATE
      SET category = EXCLUDED.category,
          pattern = EXCLUDED.pattern,
          priority = EXCLUDED.priority,
          is_enabled = EXCLUDED.is_enabled,
          notes = EXCLUDED.notes,
          updated_at = now()
    `);

    await this.pool.query(`
      INSERT INTO app_settings (key, value) VALUES ('schema_version', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1
    `, [SCHEMA_VERSION]);
  }

  async runRawQuery<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    if (!this.pool) throw new Error('Database not connected');
    let convertedSql = sql;
    let paramIndex = 1;
    convertedSql = convertedSql.replace(/\?/g, () => `$${paramIndex++}`);
    const result = await this.pool.query(convertedSql, params);
    return result.rows;
  }

  private initRepositories(): void {
    if (!this.pool) throw new Error('Database not connected');

    this.repos = {
      environments: createPostgresRepository(this.pool, 'environments'),
      accounts: createPostgresRepository(this.pool, 'accounts'),
      apiTemplates: createPostgresRepository(this.pool, 'api_templates'),
      failurePatternTemplates: createPostgresRepository(this.pool, 'failure_pattern_templates'),
      accountBindingTemplates: createPostgresRepository(this.pool, 'account_binding_templates'),
      workflows: createPostgresRepository(this.pool, 'workflows'),
      workflowSteps: createPostgresRepository(this.pool, 'workflow_steps'),
      workflowVariableConfigs: createPostgresRepository(this.pool, 'workflow_variable_configs'),
      workflowExtractors: createPostgresRepository(this.pool, 'workflow_extractors'),
      checklists: createPostgresRepository(this.pool, 'checklists'),
      securityRules: createPostgresRepository(this.pool, 'security_rules'),
      recordingSessions: createPostgresRepository(this.pool, 'recording_sessions'),
      recordingEvents: createPostgresRepository(this.pool, 'recording_events'),
      recordingFieldTargets: createPostgresRepository(this.pool, 'recording_field_targets'),
      recordingFieldHits: createPostgresRepository(this.pool, 'recording_field_hits'),
      recordingRuntimeContext: createPostgresRepository(this.pool, 'recording_runtime_context'),
      recordingAccountApplyLogs: createPostgresRepository(this.pool, 'recording_account_apply_logs'),
      recordingAuditLogs: createPostgresRepository(this.pool, 'recording_audit_logs'),
      recordingDeadLetters: createPostgresRepository(this.pool, 'recording_dead_letters'),
      workflowDrafts: createPostgresRepository(this.pool, 'workflow_drafts'),
      workflowDraftSteps: createPostgresRepository(this.pool, 'workflow_draft_steps'),
      recordingExtractorCandidates: createPostgresRepository(this.pool, 'recording_extractor_candidates'),
      recordingVariableCandidates: createPostgresRepository(this.pool, 'recording_variable_candidates'),
      testRunDrafts: createPostgresRepository(this.pool, 'test_run_drafts'),
      testRunPresets: createPostgresRepository(this.pool, 'test_run_presets'),
      draftPublishLogs: createPostgresRepository(this.pool, 'draft_publish_logs'),
      testRuns: createPostgresRepository(this.pool, 'test_runs'),
      findings: createPostgresRepository(this.pool, 'findings'),
      cicdGatePolicies: createPostgresRepository(this.pool, 'cicd_gate_policies'),
      securitySuites: createPostgresRepository(this.pool, 'security_suites'),
      securityRuns: createPostgresRepository(this.pool, 'security_runs'),
      findingSuppressionRules: createPostgresRepository(this.pool, 'finding_suppression_rules'),
      findingDropRules: createPostgresRepository(this.pool, 'finding_drop_rules'),
      dbProfiles: createPostgresRepository(this.pool, 'db_profiles'),
    };
  }
}
