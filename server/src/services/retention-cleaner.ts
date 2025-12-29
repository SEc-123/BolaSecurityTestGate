import type { DbProvider } from '../types/index.js';
import { getGovernanceSettings, updateGovernanceSettings } from './rate-limiter.js';

export interface CleanupResult {
  success: boolean;
  deleted_effective: number;
  deleted_suppressed_rule: number;
  deleted_suppressed_rate_limit: number;
  deleted_test_runs: number;
  vacuumed: boolean;
  duration_ms: number;
  error?: string;
}

export async function runRetentionCleanup(db: DbProvider): Promise<CleanupResult> {
  const startTime = Date.now();
  const result: CleanupResult = {
    success: false,
    deleted_effective: 0,
    deleted_suppressed_rule: 0,
    deleted_suppressed_rate_limit: 0,
    deleted_test_runs: 0,
    vacuumed: false,
    duration_ms: 0,
  };

  try {
    const settings = await getGovernanceSettings(db);
    const now = new Date();

    const effectiveCutoff = new Date(now.getTime() - settings.retention_days_effective * 24 * 60 * 60 * 1000);
    const suppressedRuleCutoff = new Date(now.getTime() - settings.retention_days_suppressed_rule * 24 * 60 * 60 * 1000);
    const suppressedRateLimitCutoff = new Date(now.getTime() - settings.retention_days_suppressed_rate_limit * 24 * 60 * 60 * 1000);
    const evidenceCutoff = new Date(now.getTime() - settings.retention_days_evidence * 24 * 60 * 60 * 1000);

    const isPostgres = db.kind === 'postgres' || db.kind === 'supabase_postgres';

    if (isPostgres) {
      let rows = await db.runRawQuery<{ count: string }>(
        `DELETE FROM findings
         WHERE is_suppressed = false
         AND created_at < $1
         RETURNING id`,
        [effectiveCutoff.toISOString()]
      );
      result.deleted_effective = rows.length;

      rows = await db.runRawQuery<{ count: string }>(
        `DELETE FROM findings
         WHERE is_suppressed = true
         AND suppressed_reason = 'rule'
         AND created_at < $1
         RETURNING id`,
        [suppressedRuleCutoff.toISOString()]
      );
      result.deleted_suppressed_rule = rows.length;

      rows = await db.runRawQuery<{ count: string }>(
        `DELETE FROM findings
         WHERE is_suppressed = true
         AND suppressed_reason = 'rate_limited'
         AND created_at < $1
         RETURNING id`,
        [suppressedRateLimitCutoff.toISOString()]
      );
      result.deleted_suppressed_rate_limit = rows.length;

      rows = await db.runRawQuery<{ count: string }>(
        `DELETE FROM test_runs
         WHERE status IN ('completed', 'completed_with_errors', 'failed')
         AND created_at < $1
         RETURNING id`,
        [evidenceCutoff.toISOString()]
      );
      result.deleted_test_runs = rows.length;

    } else {
      let countBefore = await db.repos.findings.count();
      await db.runRawQuery(
        `DELETE FROM findings
         WHERE is_suppressed = 0
         AND created_at < ?`,
        [effectiveCutoff.toISOString()]
      );
      let countAfter = await db.repos.findings.count();
      result.deleted_effective = countBefore - countAfter;

      countBefore = countAfter;
      await db.runRawQuery(
        `DELETE FROM findings
         WHERE is_suppressed = 1
         AND suppressed_reason = 'rule'
         AND created_at < ?`,
        [suppressedRuleCutoff.toISOString()]
      );
      countAfter = await db.repos.findings.count();
      result.deleted_suppressed_rule = countBefore - countAfter;

      countBefore = countAfter;
      await db.runRawQuery(
        `DELETE FROM findings
         WHERE is_suppressed = 1
         AND suppressed_reason = 'rate_limited'
         AND created_at < ?`,
        [suppressedRateLimitCutoff.toISOString()]
      );
      countAfter = await db.repos.findings.count();
      result.deleted_suppressed_rate_limit = countBefore - countAfter;

      const testRunCountBefore = await db.repos.testRuns.count();
      await db.runRawQuery(
        `DELETE FROM test_runs
         WHERE status IN ('completed', 'completed_with_errors', 'failed')
         AND created_at < ?`,
        [evidenceCutoff.toISOString()]
      );
      const testRunCountAfter = await db.repos.testRuns.count();
      result.deleted_test_runs = testRunCountBefore - testRunCountAfter;
    }

    if (settings.vacuum_mode !== 'none' && !isPostgres) {
      try {
        await db.runRawQuery('VACUUM');
        result.vacuumed = true;
      } catch {
        result.vacuumed = false;
      }
    }

    result.success = true;
    result.duration_ms = Date.now() - startTime;

    await updateGovernanceSettings(db, {
      last_cleanup_at: now.toISOString(),
      last_cleanup_stats: {
        deleted_effective: result.deleted_effective,
        deleted_suppressed_rule: result.deleted_suppressed_rule,
        deleted_suppressed_rate_limit: result.deleted_suppressed_rate_limit,
        deleted_test_runs: result.deleted_test_runs,
        vacuumed: result.vacuumed,
        duration_ms: result.duration_ms,
      },
    });

  } catch (error: any) {
    result.error = error.message;
    result.duration_ms = Date.now() - startTime;
  }

  return result;
}
