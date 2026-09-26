import { createHash } from 'node:crypto';
import { asPositiveInt, isVerifiedDecryptedAppFlow } from './mobile-target-contract.js';
import type { DbProvider } from '../../types/index.js';
import { createRecordingSession, ingestRecordingEventsBatch, regenerateRecordingSessionArtifacts } from '../recording-service.js';
import type { IncomingRecordingEvent } from '../recording-field-extractor.js';
import { AIScanRepository } from '../ai-scan/repository.js';
import type { NormalizedHttpFlow } from './mobile-types.js';
import { getMobileSession, updateMobileSession } from './mobile-session-service.js';

function pathFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname || '/';
  } catch {
    const match = String(url || '').match(/^https?:\/\/[^/]+(\/[^?#]*)/i);
    return match?.[1] || '/';
  }
}

function flowToRecordingEvent(flow: NormalizedHttpFlow, index: number): IncomingRecordingEvent {
  return {
    sequence: index + 1,
    source_tool: flow.source_tool || 'internal_burp_mobile',
    method: String(flow.method || 'GET').toUpperCase(),
    url: flow.url,
    request_headers: flow.request_headers || {},
    request_body_text: flow.request_body_text,
    response_status: flow.response_status,
    response_headers: flow.response_headers || {},
    response_body_text: flow.response_body_text,
  } as IncomingRecordingEvent;
}

export async function importMobileFlowsToRecording(db: DbProvider, input: {
  scan_run_id?: string;
  task_id?: string;
  environment_id?: string;
  mobile_session_id?: string;
  app_package?: string;
  flows: NormalizedHttpFlow[];
  mode?: 'workflow' | 'api';
  name?: string;
  regenerate?: boolean;
  require_explicit_tls_evidence?: boolean;
  require_capture_app_identity?: boolean;
  minimum_decrypted_flows?: number;
  minimum_workflow_drafts?: number;
}): Promise<Record<string, any>> {
  const received = input.flows.filter(flow => flow.method && flow.url && /^https?:\/\//i.test(flow.url));
  const strictTls = input.require_explicit_tls_evidence === true;
  const strictIdentity = input.require_capture_app_identity === true;
  const expectedPackage = String(input.app_package || '').trim();
  const meaningful = received.filter(flow => {
    if (strictTls && !isVerifiedDecryptedAppFlow(flow, expectedPackage, strictIdentity)) return false;
    if (strictIdentity && (!expectedPackage || flow.app_package !== expectedPackage)) return false;
    return true;
  });
  const rejected_flows = received.length - meaningful.length;
  const minimum = asPositiveInt(input.minimum_decrypted_flows, 1);
  if (!meaningful.length) throw new Error('No usable mobile flows to import.');
  const minimumDrafts = input.minimum_workflow_drafts || 0;
  if (minimumDrafts > 0 && input.regenerate === false) throw new Error('Workflow generation is required by the acceptance contract.');
  if (strictTls && meaningful.length < minimum) {
    throw new Error(`Real Android capture requires at least ${minimum} explicitly decrypted HTTPS response flow(s) for the configured target; received=${received.length}, accepted=${meaningful.length}, rejected=${rejected_flows}.`);
  }
  const snapshot = createHash('sha256').update(JSON.stringify(meaningful)).digest('hex');
  const mobile = input.mobile_session_id ? await getMobileSession(db, input.mobile_session_id) : null;
  const pending = mobile?.health_json?.pending_import;
  if (pending && pending.sha256 !== snapshot) throw new Error('Cannot retry a partial import with a different evidence snapshot.');
  const session = pending?.recording_session_id ? await db.repos.recordingSessions.findById(pending.recording_session_id) : await createRecordingSession(db, {
    name: input.name || `Mobile capture ${input.app_package || ''} ${new Date().toISOString()}`.trim(),
    mode: input.mode || 'workflow',
    intent: input.mode === 'api' ? 'api_test_seed' : 'workflow_seed',
    source_tool: 'internal_burp_mobile',
    environment_id: input.environment_id,
    capture_filters: {
      source: 'android_app',
      app_package: input.app_package,
      mobile_session_id: input.mobile_session_id,
      scan_run_id: input.scan_run_id,
      only_authorized_lab: true,
    },
    target_fields: [
      { name: 'token', aliases: ['access_token', 'auth_token', 'authorization'], from_sources: ['request.headers', 'response.body'], category: 'AUTH' } as any,
      { name: 'object_id', aliases: ['id', 'order_id', 'user_id', 'tenant_id', 'file_id'], from_sources: ['request.path', 'request.body', 'response.body'], category: 'OBJECT_ID' } as any,
    ],
  });
  if (!session) throw new Error('Recording session is missing; import cannot continue.');
  if (input.mobile_session_id) await updateMobileSession(db, input.mobile_session_id, { recording_session_id: session.id, health_json: { pending_import: { sha256: snapshot, recording_session_id: session.id } } });
  const events = meaningful.map(flowToRecordingEvent);
  const ingest = events.length ? await ingestRecordingEventsBatch(db, session.id, events) : null;
  const detail = input.regenerate !== false && events.length ? await regenerateRecordingSessionArtifacts(db, session.id) : null;

  if ((detail?.workflow_drafts?.length || 0) < minimumDrafts) throw new Error(`Generated workflow drafts are below the required minimum ${minimumDrafts}.`);

  if (input.mobile_session_id) {
    await updateMobileSession(db, input.mobile_session_id, {
      recording_session_id: session.id,
      capture_status: meaningful.some(flow => flow.tls_decrypted === true && flow.url.startsWith('https://')) ? 'imported' : 'http_only',
      health_json: {
        imported_at: new Date().toISOString(),
        recording_session_id: session.id,
        flow_count: meaningful.length,
        generated: detail?.generated || null,
      },
    } as any);
  }

  if (input.scan_run_id) {
    const repo = new AIScanRepository(db);
    const unique = new Map<string, NormalizedHttpFlow>();
    for (const flow of meaningful) {
      const key = `${String(flow.method).toUpperCase()} ${pathFromUrl(flow.url)}`;
      if (!unique.has(key)) unique.set(key, flow);
    }
    for (const [key, flow] of unique) {
      const [method, ...pathParts] = key.split(' ');
      const path = pathParts.join(' ');
      await repo.upsertEndpoint({
        scan_run_id: input.scan_run_id,
        method,
        path,
        url: flow.url,
        request_summary: `${method} ${path} captured from Android App via Burp`,
        response_summary: flow.response_status ? `HTTP ${flow.response_status}` : 'Captured mobile request',
        auth_required: Boolean(flow.request_headers?.authorization || flow.request_headers?.Authorization),
        content_type: String(flow.response_headers?.['content-type'] || flow.response_headers?.['Content-Type'] || ''),
        feature_guess: guessFeature(path),
        source_type: 'mobile_recording',
        source_id: session.id,
      });
    }
  }

  return {
    recording_session_id: session.id,
    accepted_flows: meaningful.length,
    received_flows: received.length,
    rejected_flows,
    explicitly_decrypted_https_flows: meaningful.filter(flow => flow.tls_decrypted === true && /^https:\/\//i.test(flow.url)).length,
    ingest,
    generated: detail?.generated || null,
    workflow_draft_count: detail?.workflow_drafts?.length || 0,
    test_run_draft_count: detail?.test_run_drafts?.length || 0,
  };
}


function guessFeature(path: string): string {
  const value = path.toLowerCase();
  if (/login|register|otp|sms|email|password|captcha/.test(value)) return '认证账号';
  if (/order|cart|payment|refund|wallet|transfer|withdraw|balance/.test(value)) return '交易订单';
  if (/file|upload|download|avatar|image|media/.test(value)) return '文件处理';
  if (/admin|role|permission|manage/.test(value)) return '后台管理';
  if (/user|profile|address|account/.test(value)) return '用户中心';
  return '移动端接口';
}
