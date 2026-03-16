interface RecordingMetricsState {
  recording_sessions_created_total: number;
  recording_events_ingested_total: number;
  recording_event_deduplicated_total: number;
  recording_batches_failed_total: number;
  promotion_success_total: number;
  draft_generation_duration_ms_total: number;
  draft_generation_duration_ms_last: number;
  draft_generation_duration_ms_avg: number;
  draft_generation_duration_ms_max: number;
  draft_generation_runs_total: number;
}

const metricsState: RecordingMetricsState = {
  recording_sessions_created_total: 0,
  recording_events_ingested_total: 0,
  recording_event_deduplicated_total: 0,
  recording_batches_failed_total: 0,
  promotion_success_total: 0,
  draft_generation_duration_ms_total: 0,
  draft_generation_duration_ms_last: 0,
  draft_generation_duration_ms_avg: 0,
  draft_generation_duration_ms_max: 0,
  draft_generation_runs_total: 0,
};

function nowIso(): string {
  return new Date().toISOString();
}

function emitAudit(action: string, payload: Record<string, any>): void {
  console.info('[recording-audit]', JSON.stringify({
    at: nowIso(),
    action,
    ...payload,
  }));
}

export function incrementRecordingSessionsCreated(payload?: Record<string, any>): void {
  metricsState.recording_sessions_created_total += 1;
  if (payload) emitAudit('recording_session_created', payload);
}

export function incrementRecordingEventsIngested(inserted: number, skipped: number): void {
  metricsState.recording_events_ingested_total += Math.max(0, inserted);
  metricsState.recording_event_deduplicated_total += Math.max(0, skipped);
}

export function incrementRecordingBatchFailed(payload?: Record<string, any>): void {
  metricsState.recording_batches_failed_total += 1;
  if (payload) emitAudit('recording_batch_failed', payload);
}

export function recordDraftGeneration(durationMs: number, payload?: Record<string, any>): void {
  const normalizedDuration = Math.max(0, durationMs);
  metricsState.draft_generation_duration_ms_total += normalizedDuration;
  metricsState.draft_generation_duration_ms_last = Math.max(0, durationMs);
  metricsState.draft_generation_duration_ms_max = Math.max(metricsState.draft_generation_duration_ms_max, normalizedDuration);
  metricsState.draft_generation_runs_total += 1;
  metricsState.draft_generation_duration_ms_avg =
    metricsState.draft_generation_runs_total > 0
      ? Math.round(metricsState.draft_generation_duration_ms_total / metricsState.draft_generation_runs_total)
      : 0;
  if (payload) emitAudit('recording_draft_generated', {
    duration_ms: durationMs,
    ...payload,
  });
}

export function incrementPromotionSuccess(payload?: Record<string, any>): void {
  metricsState.promotion_success_total += 1;
  if (payload) emitAudit('recording_promotion_success', payload);
}

export function recordAccountOverwrite(payload?: Record<string, any>): void {
  emitAudit('recording_account_overwrite', payload || {});
}

export function recordRecordingFinish(payload?: Record<string, any>): void {
  emitAudit('recording_session_finished', payload || {});
}

export function recordRecordingGenerationFailure(payload?: Record<string, any>): void {
  emitAudit('recording_generation_failed', payload || {});
}

export function getRecordingTelemetrySnapshot(): RecordingMetricsState {
  return { ...metricsState };
}
