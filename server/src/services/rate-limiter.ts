import type { DbProvider, GovernanceSettings } from '../types/index.js';

export interface RateLimitState {
  templateCounts: Map<string, number>;
}

export interface RateLimitResult {
  shouldSuppress: boolean;
  currentCount: number;
  limit: number;
}

const DEFAULT_SETTINGS: GovernanceSettings = {
  rate_limit_enabled: true,
  rate_limit_default: 3,
  retention_days_effective: 90,
  retention_days_suppressed_rule: 14,
  retention_days_suppressed_rate_limit: 7,
  retention_days_evidence: 7,
  vacuum_mode: 'full_weekly',
  cleanup_interval_hours: 4320,
};

export async function getGovernanceSettings(db: DbProvider): Promise<GovernanceSettings> {
  try {
    const rows = await db.runRawQuery<{ key: string; value: string }>(
      'SELECT key, value FROM governance_settings'
    );

    const settings = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (row.key === 'rate_limit_enabled') {
        settings.rate_limit_enabled = row.value === 'true';
      } else if (row.key === 'rate_limit_default') {
        settings.rate_limit_default = parseInt(row.value, 10) || 3;
      } else if (row.key === 'retention_days_effective') {
        settings.retention_days_effective = parseInt(row.value, 10) || 90;
      } else if (row.key === 'retention_days_suppressed_rule') {
        settings.retention_days_suppressed_rule = parseInt(row.value, 10) || 14;
      } else if (row.key === 'retention_days_suppressed_rate_limit') {
        settings.retention_days_suppressed_rate_limit = parseInt(row.value, 10) || 7;
      } else if (row.key === 'retention_days_evidence') {
        settings.retention_days_evidence = parseInt(row.value, 10) || 7;
      } else if (row.key === 'vacuum_mode') {
        settings.vacuum_mode = row.value as GovernanceSettings['vacuum_mode'];
      } else if (row.key === 'cleanup_interval_hours') {
        settings.cleanup_interval_hours = parseInt(row.value, 10) || 4320;
      } else if (row.key === 'last_cleanup_at') {
        settings.last_cleanup_at = row.value;
      } else if (row.key === 'last_cleanup_stats') {
        try {
          settings.last_cleanup_stats = JSON.parse(row.value);
        } catch {}
      }
    }
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function updateGovernanceSettings(
  db: DbProvider,
  updates: Partial<GovernanceSettings>
): Promise<GovernanceSettings> {
  const now = new Date().toISOString();

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;

    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

    try {
      await db.runRawQuery(
        `INSERT INTO governance_settings (key, value, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
        [key, stringValue, now]
      );
    } catch {
      await db.runRawQuery(
        `INSERT OR REPLACE INTO governance_settings (key, value, updated_at) VALUES (?, ?, ?)`,
        [key, stringValue, now]
      );
    }
  }

  return getGovernanceSettings(db);
}

export function createRateLimitState(): RateLimitState {
  return {
    templateCounts: new Map(),
  };
}

export function checkRateLimit(
  state: RateLimitState,
  templateId: string,
  limit: number
): RateLimitResult {
  const currentCount = state.templateCounts.get(templateId) || 0;

  if (limit === 0 || currentCount >= limit) {
    return { shouldSuppress: true, currentCount, limit };
  }

  state.templateCounts.set(templateId, currentCount + 1);
  return { shouldSuppress: false, currentCount: currentCount + 1, limit };
}

export function getRateLimitForTemplate(
  globalDefault: number,
  templateOverride?: number | null
): number {
  if (templateOverride !== undefined && templateOverride !== null) {
    return templateOverride;
  }
  return globalDefault;
}
