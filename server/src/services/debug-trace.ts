import { AsyncLocalStorage } from 'async_hooks';

const MAX_BODY_CHARS = parseInt(process.env.DEBUG_TRACE_MAX_BODY_CHARS || '2000000', 10);
const MAX_TRACE_CHARS = parseInt(process.env.DEBUG_TRACE_MAX_TRACE_CHARS || '12000000', 10);

const REDACT_HEADERS = (process.env.DEBUG_TRACE_REDACT_HEADERS || 'authorization,cookie,set-cookie,x-api-key')
  .toLowerCase()
  .split(',')
  .map(h => h.trim());

export interface DebugRequestRecord {
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  truncated_body?: boolean;
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: string;
    truncated_body?: boolean;
  };
  error?: string;
  duration_ms: number;
  retry_attempt: number;
  meta?: {
    step_order?: number;
    step_id?: string;
    template_id?: string;
    template_name?: string;
    label?: string;
  };
}

export interface DebugTrace {
  run_meta: {
    kind: 'workflow' | 'template';
    run_id: string;
    test_run_id?: string;
    git_sha?: string;
    started_at: string;
    finished_at?: string;
  };
  summary: {
    total_requests: number;
    errors_count: number;
    total_duration_ms: number;
    max_concurrency?: number;
  };
  records: DebugRequestRecord[];
  truncated?: boolean;
}

interface TraceContext {
  kind: 'workflow' | 'template';
  run_id: string;
  meta: Record<string, any>;
  records: DebugRequestRecord[];
  started_at: string;
}

const asyncLocalStorage = new AsyncLocalStorage<TraceContext>();

const lastTraceByKind: {
  workflow: DebugTrace | null;
  template: DebugTrace | null;
} = {
  workflow: null,
  template: null,
};

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (REDACT_HEADERS.includes(lowerKey)) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function truncateBody(body: string | undefined, maxChars: number): { body?: string; truncated: boolean } {
  if (!body) return { body, truncated: false };
  if (body.length <= maxChars) return { body, truncated: false };
  return { body: body.substring(0, maxChars), truncated: true };
}

function estimateTraceSize(trace: DebugTrace): number {
  return JSON.stringify(trace).length;
}

export function startDebugTrace(kind: 'workflow' | 'template', run_id: string, meta: Record<string, any> = {}): void {
  const context: TraceContext = {
    kind,
    run_id,
    meta,
    records: [],
    started_at: new Date().toISOString(),
  };
  asyncLocalStorage.enterWith(context);
  console.log(`[DebugTrace] Started trace for ${kind} run_id=${run_id}`);
}

export function finishDebugTrace(kind: 'workflow' | 'template'): void {
  const context = asyncLocalStorage.getStore();
  if (!context || context.kind !== kind) {
    console.warn(`[DebugTrace] No active context for kind=${kind}`);
    return;
  }

  const finished_at = new Date().toISOString();
  const total_requests = context.records.length;
  const errors_count = context.records.filter(r => r.error).length;
  const total_duration_ms = context.records.reduce((sum, r) => sum + r.duration_ms, 0);

  const trace: DebugTrace = {
    run_meta: {
      kind: context.kind,
      run_id: context.run_id,
      test_run_id: context.meta.test_run_id,
      git_sha: context.meta.git_sha,
      started_at: context.started_at,
      finished_at,
    },
    summary: {
      total_requests,
      errors_count,
      total_duration_ms,
    },
    records: context.records,
  };

  const traceSize = estimateTraceSize(trace);
  if (traceSize > MAX_TRACE_CHARS) {
    trace.truncated = true;
    const truncateCount = Math.floor(trace.records.length * 0.5);
    trace.records = trace.records.slice(0, truncateCount);
    console.warn(`[DebugTrace] Trace size ${traceSize} exceeds limit, truncated to ${truncateCount} records`);
  }

  lastTraceByKind[kind] = trace;
  console.log(`[DebugTrace] Finished trace for ${kind} run_id=${context.run_id}, ${total_requests} requests, ${errors_count} errors`);

  asyncLocalStorage.exit(() => {});
}

export function recordRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: any,
  meta?: DebugRequestRecord['meta']
): number {
  const context = asyncLocalStorage.getStore();
  if (!context) {
    return -1;
  }

  const timestamp = new Date().toISOString();

  const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
  const { body: truncatedBody, truncated: truncatedBodyFlag } = truncateBody(bodyStr, MAX_BODY_CHARS);

  const record: DebugRequestRecord = {
    timestamp,
    method,
    url,
    headers: redactHeaders(headers),
    body: truncatedBody,
    truncated_body: truncatedBodyFlag,
    duration_ms: 0,
    retry_attempt: 0,
    meta,
  };

  context.records.push(record);
  return context.records.length - 1;
}

export function recordResponse(
  recordIndex: number,
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: string;
  },
  duration_ms: number,
  retry_attempt: number
): void {
  const context = asyncLocalStorage.getStore();
  if (!context || recordIndex < 0 || recordIndex >= context.records.length) {
    return;
  }

  const record = context.records[recordIndex];
  const { body: truncatedBody, truncated: truncatedBodyFlag } = truncateBody(response.body, MAX_BODY_CHARS);

  record.response = {
    status: response.status,
    statusText: response.statusText,
    headers: redactHeaders(response.headers),
    body: truncatedBody,
    truncated_body: truncatedBodyFlag,
  };
  record.duration_ms = duration_ms;
  record.retry_attempt = retry_attempt;
}

export function recordError(recordIndex: number, error: string, duration_ms: number, retry_attempt: number): void {
  const context = asyncLocalStorage.getStore();
  if (!context || recordIndex < 0 || recordIndex >= context.records.length) {
    return;
  }

  const record = context.records[recordIndex];
  record.error = error;
  record.duration_ms = duration_ms;
  record.retry_attempt = retry_attempt;
}

export function getLastTrace(kind: 'workflow' | 'template'): DebugTrace | null {
  return lastTraceByKind[kind];
}

export function clearLastTrace(kind: 'workflow' | 'template'): void {
  lastTraceByKind[kind] = null;
  console.log(`[DebugTrace] Cleared last trace for ${kind}`);
}

export function exportTraceAsJSON(trace: DebugTrace): string {
  return JSON.stringify(trace, null, 2);
}

export function exportTraceAsTXT(trace: DebugTrace): string {
  const lines: string[] = [];

  lines.push('='.repeat(80));
  lines.push(`Debug Trace Export - ${trace.run_meta.kind.toUpperCase()}`);
  lines.push('='.repeat(80));
  lines.push('');
  lines.push(`Run ID: ${trace.run_meta.run_id}`);
  if (trace.run_meta.test_run_id) {
    lines.push(`Test Run ID: ${trace.run_meta.test_run_id}`);
  }
  if (trace.run_meta.git_sha) {
    lines.push(`Git SHA: ${trace.run_meta.git_sha}`);
  }
  lines.push(`Started: ${trace.run_meta.started_at}`);
  if (trace.run_meta.finished_at) {
    lines.push(`Finished: ${trace.run_meta.finished_at}`);
  }
  lines.push('');
  lines.push('SUMMARY');
  lines.push('-'.repeat(80));
  lines.push(`Total Requests: ${trace.summary.total_requests}`);
  lines.push(`Errors: ${trace.summary.errors_count}`);
  lines.push(`Total Duration: ${trace.summary.total_duration_ms}ms`);
  if (trace.truncated) {
    lines.push('⚠️  Trace was truncated due to size limits');
  }
  lines.push('');
  lines.push('');

  trace.records.forEach((record, index) => {
    lines.push('='.repeat(80));
    lines.push(`REQUEST #${index + 1}`);
    lines.push('='.repeat(80));
    lines.push(`Timestamp: ${record.timestamp}`);
    lines.push(`Method: ${record.method}`);
    lines.push(`URL: ${record.url}`);
    lines.push(`Duration: ${record.duration_ms}ms`);
    lines.push(`Retry Attempt: ${record.retry_attempt}`);

    if (record.meta) {
      lines.push('Meta:');
      if (record.meta.step_order !== undefined) lines.push(`  Step Order: ${record.meta.step_order}`);
      if (record.meta.step_id) lines.push(`  Step ID: ${record.meta.step_id}`);
      if (record.meta.template_id) lines.push(`  Template ID: ${record.meta.template_id}`);
      if (record.meta.template_name) lines.push(`  Template Name: ${record.meta.template_name}`);
      if (record.meta.label) lines.push(`  Label: ${record.meta.label}`);
    }

    lines.push('');
    lines.push('REQUEST HEADERS:');
    Object.entries(record.headers).forEach(([key, value]) => {
      lines.push(`  ${key}: ${value}`);
    });

    if (record.body) {
      lines.push('');
      lines.push('REQUEST BODY:');
      lines.push(record.body);
      if (record.truncated_body) {
        lines.push('  [BODY TRUNCATED]');
      }
    }

    lines.push('');

    if (record.error) {
      lines.push('ERROR:');
      lines.push(record.error);
    } else if (record.response) {
      lines.push(`RESPONSE STATUS: ${record.response.status} ${record.response.statusText}`);
      lines.push('');
      lines.push('RESPONSE HEADERS:');
      Object.entries(record.response.headers).forEach(([key, value]) => {
        lines.push(`  ${key}: ${value}`);
      });

      if (record.response.body) {
        lines.push('');
        lines.push('RESPONSE BODY:');
        lines.push(record.response.body);
        if (record.response.truncated_body) {
          lines.push('  [BODY TRUNCATED]');
        }
      }
    }

    lines.push('');
    lines.push('');
  });

  return lines.join('\n');
}

export function exportTraceAsRawHTTP(trace: DebugTrace): string {
  const sections: string[] = [];

  trace.records.forEach((record, index) => {
    const lines: string[] = [];

    lines.push(`# Request #${index + 1}`);
    if (record.meta) {
      if (record.meta.step_order !== undefined) lines.push(`# Step: ${record.meta.step_order}`);
      if (record.meta.template_name) lines.push(`# Template: ${record.meta.template_name}`);
      if (record.meta.label) lines.push(`# Label: ${record.meta.label}`);
    }
    lines.push(`# Timestamp: ${record.timestamp}`);
    lines.push(`# Duration: ${record.duration_ms}ms`);
    lines.push('');

    const url = new URL(record.url);
    const path = url.pathname + url.search;

    lines.push(`${record.method} ${path} HTTP/1.1`);

    const headers = { ...record.headers };
    if (!headers['Host'] && !headers['host']) {
      headers['Host'] = url.host;
    }

    Object.entries(headers).forEach(([key, value]) => {
      lines.push(`${key}: ${value}`);
    });

    if (record.body) {
      lines.push('');
      lines.push(record.body);
      if (record.truncated_body) {
        lines.push('');
        lines.push('# [BODY TRUNCATED]');
      }
    }

    sections.push(lines.join('\n'));
  });

  const header: string[] = [];
  header.push('# ========================================');
  header.push(`# Debug Trace Export - ${trace.run_meta.kind.toUpperCase()}`);
  header.push('# ========================================');
  header.push(`# Run ID: ${trace.run_meta.run_id}`);
  if (trace.run_meta.test_run_id) {
    header.push(`# Test Run ID: ${trace.run_meta.test_run_id}`);
  }
  header.push(`# Total Requests: ${trace.summary.total_requests}`);
  header.push(`# Errors: ${trace.summary.errors_count}`);
  if (trace.truncated) {
    header.push('# WARNING: Trace was truncated due to size limits');
  }
  header.push('# ========================================');
  header.push('# Format: Raw HTTP requests (paste directly into Burp Repeater)');
  header.push('# ========================================');
  header.push('');

  return header.join('\n') + '\n' + sections.join('\n\n' + '='.repeat(80) + '\n\n');
}
