import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import {
  createApiTemplateFromTestRunDraft,
  createRecordingSession,
  exportRecordingSessionRaw,
  getRecordingSessionEvents,
  finishRecordingSession,
  getRecordingSessionDetail,
  ingestRecordingEventsBatch,
  listDraftPublishLogs,
  listTestRunDrafts,
  listRecordingSessions,
  promoteTestRunDraftToTestRun,
  publishTestRunDraft,
  publishWorkflowDraft,
  regenerateRecordingSessionArtifacts,
  updateTestRunDraft,
  updateWorkflowDraft,
} from '../services/recording-service.js';
import {
  applyRecordingSessionToAccount,
  getRecordingSessionAccountPreview,
} from '../services/recording-account-linkage.js';
import {
  getRecordingSessionAccountDraft,
  publishRecordingSessionAccountDraft,
} from '../services/recording-suggestion-engine.js';
import {
  createApiTestDrafts,
  getApiTestDraftById,
  listApiTestDraftsBySession,
  publishAndRunApiTestDraft,
  publishApiTestDraft,
} from '../services/api-test-seed-service.js';
import {
  ensureRecordingAuthorized,
  enforceRecordingIngressLimits,
  getRecordingIngressConfig,
  getRecordingPrivilegeConfig,
  ensureRecordingPrivileged,
  RecordingGuardError,
} from '../services/recording-guard.js';
import {
  getRecordingTelemetrySnapshot,
  incrementRecordingBatchFailed,
} from '../services/recording-telemetry.js';
import {
  appendRecordingAuditLog,
  createRecordingDeadLetter,
  discardRecordingDeadLetter,
  getRecordingOpsSummary,
  listRecordingAuditLogs,
  listRecordingDeadLetters,
  markRecordingDeadLetterRetried,
  markRecordingDeadLetterRetryFailed,
} from '../services/recording-observability.js';
import {
  ensureRecordingAccountAllowed,
  ensureRecordingModeEnabled,
  ensureRecordingPublishEnabled,
  getRecordingRolloutConfig,
} from '../services/recording-rollout.js';

const router = Router();

function routeId(req: Request): string {
  return String(req.params.id || '');
}

function errorStatus(error: any, fallback: number): number {
  if (error instanceof RecordingGuardError) return error.status;
  return fallback;
}

function requestActor(req: Request, fallback: string): string {
  const explicit =
    req.body?.published_by ||
    req.body?.applied_by ||
    req.body?.actor ||
    req.header('x-recording-actor') ||
    req.header('X-Recording-Actor');
  return explicit ? String(explicit) : fallback;
}

router.get('/health', async (req: Request, res: Response) => {
  try {
    ensureRecordingAuthorized(req);
    const dbStatus = await dbManager.getStatus();
    res.json({
      data: {
        status: 'ok',
        database: {
          kind: dbStatus.kind,
          connected: dbStatus.connected,
          profile: dbStatus.activeProfileName,
        },
        ingress: getRecordingIngressConfig(),
        privilege: getRecordingPrivilegeConfig(),
        rollout: getRecordingRolloutConfig(),
        metrics: getRecordingTelemetrySnapshot(),
      },
      error: null,
    });
  } catch (error: any) {
    res.status(errorStatus(error, 500)).json({ data: null, error: error.message });
  }
});

router.get('/config', async (_req: Request, res: Response) => {
  try {
    res.json({ data: getRecordingRolloutConfig(), error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const sessions = await listRecordingSessions(dbManager.getActive());
    res.json({ data: sessions, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, 500)).json({ data: null, error: error.message });
  }
});

router.post('/sessions', async (req: Request, res: Response) => {
  try {
    ensureRecordingAuthorized(req);
    const effectiveMode = req.body?.mode || (req.body?.intent === 'account_capture' || req.body?.intent === 'api_test_seed' ? 'api' : 'workflow');
    ensureRecordingModeEnabled(effectiveMode);
    ensureRecordingAccountAllowed(req.body?.account_id ? String(req.body.account_id) : undefined);
    const session = await createRecordingSession(dbManager.getActive(), req.body);
    res.status(201).json({ data: session, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, 400)).json({ data: null, error: error.message });
  }
});

router.get('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const detail = await getRecordingSessionDetail(dbManager.getActive(), routeId(req));
    res.json({ data: detail, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 500)).json({ data: null, error: error.message });
  }
});

router.get('/sessions/:id/events', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const detail = await getRecordingSessionEvents(dbManager.getActive(), routeId(req), {
      limit,
      offset,
    });
    res.json({
      data: {
        session: detail.session,
        events: detail.events,
        pagination: detail.pagination,
      },
      error: null,
    });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 500)).json({ data: null, error: error.message });
  }
});

router.post('/sessions/:id/events/batch', async (req: Request, res: Response) => {
  const sessionId = routeId(req);
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  try {
    const apiKey = ensureRecordingAuthorized(req);
    if (events.length === 0) {
      res.status(400).json({ data: null, error: 'events must be a non-empty array' });
      return;
    }

    enforceRecordingIngressLimits({
      apiKey,
      sessionId,
      batchSize: events.length,
    });

    const result = await ingestRecordingEventsBatch(dbManager.getActive(), sessionId, events);
    res.json({ data: result, error: null });
  } catch (error: any) {
    incrementRecordingBatchFailed({
      session_id: sessionId,
      error: error.message,
    });
    if (errorStatus(error, 400) !== 401 && events.length > 0) {
      try {
        await createRecordingDeadLetter(dbManager.getActive(), {
          session_id: sessionId,
          failure_stage: 'ingest_batch',
          error_message: error.message,
          batch_size: events.length,
          payload: {
            session_id: sessionId,
            events,
          },
        });
        await appendRecordingAuditLog(dbManager.getActive(), {
          session_id: sessionId,
          action: 'recording_batch_failed',
          actor: requestActor(req, 'recording_plugin'),
          target_type: 'recording_session',
          target_id: sessionId,
          status: 'failed',
          message: error.message,
          details: {
            batch_size: events.length,
          },
        });
      } catch {
      }
    }
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.get('/sessions/:id/candidates', async (req: Request, res: Response) => {
  try {
    const detail = await getRecordingSessionDetail(dbManager.getActive(), routeId(req));
    res.json({
      data: {
        session: detail.session,
        runtime_context_summary: detail.runtime_context_summary,
        targets: detail.targets,
        field_hits: detail.field_hits,
        runtime_contexts: detail.runtime_contexts,
        workflow_drafts: detail.workflow_drafts,
        test_run_drafts: detail.test_run_drafts,
        test_run_presets: detail.test_run_presets,
      },
      error: null,
    });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 500)).json({ data: null, error: error.message });
  }
});

router.post('/sessions/:id/finish', async (req: Request, res: Response) => {
  try {
    ensureRecordingAuthorized(req);
    const result = await finishRecordingSession(dbManager.getActive(), routeId(req));
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/sessions/:id/regenerate', async (req: Request, res: Response) => {
  try {
    const result = await regenerateRecordingSessionArtifacts(dbManager.getActive(), routeId(req));
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});


router.get('/sessions/:id/account-draft', async (req: Request, res: Response) => {
  try {
    const result = await getRecordingSessionAccountDraft(dbManager.getActive(), routeId(req));
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/sessions/:id/account-draft/regenerate', async (req: Request, res: Response) => {
  try {
    const result = await getRecordingSessionAccountDraft(dbManager.getActive(), routeId(req), { regenerate: true });
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/sessions/:id/publish-account', async (req: Request, res: Response) => {
  try {
    const result = await publishRecordingSessionAccountDraft(dbManager.getActive(), routeId(req), {
      ...req.body,
      actor: requestActor(req, 'recording_account_publish'),
    });
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});


router.post('/sessions/:id/api-test-drafts', async (req: Request, res: Response) => {
  try {
    const result = await createApiTestDrafts(dbManager.getActive(), routeId(req), req.body || {});
    res.status(201).json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.get('/sessions/:id/api-test-drafts', async (req: Request, res: Response) => {
  try {
    const drafts = await listApiTestDraftsBySession(dbManager.getActive(), routeId(req));
    res.json({ data: drafts, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.get('/api-test-drafts/:id', async (req: Request, res: Response) => {
  try {
    const draft = await getApiTestDraftById(dbManager.getActive(), routeId(req));
    res.json({ data: draft, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.get('/sessions/:id/account-preview', async (req: Request, res: Response) => {
  try {
    const fieldMap = typeof req.query.field_map === 'string'
      ? JSON.parse(String(req.query.field_map))
      : undefined;
    const result = await getRecordingSessionAccountPreview(dbManager.getActive(), routeId(req), {
      account_id: req.query.account_id ? String(req.query.account_id) : undefined,
      mode: req.query.mode === 'write_back' ? 'write_back' : 'session_only',
      field_map: fieldMap,
    });
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/sessions/:id/apply-account', async (req: Request, res: Response) => {
  try {
    if (req.body?.mode === 'write_back') {
      ensureRecordingPrivileged(req, 'recording_apply_account_write_back');
    }
    const result = await applyRecordingSessionToAccount(dbManager.getActive(), routeId(req), req.body);
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.get('/sessions/:id/export/raw', async (req: Request, res: Response) => {
  try {
    const raw = await exportRecordingSessionRaw(dbManager.getActive(), routeId(req));
    res.json({ data: raw, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 500)).json({ data: null, error: error.message });
  }
});

router.put('/workflow-drafts/:id', async (req: Request, res: Response) => {
  try {
    const result = await updateWorkflowDraft(dbManager.getActive(), routeId(req), req.body);
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.get('/test-run-drafts', async (_req: Request, res: Response) => {
  try {
    const drafts = await listTestRunDrafts(dbManager.getActive());
    res.json({ data: drafts, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, 500)).json({ data: null, error: error.message });
  }
});

router.get('/publish-logs', async (req: Request, res: Response) => {
  try {
    const logs = await listDraftPublishLogs(dbManager.getActive(), {
      draft_type: req.query.draft_type ? String(req.query.draft_type) as 'workflow' | 'test_run' : undefined,
      source_draft_id: req.query.source_draft_id ? String(req.query.source_draft_id) : undefined,
      source_recording_session_id: req.query.source_recording_session_id ? String(req.query.source_recording_session_id) : undefined,
      target_asset_type: req.query.target_asset_type ? String(req.query.target_asset_type) : undefined,
      target_asset_id: req.query.target_asset_id ? String(req.query.target_asset_id) : undefined,
    });
    res.json({ data: logs, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, 500)).json({ data: null, error: error.message });
  }
});

router.get('/ops/summary', async (req: Request, res: Response) => {
  try {
    ensureRecordingPrivileged(req, 'recording_ops_view');
    const summary = await getRecordingOpsSummary(dbManager.getActive());
    res.json({ data: summary, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, 500)).json({ data: null, error: error.message });
  }
});

router.get('/ops/audit-logs', async (req: Request, res: Response) => {
  try {
    ensureRecordingPrivileged(req, 'recording_ops_view');
    const logs = await listRecordingAuditLogs(dbManager.getActive(), {
      session_id: req.query.session_id ? String(req.query.session_id) : undefined,
      action: req.query.action ? String(req.query.action) : undefined,
      status: req.query.status ? String(req.query.status) as 'success' | 'failed' : undefined,
      target_type: req.query.target_type ? String(req.query.target_type) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ data: logs, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, 500)).json({ data: null, error: error.message });
  }
});

router.get('/ops/dead-letters', async (req: Request, res: Response) => {
  try {
    ensureRecordingPrivileged(req, 'recording_ops_view');
    const deadLetters = await listRecordingDeadLetters(dbManager.getActive(), {
      session_id: req.query.session_id ? String(req.query.session_id) : undefined,
      status: req.query.status ? String(req.query.status) as 'pending' | 'replayed' | 'discarded' : undefined,
      failure_stage: req.query.failure_stage ? String(req.query.failure_stage) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ data: deadLetters, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, 500)).json({ data: null, error: error.message });
  }
});

router.put('/test-run-drafts/:id', async (req: Request, res: Response) => {
  try {
    const result = await updateTestRunDraft(dbManager.getActive(), routeId(req), req.body);
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});


router.post('/api-test-drafts/:id/publish', async (req: Request, res: Response) => {
  try {
    ensureRecordingPublishEnabled('api test draft publish');
    ensureRecordingPrivileged(req, 'recording_publish_api_template');
    const result = await publishApiTestDraft(dbManager.getActive(), routeId(req), req.body || {});
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/api-test-drafts/:id/publish-and-run', async (req: Request, res: Response) => {
  try {
    ensureRecordingPublishEnabled('api test publish and run');
    ensureRecordingPrivileged(req, 'recording_promote_test_run');
    const result = await publishAndRunApiTestDraft(dbManager.getActive(), routeId(req), req.body || {});
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/test-run-drafts/:id/template', async (req: Request, res: Response) => {
  try {
    ensureRecordingPublishEnabled('template creation');
    ensureRecordingPrivileged(req, 'recording_publish_api_template');
    const result = await createApiTemplateFromTestRunDraft(dbManager.getActive(), routeId(req), req.body);
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/test-run-drafts/:id/test-run', async (req: Request, res: Response) => {
  try {
    ensureRecordingPublishEnabled('test run promotion');
    ensureRecordingPrivileged(req, 'recording_promote_test_run');
    const result = await promoteTestRunDraftToTestRun(dbManager.getActive(), routeId(req), req.body);
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/workflow-drafts/:id/publish', async (req: Request, res: Response) => {
  try {
    ensureRecordingPublishEnabled('workflow publish');
    ensureRecordingPrivileged(req, 'recording_publish_workflow');
    const result = await publishWorkflowDraft(dbManager.getActive(), routeId(req), req.body);
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/test-run-drafts/:id/publish', async (req: Request, res: Response) => {
  try {
    ensureRecordingPublishEnabled('preset publish');
    ensureRecordingPrivileged(req, 'recording_publish_test_run_preset');
    const result = await publishTestRunDraft(dbManager.getActive(), routeId(req), req.body);
    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/ops/dead-letters/:id/retry', async (req: Request, res: Response) => {
  const deadLetterId = routeId(req);
  const actor = requestActor(req, 'recording_admin');
  try {
    ensureRecordingPrivileged(req, 'recording_dead_letter_retry');
    const deadLetter = await dbManager.getActive().repos.recordingDeadLetters.findById(deadLetterId);
    if (!deadLetter) {
      res.status(404).json({ data: null, error: `Recording dead letter not found: ${deadLetterId}` });
      return;
    }

    let result: Record<string, any> = {};
    if (deadLetter.failure_stage === 'ingest_batch') {
      const sessionId = deadLetter.session_id || deadLetter.payload?.session_id;
      const events = Array.isArray(deadLetter.payload?.events) ? deadLetter.payload.events : [];
      if (!sessionId || events.length === 0) {
        throw new Error(`Dead letter ${deadLetterId} does not contain a replayable batch payload`);
      }

      const ingress = getRecordingIngressConfig();
      const chunks: any[][] = [];
      for (let index = 0; index < events.length; index += ingress.max_batch_size) {
        chunks.push(events.slice(index, index + ingress.max_batch_size));
      }

      const replayResults: any[] = [];
      for (const chunk of chunks) {
        replayResults.push(await ingestRecordingEventsBatch(dbManager.getActive(), sessionId, chunk));
      }

      result = {
        session_id: sessionId,
        replayed_batches: replayResults.length,
        replayed_events: events.length,
        inserted: replayResults.reduce((sum, item) => sum + (item.inserted || 0), 0),
        deduplicated: replayResults.reduce((sum, item) => sum + (item.deduplicated || 0), 0),
      };
    } else if (deadLetter.failure_stage === 'draft_generation') {
      const sessionId = deadLetter.session_id || deadLetter.payload?.session_id;
      if (!sessionId) {
        throw new Error(`Dead letter ${deadLetterId} does not contain a replayable recording session`);
      }
      const detail = await regenerateRecordingSessionArtifacts(dbManager.getActive(), sessionId);
      result = {
        session_id: sessionId,
        status: detail.session.status,
        generated_result_count: detail.session.generated_result_count,
      };
    } else {
      throw new Error(`Unsupported dead letter stage: ${deadLetter.failure_stage}`);
    }

    const updated = await markRecordingDeadLetterRetried(dbManager.getActive(), deadLetterId, {
      actor,
      details: result,
    });
    res.json({ data: { dead_letter: updated, result }, error: null });
  } catch (error: any) {
    try {
      await markRecordingDeadLetterRetryFailed(dbManager.getActive(), deadLetterId, {
        actor,
        error_message: error.message,
      });
    } catch {
    }
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

router.post('/ops/dead-letters/:id/discard', async (req: Request, res: Response) => {
  try {
    ensureRecordingPrivileged(req, 'recording_dead_letter_discard');
    const deadLetter = await discardRecordingDeadLetter(dbManager.getActive(), routeId(req), {
      actor: requestActor(req, 'recording_admin'),
      reason: req.body?.reason ? String(req.body.reason) : undefined,
    });
    res.json({ data: deadLetter, error: null });
  } catch (error: any) {
    res.status(errorStatus(error, error.message?.includes('not found') ? 404 : 400)).json({ data: null, error: error.message });
  }
});

export default router;
