import { v4 as uuidv4 } from 'uuid';
import type { DbProvider, DbProfile, DbConfig, DbKind, DbStatus, DbRepositories } from '../types/index.js';
import { SqliteProvider } from './sqlite-provider.js';
import { PostgresProvider } from './postgres-provider.js';
import { SCHEMA_VERSION } from './schema.js';

interface SwitchLock {
  locked: boolean;
  lockedAt?: Date;
}

interface TransferTableConfig {
  exportKey: string;
  repoKey: keyof DbRepositories;
  tableName: string;
  jsonFields?: string[];
  boolFields?: string[];
}

const TRANSFER_TABLES: TransferTableConfig[] = [
  { exportKey: 'environments', repoKey: 'environments', tableName: 'environments', boolFields: ['is_active'] },
  { exportKey: 'accounts', repoKey: 'accounts', tableName: 'accounts', jsonFields: ['tags', 'auth_profile', 'variables', 'fields'] },
  { exportKey: 'checklists', repoKey: 'checklists', tableName: 'checklists', jsonFields: ['config'] },
  { exportKey: 'securityRules', repoKey: 'securityRules', tableName: 'security_rules', jsonFields: ['payloads'] },
  {
    exportKey: 'apiTemplates',
    repoKey: 'apiTemplates',
    tableName: 'api_templates',
    jsonFields: ['parsed_structure', 'variables', 'failure_patterns', 'baseline_config', 'advanced_config'],
    boolFields: ['is_active', 'enable_baseline'],
  },
  {
    exportKey: 'workflows',
    repoKey: 'workflows',
    tableName: 'workflows',
    jsonFields: ['critical_step_orders', 'baseline_config', 'session_jar_config', 'mutation_profile'],
    boolFields: ['is_active', 'enable_baseline', 'enable_extractor', 'enable_session_jar'],
  },
  {
    exportKey: 'workflowSteps',
    repoKey: 'workflowSteps',
    tableName: 'workflow_steps',
    jsonFields: ['step_assertions', 'failure_patterns_override', 'failure_patterns_snapshot'],
  },
  {
    exportKey: 'workflowVariableConfigs',
    repoKey: 'workflowVariableConfigs',
    tableName: 'workflow_variable_configs',
    jsonFields: ['step_variable_mappings', 'advanced_config', 'account_scope_ids'],
    boolFields: ['is_attacker_field'],
  },
  {
    exportKey: 'workflowExtractors',
    repoKey: 'workflowExtractors',
    tableName: 'workflow_extractors',
    jsonFields: ['transform'],
    boolFields: ['required'],
  },
  { exportKey: 'securitySuites', repoKey: 'securitySuites', tableName: 'security_suites', jsonFields: ['template_ids', 'workflow_ids', 'account_ids', 'checklist_ids', 'security_rule_ids'], boolFields: ['is_enabled'] },
  { exportKey: 'testRuns', repoKey: 'testRuns', tableName: 'test_runs', jsonFields: ['rule_ids', 'template_ids', 'account_ids', 'execution_params', 'progress', 'validation_report'], boolFields: ['has_execution_error'] },
  { exportKey: 'securityRuns', repoKey: 'securityRuns', tableName: 'security_runs', jsonFields: ['metadata'] },
  { exportKey: 'recordingSessions', repoKey: 'recordingSessions', tableName: 'recording_sessions', jsonFields: ['target_fields', 'summary'] },
  { exportKey: 'recordingFieldTargets', repoKey: 'recordingFieldTargets', tableName: 'recording_field_targets', jsonFields: ['aliases', 'from_sources'] },
  { exportKey: 'recordingEvents', repoKey: 'recordingEvents', tableName: 'recording_events', jsonFields: ['query_params', 'request_headers', 'request_cookies', 'parsed_request_body', 'response_headers', 'response_cookies', 'parsed_response_body'] },
  { exportKey: 'recordingFieldHits', repoKey: 'recordingFieldHits', tableName: 'recording_field_hits' },
  { exportKey: 'recordingRuntimeContext', repoKey: 'recordingRuntimeContext', tableName: 'recording_runtime_context' },
  { exportKey: 'recordingAccountApplyLogs', repoKey: 'recordingAccountApplyLogs', tableName: 'recording_account_apply_logs', jsonFields: ['target_snapshot', 'field_changes', 'auth_profile_changes', 'variable_changes', 'summary'], boolFields: ['persisted'] },
  { exportKey: 'recordingAuditLogs', repoKey: 'recordingAuditLogs', tableName: 'recording_audit_logs', jsonFields: ['details'] },
  { exportKey: 'recordingDeadLetters', repoKey: 'recordingDeadLetters', tableName: 'recording_dead_letters', jsonFields: ['payload'] },
  { exportKey: 'workflowDrafts', repoKey: 'workflowDrafts', tableName: 'workflow_drafts', jsonFields: ['summary', 'draft_payload'] },
  { exportKey: 'workflowDraftSteps', repoKey: 'workflowDraftSteps', tableName: 'workflow_draft_steps', jsonFields: ['summary', 'request_template_payload', 'response_signature'], boolFields: ['enabled'] },
  { exportKey: 'recordingExtractorCandidates', repoKey: 'recordingExtractorCandidates', tableName: 'recording_extractor_candidates', jsonFields: ['transform'], boolFields: ['required'] },
  { exportKey: 'recordingVariableCandidates', repoKey: 'recordingVariableCandidates', tableName: 'recording_variable_candidates', jsonFields: ['step_variable_mappings', 'advanced_config'] },
  { exportKey: 'testRunDrafts', repoKey: 'testRunDrafts', tableName: 'test_run_drafts', jsonFields: ['summary', 'draft_payload'] },
  { exportKey: 'testRunPresets', repoKey: 'testRunPresets', tableName: 'test_run_presets', jsonFields: ['preset_config'] },
  { exportKey: 'draftPublishLogs', repoKey: 'draftPublishLogs', tableName: 'draft_publish_logs' },
  { exportKey: 'cicdGatePolicies', repoKey: 'cicdGatePolicies', tableName: 'cicd_gate_policies', jsonFields: ['rules_test', 'rules_workflow'], boolFields: ['is_enabled'] },
  { exportKey: 'findingSuppressionRules', repoKey: 'findingSuppressionRules', tableName: 'finding_suppression_rules', boolFields: ['is_enabled'] },
  { exportKey: 'findingDropRules', repoKey: 'findingDropRules', tableName: 'finding_drop_rules', boolFields: ['is_enabled'] },
  {
    exportKey: 'findings',
    repoKey: 'findings',
    tableName: 'findings',
    jsonFields: ['variable_values', 'response_headers', 'request_evidence', 'response_evidence', 'ai_analysis', 'evidence_comparison', 'account_source_map', 'victim_account_ids', 'baseline_response', 'mutated_response', 'response_diff'],
    boolFields: ['is_suppressed'],
  },
];

function prepareTransferValue(
  provider: DbProvider,
  config: TransferTableConfig,
  key: string,
  value: any
): any {
  if (value === undefined) {
    return null;
  }

  if ((config.jsonFields || []).includes(key)) {
    return provider.kind === 'sqlite' ? JSON.stringify(value ?? null) : (value ?? null);
  }

  if ((config.boolFields || []).includes(key)) {
    return provider.kind === 'sqlite' ? (value ? 1 : 0) : !!value;
  }

  return value;
}

async function upsertTransferRow(
  provider: DbProvider,
  config: TransferTableConfig,
  item: Record<string, any>
): Promise<void> {
  const columns = Object.keys(item);
  if (columns.length === 0) {
    return;
  }

  const values = columns.map(column => prepareTransferValue(provider, config, column, item[column]));
  const placeholders = columns.map(() => '?').join(', ');
  const updateColumns = columns.filter(column => column !== 'id');

  if (provider.kind === 'sqlite') {
    const updateClause = updateColumns.map(column => `${column} = excluded.${column}`).join(', ');
    const sql = updateClause
      ? `INSERT INTO ${config.tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updateClause}`
      : `INSERT INTO ${config.tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) DO NOTHING`;
    await provider.runRawQuery(sql, values);
    return;
  }

  const updateClause = updateColumns.map(column => `${column} = EXCLUDED.${column}`).join(', ');
  const sql = updateClause
    ? `INSERT INTO ${config.tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updateClause}`
    : `INSERT INTO ${config.tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;
  await provider.runRawQuery(sql, values);
}

export class DbManager {
  private activeProvider: DbProvider | null = null;
  private switchLock: SwitchLock = { locked: false };
  private profiles: Map<string, DbProfile> = new Map();
  private activeProfileId: string | null = null;
  private metaDbPath: string;

  constructor(metaDbPath: string = './data/meta.db') {
    this.metaDbPath = metaDbPath;
  }

  async initialize(): Promise<void> {
    const metaProvider = new SqliteProvider('meta', { file: this.metaDbPath });
    await metaProvider.connect();
    await metaProvider.migrate();

    const existingProfiles = await metaProvider.repos.dbProfiles.findAll();
    for (const profile of existingProfiles) {
      this.profiles.set(profile.id, profile);
    }

    if (this.profiles.size === 0) {
      const defaultProfile: Omit<DbProfile, 'id' | 'created_at' | 'updated_at'> = {
        name: 'Local SQLite',
        kind: 'sqlite',
        config: { file: './data/app.db' },
        is_active: true,
      };
      const created = await metaProvider.repos.dbProfiles.create(defaultProfile);
      this.profiles.set(created.id, created);
      this.activeProfileId = created.id;
    } else {
      const activeProfile = existingProfiles.find(p => p.is_active);
      this.activeProfileId = activeProfile?.id || existingProfiles[0].id;
    }

    await metaProvider.disconnect();

    if (this.activeProfileId) {
      const profile = this.profiles.get(this.activeProfileId);
      if (profile) {
        this.activeProvider = this.createProvider(profile);
        await this.activeProvider.connect();
        await this.activeProvider.migrate();
      }
    }
  }

  private createProvider(profile: DbProfile): DbProvider {
    switch (profile.kind) {
      case 'sqlite':
        return new SqliteProvider(profile.id, profile.config);
      case 'postgres':
      case 'supabase_postgres':
        return new PostgresProvider(profile.id, profile.config, profile.kind);
      default:
        throw new Error(`Unknown database kind: ${profile.kind}`);
    }
  }

  getActive(): DbProvider {
    if (!this.activeProvider) {
      throw new Error('No active database provider');
    }
    return this.activeProvider;
  }

  async getStatus(): Promise<DbStatus> {
    const profile = this.activeProfileId ? this.profiles.get(this.activeProfileId) : null;
    const provider = this.activeProvider;

    let connected = false;
    let schemaVersion = '0.0.0';
    let runningRunsCount = 0;

    if (provider) {
      connected = await provider.ping();
      if (connected) {
        schemaVersion = await provider.getSchemaVersion();
        runningRunsCount = await provider.repos.testRuns.count({ status: 'running' } as any);
      }
    }

    return {
      activeProfileId: this.activeProfileId || '',
      activeProfileName: profile?.name || 'Unknown',
      kind: profile?.kind || 'sqlite',
      schemaVersion,
      connected,
      runningRunsCount,
    };
  }

  async getProfiles(): Promise<DbProfile[]> {
    return Array.from(this.profiles.values());
  }

  async getProfile(id: string): Promise<DbProfile | null> {
    return this.profiles.get(id) || null;
  }

  async createProfile(data: { name: string; kind: DbKind; config: DbConfig }): Promise<DbProfile> {
    const metaProvider = new SqliteProvider('meta', { file: this.metaDbPath });
    await metaProvider.connect();

    const profile = await metaProvider.repos.dbProfiles.create({
      name: data.name,
      kind: data.kind,
      config: data.config,
      is_active: false,
    });

    this.profiles.set(profile.id, profile);
    await metaProvider.disconnect();
    return profile;
  }

  async updateProfile(id: string, data: Partial<{ name: string; config: DbConfig }>): Promise<DbProfile | null> {
    const metaProvider = new SqliteProvider('meta', { file: this.metaDbPath });
    await metaProvider.connect();

    const updated = await metaProvider.repos.dbProfiles.update(id, data as any);
    if (updated) {
      this.profiles.set(id, updated);
    }

    await metaProvider.disconnect();
    return updated;
  }

  async deleteProfile(id: string): Promise<boolean> {
    if (id === this.activeProfileId) {
      throw new Error('Cannot delete the active profile');
    }

    const metaProvider = new SqliteProvider('meta', { file: this.metaDbPath });
    await metaProvider.connect();

    const deleted = await metaProvider.repos.dbProfiles.delete(id);
    if (deleted) {
      this.profiles.delete(id);
    }

    await metaProvider.disconnect();
    return deleted;
  }

  async testConnection(config: { kind: DbKind; config: DbConfig }): Promise<{ success: boolean; error?: string }> {
    const tempProfile: DbProfile = {
      id: 'temp-test',
      name: 'Test Connection',
      kind: config.kind,
      config: config.config,
      is_active: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    let provider: DbProvider | null = null;
    try {
      provider = this.createProvider(tempProfile);
      await provider.connect();
      const pingResult = await provider.ping();
      if (!pingResult) {
        return { success: false, error: 'Ping failed after connection' };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    } finally {
      if (provider) {
        try { await provider.disconnect(); } catch {}
      }
    }
  }

  async migrateProfile(profileId: string): Promise<{ success: boolean; error?: string; schemaVersion?: string }> {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }

    let provider: DbProvider | null = null;
    try {
      provider = this.createProvider(profile);
      await provider.connect();
      await provider.migrate();
      const schemaVersion = await provider.getSchemaVersion();
      return { success: true, schemaVersion };
    } catch (error: any) {
      return { success: false, error: error.message };
    } finally {
      if (provider && provider !== this.activeProvider) {
        try { await provider.disconnect(); } catch {}
      }
    }
  }

  async switchTo(profileId: string): Promise<{ success: boolean; error?: string }> {
    if (this.switchLock.locked) {
      return { success: false, error: 'Another switch operation is in progress' };
    }

    const profile = this.profiles.get(profileId);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }

    if (profileId === this.activeProfileId) {
      return { success: true };
    }

    this.switchLock = { locked: true, lockedAt: new Date() };
    const previousProvider = this.activeProvider;
    const previousProfileId = this.activeProfileId;

    try {
      if (this.activeProvider) {
        const runningCount = await this.activeProvider.repos.testRuns.count({ status: 'running' } as any);
        if (runningCount > 0) {
          return { success: false, error: `Cannot switch: ${runningCount} test run(s) currently running` };
        }
      }

      const newProvider = this.createProvider(profile);

      await newProvider.connect();
      const pingResult = await newProvider.ping();
      if (!pingResult) {
        await newProvider.disconnect();
        return { success: false, error: 'Failed to connect to target database' };
      }

      await newProvider.migrate();
      const schemaVersion = await newProvider.getSchemaVersion();
      if (schemaVersion !== SCHEMA_VERSION) {
        await newProvider.disconnect();
        return { success: false, error: `Schema version mismatch: expected ${SCHEMA_VERSION}, got ${schemaVersion}` };
      }

      try {
        await newProvider.repos.environments.findAll({ limit: 1 });
        await newProvider.repos.workflows.findAll({ limit: 1 });
        await newProvider.runRawQuery('SELECT validation_report FROM test_runs LIMIT 1');
        await newProvider.runRawQuery('SELECT account_scope_ids FROM workflow_variable_configs LIMIT 1');
      } catch (smokeError: any) {
        await newProvider.disconnect();
        return { success: false, error: `Smoke check failed: ${smokeError.message}` };
      }

      this.activeProvider = newProvider;
      this.activeProfileId = profileId;

      const metaProvider = new SqliteProvider('meta', { file: this.metaDbPath });
      await metaProvider.connect();

      if (previousProfileId) {
        await metaProvider.repos.dbProfiles.update(previousProfileId, { is_active: false } as any);
        const prevProfile = this.profiles.get(previousProfileId);
        if (prevProfile) {
          prevProfile.is_active = false;
          this.profiles.set(previousProfileId, prevProfile);
        }
      }

      await metaProvider.repos.dbProfiles.update(profileId, { is_active: true } as any);
      profile.is_active = true;
      this.profiles.set(profileId, profile);

      await metaProvider.disconnect();

      if (previousProvider) {
        try { await previousProvider.disconnect(); } catch {}
      }

      const healthCheck = await this.activeProvider.ping();
      if (!healthCheck) {
        throw new Error('Health check failed after switch');
      }

      return { success: true };

    } catch (error: any) {
      if (this.activeProvider !== previousProvider && this.activeProvider) {
        try { await this.activeProvider.disconnect(); } catch {}
      }
      this.activeProvider = previousProvider;
      this.activeProfileId = previousProfileId;
      return { success: false, error: `Switch failed: ${error.message}` };

    } finally {
      this.switchLock = { locked: false };
    }
  }

  async exportData(): Promise<Record<string, any[]>> {
    const provider = this.getActive();
    const data: Record<string, any[]> = {};

    for (const config of TRANSFER_TABLES) {
      data[config.exportKey] = await (provider.repos[config.repoKey] as any).findAll();
    }

    return data;
  }

  async importData(data: Record<string, any[]>, targetProfileId?: string): Promise<{ success: boolean; error?: string; counts?: Record<string, number> }> {
    let provider: DbProvider;
    let shouldDisconnect = false;

    if (targetProfileId && targetProfileId !== this.activeProfileId) {
      const profile = this.profiles.get(targetProfileId);
      if (!profile) {
        return { success: false, error: 'Target profile not found' };
      }
      provider = this.createProvider(profile);
      await provider.connect();
      shouldDisconnect = true;
    } else {
      provider = this.getActive();
    }

    const counts: Record<string, number> = {};

    try {
      await provider.migrate();

      for (const config of TRANSFER_TABLES) {
        const items = data[config.exportKey];
        if (!items || !Array.isArray(items)) {
          continue;
        }

        counts[config.exportKey] = 0;
        for (const item of items) {
          if (!item || typeof item !== 'object' || !item.id) {
            continue;
          }

          try {
            await upsertTransferRow(provider, config, item);
            counts[config.exportKey]++;
          } catch {
          }
        }
      }

      return { success: true, counts };

    } catch (error: any) {
      return { success: false, error: error.message };

    } finally {
      if (shouldDisconnect) {
        try { await provider.disconnect(); } catch {}
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.activeProvider) {
      await this.activeProvider.disconnect();
      this.activeProvider = null;
    }
  }
}

export const dbManager = new DbManager();
