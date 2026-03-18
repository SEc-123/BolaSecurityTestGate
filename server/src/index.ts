import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { dbManager } from './db/db-manager.js';
import apiRoutes from './routes/api.js';
import adminRoutes from './routes/admin.js';
import runRoutes from './routes/run.js';
import { createLearningRoutes } from './routes/learning.js';
import aiRoutes from './routes/ai.js';
import { runRetentionCleanup } from './services/retention-cleaner.js';
import { getGovernanceSettings } from './services/rate-limiter.js';
import {
  createLongIntervalScheduler,
  type LongIntervalScheduler,
} from './services/long-interval-scheduler.js';

const app = express();
const PORT = process.env.PORT || 3001;
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '4320', 10);
let runScheduledCleanupFunc: (() => Promise<void>) | null = null;
let cleanupScheduler: LongIntervalScheduler | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIST_DIR = path.resolve(__dirname, '../../dist');

function shouldServeFrontend(): boolean {
  return process.env.SERVE_FRONTEND !== 'false';
}

function registerFrontendHosting(app: express.Express): void {
  if (!shouldServeFrontend()) {
    console.log('Frontend static hosting disabled via SERVE_FRONTEND=false');
    return;
  }

  if (!fs.existsSync(FRONTEND_DIST_DIR)) {
    console.warn(`Frontend dist directory not found at ${FRONTEND_DIST_DIR}; static hosting disabled.`);
    return;
  }

  const indexHtmlPath = path.join(FRONTEND_DIST_DIR, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    console.warn(`Frontend index not found at ${indexHtmlPath}; static hosting disabled.`);
    return;
  }

  app.use(express.static(FRONTEND_DIST_DIR, { index: false }));

  app.get(/^(?!\/(api|admin|health|assets)(\/|$)).*/, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (path.extname(req.path)) {
        return next();
      }
      res.sendFile(indexHtmlPath, (err) => {
        if (err) {
          next(err);
        }
      });
    } catch (error) {
      next(error);
    }
  });
}

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

function hoursToMilliseconds(hours: number): number {
  return hours * 60 * 60 * 1000;
}

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Client-Info',
    'X-API-Key',
    'X-Recording-Admin-Key',
    'X-Recording-Actor',
  ],
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

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/') || req.path === '/api' || req.path.startsWith('/admin/') || req.path === '/admin') {
    return res.status(404).json({ data: null, error: `Route not found: ${req.method} ${req.originalUrl}` });
  }
  next();
});

registerFrontendHosting(app);

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
      console.log(`Frontend dist expected at: ${FRONTEND_DIST_DIR}`);
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

    cleanupScheduler = createLongIntervalScheduler(runScheduledCleanupFunc);

    try {
      const db = dbManager.getActive();
      const settings = await getGovernanceSettings(db);
      const envInterval = process.env.CLEANUP_INTERVAL_HOURS ? parseInt(process.env.CLEANUP_INTERVAL_HOURS, 10) : null;
      const finalIntervalHours = validateAndParseInterval(envInterval ?? settings.cleanup_interval_hours);
      cleanupScheduler.start(hoursToMilliseconds(finalIntervalHours));
      console.log(`Scheduled cleanup will run every ${finalIntervalHours} hour(s) (approx. ${(finalIntervalHours / 24).toFixed(1)} days)`);
    } catch (error: any) {
      console.error('Failed to read cleanup settings, using default:', error.message);
      const finalIntervalHours = validateAndParseInterval(CLEANUP_INTERVAL_HOURS);
      cleanupScheduler.start(hoursToMilliseconds(finalIntervalHours));
      console.log(`Scheduled cleanup will run every ${finalIntervalHours} hour(s) (default)`);
    }

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  cleanupScheduler?.stop();
  await dbManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  cleanupScheduler?.stop();
  await dbManager.shutdown();
  process.exit(0);
});

async function resetCleanupSchedule() {
  if (!runScheduledCleanupFunc) {
    console.warn('Cleanup scheduler not initialized yet');
    return;
  }

  cleanupScheduler?.stop();

  try {
    const db = dbManager.getActive();
    const settings = await getGovernanceSettings(db);
    const envInterval = process.env.CLEANUP_INTERVAL_HOURS ? parseInt(process.env.CLEANUP_INTERVAL_HOURS, 10) : null;
    const finalIntervalHours = validateAndParseInterval(envInterval ?? settings.cleanup_interval_hours);

    if (!cleanupScheduler) {
      cleanupScheduler = createLongIntervalScheduler(runScheduledCleanupFunc);
    }
    cleanupScheduler.updateInterval(hoursToMilliseconds(finalIntervalHours));
    console.log(`Cleanup schedule reset to every ${finalIntervalHours} hour(s) (approx. ${(finalIntervalHours / 24).toFixed(1)} days)`);
  } catch (error: any) {
    console.error('Failed to reset cleanup schedule:', error.message);
    const finalIntervalHours = validateAndParseInterval(CLEANUP_INTERVAL_HOURS);
    if (!cleanupScheduler) {
      cleanupScheduler = createLongIntervalScheduler(runScheduledCleanupFunc);
    }
    cleanupScheduler.updateInterval(hoursToMilliseconds(finalIntervalHours));
    console.log(`Cleanup schedule reset to default ${finalIntervalHours} hour(s)`);
  }
}

(globalThis as any).__cleanupScheduler = {
  reset: resetCleanupSchedule,
};

start();
