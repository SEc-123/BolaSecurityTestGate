import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { dbManager } from './db/db-manager.js';
import apiRoutes from './routes/api.js';
import adminRoutes from './routes/admin.js';
import runRoutes from './routes/run.js';
import { createLearningRoutes } from './routes/learning.js';
import aiRoutes from './routes/ai.js';
import { runRetentionCleanup } from './services/retention-cleaner.js';
import { getGovernanceSettings } from './services/rate-limiter.js';

const app = express();
const PORT = process.env.PORT || 3001;
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '4320', 10);

let cleanupIntervalHandle: NodeJS.Timeout | null = null;
let runScheduledCleanupFunc: (() => Promise<void>) | null = null;

function validateAndParseInterval(hours: number | null | undefined): number {
  if (hours === null || hours === undefined) {
    return 4320;
  }
  const parsed = parseInt(String(hours), 10);
  if (isNaN(parsed) || !isFinite(parsed) || parsed <= 0) {
    console.warn(`Invalid cleanup interval: ${hours}, using default 4320 hours`);
    return 4320;
  }
  return parsed;
}

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info'],
}));

app.use(express.json({ limit: '50mb' }));

app.get('/health', async (req: Request, res: Response) => {
  try {
    const status = await dbManager.getStatus();
    res.json({
      status: 'ok',
      database: {
        kind: status.kind,
        connected: status.connected,
        profile: status.activeProfileName,
      },
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'error',
      error: error.message,
    });
  }
});

app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);
app.use('/api/run', runRoutes);
app.use('/api', createLearningRoutes(() => dbManager.getActive()));
app.use('/api/ai', aiRoutes);

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    data: null,
    error: err.message || 'Internal server error',
  });
});

async function start() {
  try {
    console.log('Initializing database manager...');
    await dbManager.initialize();
    console.log('Database manager initialized');

    const status = await dbManager.getStatus();
    console.log(`Active database: ${status.activeProfileName} (${status.kind})`);
    console.log(`Schema version: ${status.schemaVersion}`);
    console.log(`Connected: ${status.connected}`);

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`API endpoints: http://localhost:${PORT}/api/*`);
      console.log(`Admin endpoints: http://localhost:${PORT}/admin/*`);
    });

    runScheduledCleanupFunc = async () => {
      try {
        console.log('Running scheduled retention cleanup...');
        const db = dbManager.getActive();
        const result = await runRetentionCleanup(db);
        console.log('Cleanup completed:', {
          deleted_effective: result.deleted_effective,
          deleted_suppressed_rule: result.deleted_suppressed_rule,
          deleted_suppressed_rate_limit: result.deleted_suppressed_rate_limit,
          deleted_test_runs: result.deleted_test_runs,
          vacuumed: result.vacuumed,
          duration_ms: result.duration_ms,
        });
      } catch (error: any) {
        console.error('Scheduled cleanup failed:', error.message);
      }
    };

    try {
      const db = dbManager.getActive();
      const settings = await getGovernanceSettings(db);
      const envInterval = process.env.CLEANUP_INTERVAL_HOURS ? parseInt(process.env.CLEANUP_INTERVAL_HOURS, 10) : null;
      const finalIntervalHours = validateAndParseInterval(envInterval ?? settings.cleanup_interval_hours);

      cleanupIntervalHandle = setInterval(runScheduledCleanupFunc, finalIntervalHours * 60 * 60 * 1000);
      console.log(`Scheduled cleanup will run every ${finalIntervalHours} hour(s) (approx. ${(finalIntervalHours / 24).toFixed(1)} days)`);
    } catch (error: any) {
      console.error('Failed to read cleanup settings, using default:', error.message);
      const finalIntervalHours = validateAndParseInterval(CLEANUP_INTERVAL_HOURS);
      cleanupIntervalHandle = setInterval(runScheduledCleanupFunc, finalIntervalHours * 60 * 60 * 1000);
      console.log(`Scheduled cleanup will run every ${finalIntervalHours} hour(s) (default)`);
    }

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
  }
  await dbManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
  }
  await dbManager.shutdown();
  process.exit(0);
});

async function resetCleanupSchedule() {
  if (!runScheduledCleanupFunc) {
    console.warn('Cleanup scheduler not initialized yet');
    return;
  }

  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
  }

  try {
    const db = dbManager.getActive();
    const settings = await getGovernanceSettings(db);
    const envInterval = process.env.CLEANUP_INTERVAL_HOURS ? parseInt(process.env.CLEANUP_INTERVAL_HOURS, 10) : null;
    const finalIntervalHours = validateAndParseInterval(envInterval ?? settings.cleanup_interval_hours);

    cleanupIntervalHandle = setInterval(runScheduledCleanupFunc, finalIntervalHours * 60 * 60 * 1000);
    console.log(`Cleanup schedule reset to every ${finalIntervalHours} hour(s) (approx. ${(finalIntervalHours / 24).toFixed(1)} days)`);
  } catch (error: any) {
    console.error('Failed to reset cleanup schedule:', error.message);
    const finalIntervalHours = validateAndParseInterval(CLEANUP_INTERVAL_HOURS);
    cleanupIntervalHandle = setInterval(runScheduledCleanupFunc, finalIntervalHours * 60 * 60 * 1000);
    console.log(`Cleanup schedule reset to default ${finalIntervalHours} hour(s)`);
  }
}

(globalThis as any).__cleanupScheduler = {
  reset: resetCleanupSchedule,
};

start();
