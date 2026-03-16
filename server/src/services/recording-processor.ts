import type {
  DbProvider,
  RecordingEvent,
  RecordingFieldTarget,
} from '../types/index.js';
import { FieldDictionary } from './field-dictionary.js';
import {
  prepareRecordingArtifacts,
  type IncomingRecordingEvent,
} from './recording-field-extractor.js';

export interface RecordingBatchProcessResult {
  inserted: number;
  skipped: number;
  accepted: number;
  deduplicated: number;
  fieldHitsCreated: number;
  runtimeContextsCreated: number;
}

async function findExistingEventForIngest(
  db: DbProvider,
  sessionId: string,
  sequence: number,
  fingerprint: string
): Promise<RecordingEvent | null> {
  const bySequence = await db.repos.recordingEvents.findAll({
    where: { session_id: sessionId, sequence } as any,
    limit: 1,
  });
  const existing = bySequence[0] || null;
  if (!existing) {
    return null;
  }

  if (existing.fingerprint === fingerprint) {
    return existing;
  }

  return existing;
}

export async function processRecordingEventsBatch(
  db: DbProvider,
  params: {
    sessionId: string;
    events: IncomingRecordingEvent[];
    targets: Array<Omit<RecordingFieldTarget, 'created_at' | 'updated_at'>>;
    dictionary: FieldDictionary;
  }
): Promise<RecordingBatchProcessResult> {
  const { sessionId, events, targets, dictionary } = params;

  let inserted = 0;
  let skipped = 0;
  let fieldHitsCreated = 0;
  let runtimeContextsCreated = 0;

  for (const input of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const prepared = await prepareRecordingArtifacts({
      sessionId,
      input,
      targets,
      dictionary,
    });

    const existing = await findExistingEventForIngest(
      db,
      sessionId,
      Number(input.sequence),
      prepared.event.fingerprint
    );

    if (existing) {
      skipped += 1;
      continue;
    }

    const createdEvent = await db.repos.recordingEvents.create(prepared.event as any);
    inserted += 1;

    for (const hit of prepared.fieldHits) {
      await db.repos.recordingFieldHits.create({
        ...hit,
        event_id: createdEvent.id,
      } as any);
      fieldHitsCreated += 1;
    }

    for (const context of prepared.runtimeContexts) {
      await db.repos.recordingRuntimeContext.create({
        ...context,
        event_id: createdEvent.id,
      } as any);
      runtimeContextsCreated += 1;
    }
  }

  return {
    inserted,
    skipped,
    accepted: inserted,
    deduplicated: skipped,
    fieldHitsCreated,
    runtimeContextsCreated,
  };
}
