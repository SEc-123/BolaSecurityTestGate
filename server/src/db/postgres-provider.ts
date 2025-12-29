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
        await this.pool.query(stmt);
      }
    }

    const alterStatements = [
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS validation_report JSONB;',
      "ALTER TABLE workflow_variable_configs ADD COLUMN IF NOT EXISTS account_scope_mode TEXT DEFAULT 'all';",
      "ALTER TABLE workflow_variable_configs ADD COLUMN IF NOT EXISTS account_scope_ids JSONB DEFAULT '[]'::jsonb;",
      'ALTER TABLE api_templates ADD COLUMN IF NOT EXISTS rate_limit_override INTEGER;',
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS dropped_count INTEGER DEFAULT 0;',
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS findings_count_effective INTEGER DEFAULT 0;',
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS suppressed_count_rule INTEGER DEFAULT 0;',
      'ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS suppressed_count_rate_limit INTEGER DEFAULT 0;',
      'ALTER TABLE findings ADD COLUMN IF NOT EXISTS suppressed_reason TEXT;',
    ];
    for (const stmt of alterStatements) {
      await this.pool.query(stmt);
    }

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
      workflows: createPostgresRepository(this.pool, 'workflows'),
      workflowSteps: createPostgresRepository(this.pool, 'workflow_steps'),
      workflowVariableConfigs: createPostgresRepository(this.pool, 'workflow_variable_configs'),
      workflowExtractors: createPostgresRepository(this.pool, 'workflow_extractors'),
      checklists: createPostgresRepository(this.pool, 'checklists'),
      securityRules: createPostgresRepository(this.pool, 'security_rules'),
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
