import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCommand, splitCommandLine, startBackgroundCommand } from './command-runner.js';
import { isOfflineProfile } from './mobile-target-contract.js';
import net from 'node:net';
import type { MobileLabProfile, NormalizedHttpFlow } from './mobile-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');

function asHeaders(value: any): Record<string, any> {
  if (!value) return {};
  if (Array.isArray(value)) {
    const out: Record<string, any> = {};
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2) out[String(item[0]).toLowerCase()] = item[1];
      else if (item && typeof item === 'object' && item.name) out[String(item.name).toLowerCase()] = item.value;
    }
    return out;
  }
  if (typeof value === 'object') return value;
  return {};
}

async function fetchJson(url: string, timeoutMs = 10000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeRawFlow(raw: any, index: number): NormalizedHttpFlow | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw.request || raw.req || {};
  const response = raw.response || raw.res || {};
  const method = String(raw.method || request.method || '').toUpperCase();
  const url = String(raw.url || request.url || raw.request_url || '').trim();
  if (!method || !url) return null;
  return {
    sequence: Number(raw.sequence || raw.index || index + 1),
    flow_id: raw.flow_id,
    test_run_id: raw.test_run_id, step_id: raw.step_id, completed_at: raw.completed_at,
    request_complete: raw.request_complete === true, response_complete: raw.response_complete === true,
    request_headers_raw: raw.request_headers_raw, response_headers_raw: raw.response_headers_raw,
    request_raw_body_base64: raw.request_raw_body_base64, response_raw_body_base64: raw.response_raw_body_base64,
    request_body_base64: raw.request_body_base64, response_body_base64: raw.response_body_base64, tls: raw.tls,
    capture_session_id: raw.capture_session_id,
    attribution: raw.attribution,
    method,
    url,
    request_headers: asHeaders(raw.request_headers || request.headers),
    request_body_text: raw.request_body_text ?? request.bodyText ?? request.body ?? raw.requestBody,
    response_status: raw.response_status === undefined ? (response.statusCode ?? response.status) : raw.response_status,
    response_headers: asHeaders(raw.response_headers || response.headers),
    response_body_text: raw.response_body_text ?? response.bodyText ?? response.body ?? raw.responseBody,
    source_tool: raw.source_tool || raw.source || 'internal_burp',
    // HTTPS scheme only proves transport intent. A capture source must explicitly attest decryption.
    tls_decrypted: raw.tls_decrypted === true,
    app_package: raw.app_package,
    device_id: raw.device_id,
    started_at: raw.started_at || raw.time || raw.timestamp,
  };
}

export function parseFlowText(text: string, name = 'capture'): NormalizedHttpFlow[] {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  const flows: NormalizedHttpFlow[] = [];
  if (/\.jsonl$/i.test(name)) {
    const lines = String(text).split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim()) continue;
      try {
        const normalized = normalizeRawFlow(JSON.parse(line), flows.length);
        if (normalized) flows.push(normalized);
      } catch (error) {
        // A live writer may be in the middle of the last line. Never skip a bad
        // completed line, which would silently discard evidence.
        if (index === lines.length - 1 && !text.endsWith('\n')) break;
        throw new Error(`Malformed capture JSONL at line ${index + 1}.`);
      }
    }
    return flows;
  }
  const parsed = JSON.parse(trimmed);
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.flows) ? parsed.flows : Array.isArray(parsed.items) ? parsed.items : parsed.data?.flows ? parsed.data.flows : [parsed];
  for (const item of arr) {
    const normalized = normalizeRawFlow(item, flows.length);
    if (normalized) flows.push(normalized);
  }
  return flows;
}

export class BurpCaptureService {
  constructor(private readonly profile: MobileLabProfile) {}

  private captureExportPath(): string {
    const configured = String(this.profile.config_json?.burp_flow_export_path || '').trim();
    return configured || path.join(PROJECT_ROOT, 'mobile-lab', 'flows', `${this.profile.id}-latest.jsonl`);
  }

  async startIfConfigured(): Promise<Record<string, any>> {
    if (isOfflineProfile(this.profile)) return { started: true, simulated: true, source: 'offline_simulator' };
    if (this.profile.proxy_type === 'none') return { started: false, skipped: true };
    const commandLine = String(this.profile.config_json?.burp_start_command || '').trim();
    if (commandLine && !isOfflineProfile(this.profile) && this.profile.config_json?.strict_real_e2e !== false) throw new Error('Strict managed capture requires the built-in mitmproxy adapter, not an opaque start command. Configure mitmdump_path instead.');
    if (commandLine) {
      const parsed = splitCommandLine(commandLine);
      const result = await startBackgroundCommand(parsed.command, parsed.args, { startupGraceMs: Number(this.profile.config_json?.burp_start_grace_ms || 900) });
      return { started: result.ok, source: 'configured_command', command: result.command, args: result.args, pid: result.pid, error: result.error };
    }
    const managed = this.profile.proxy_type === 'mitmproxy' || this.profile.config_json?.managed_proxy === true || this.profile.config_json?.managed_proxy === 'true';
    if (!managed) return { started: false, reason: 'No managed proxy or burp_start_command configured; strict profiles must provide a capture process.' };
    const upstream = String(this.profile.config_json?.mitm_reverse_upstream || '').trim();
    const proxyMode = String(this.profile.config_json?.mitm_proxy_mode || (upstream ? 'reverse' : '')).trim().toLowerCase();
    if (proxyMode !== 'reverse' && proxyMode !== 'regular') {
      return { started: false, reason: 'Managed mitmproxy requires mitm_proxy_mode=reverse with an authorized local backend, or an explicit mitm_proxy_mode=regular for an authorized target.' };
    }
    if (proxyMode === 'reverse' && !upstream) return { started: false, reason: 'Managed reverse mitmproxy requires config_json.mitm_reverse_upstream for an authorized local backend.' };
    if (this.profile.config_json?.strict_real_e2e !== false) {
      if (this.profile.config_json?.allow_insecure_upstream === true) throw new Error('Strict HTTPS tests must verify upstream TLS; ssl_insecure is forbidden.');
      if (proxyMode === 'reverse' && new URL(upstream).protocol !== 'https:') throw new Error('Strict HTTPS tests cannot downgrade a reverse-proxy upstream to HTTP.');
    }
    const mitmdump = String(this.profile.config_json?.mitmdump_path || 'mitmdump').trim();
    const addon = path.resolve(String(this.profile.config_json?.mitm_capture_addon || path.join(PROJECT_ROOT, 'scripts', 'mobile-lab', 'mitm-jsonl-capture.py')));
    const confdir = path.resolve(String(this.profile.config_json?.managed_proxy_confdir || path.resolve(process.env.BSTG_DATA_DIR || path.join(PROJECT_ROOT, 'data'), 'mobile', 'proxy-ca', this.profile.id.replace(/[^a-zA-Z0-9_-]/g, '_'))));
    const capturePath = this.captureExportPath();
    await fs.mkdir(path.dirname(capturePath), { recursive: true, mode: 0o700 });
    const args = ['--set', `confdir=${confdir}`];
    if (proxyMode === 'reverse') args.push('--mode', `reverse:${upstream}`);
    else args.push('--mode', 'regular');
    args.push('--listen-host', String(this.profile.config_json?.proxy_listen_host || '127.0.0.1'), '--listen-port', String(this.profile.proxy_port || 8080), '-s', addon);
    // Override confdir/config.yaml as well as application config.
    args.push('--set', this.profile.config_json?.allow_insecure_upstream === true ? 'ssl_insecure=true' : 'ssl_insecure=false');
    const upstreamCa = this.profile.config_json?.upstream_ca_certificate_path;
    if (upstreamCa) { await fs.access(path.resolve(String(upstreamCa))); args.push('--set', `ssl_verify_upstream_trusted_ca=${path.resolve(String(upstreamCa))}`); }
    args.push('--set', 'connection_strategy=eager');
    const env = {
      ...process.env,
      BSTG_CAPTURE_OUTPUT: capturePath,
      BSTG_CAPTURE_ALLOW_HTTP: this.profile.config_json?.acquisition_mode==='explore' && this.profile.config_json?.capture_http_only===true ? 'true' : 'false',
      BSTG_CAPTURE_STEP_FILE: `${capturePath}.step.json`,
      BSTG_CAPTURE_DIAGNOSTICS: `${capturePath}.diagnostics.jsonl`,
      BSTG_CAPTURE_SESSION_ID: String(this.profile.config_json?.capture_session_id || ''),
      BSTG_CAPTURE_ALLOWED_HOSTS: JSON.stringify(this.profile.config_json?.capture_allowed_hosts || []),
      BSTG_CAPTURE_TARGET_PACKAGE: String(this.profile.config_json?.app_package || ''),
      BSTG_CAPTURE_DEVICE_ID: String(this.profile.adb_serial || this.profile.device_name || ''),
    };
    const listenPort = Number(this.profile.proxy_port || 0);
    if (listenPort > 0 && await isTcpListening(String(this.profile.config_json?.proxy_listen_host || '127.0.0.1'), listenPort)) {
      return { started: false, error: `Proxy port ${listenPort} is already occupied; BSTG will not reuse a different session's capture process.` };
    }
    const result = await startBackgroundCommand(mitmdump, args, { env, startupGraceMs: Number(this.profile.config_json?.proxy_start_grace_ms || 1100) });
    return { started: result.ok, source: 'bstg_managed_mitmproxy', proxy_mode: proxyMode, upstream: upstream || undefined, command: result.command, args: result.args, pid: result.pid, capture_path: capturePath, ca_confdir: confdir, error: result.error };
  }

  private async loadFlowsFromCaptureEndpoint(): Promise<NormalizedHttpFlow[]> {
    const explicit = String(this.profile.config_json?.burp_capture_url || this.profile.config_json?.capture_url || '').trim();
    const appium = String(this.profile.appium_server_url || this.profile.config_json?.appium_server_url || '').replace(/\/$/, '');
    const urls = [explicit, isOfflineProfile(this.profile) && appium ? `${appium}/bstg/mobile/capture` : ''].filter(Boolean);
    for (const url of urls) {
      try {
        const body = await fetchJson(url, Number(this.profile.config_json?.capture_timeout_ms || 10000));
        const data = body?.data || body;
        if (Array.isArray(data?.flows)) return data.flows.map((flow: any, index: number) => normalizeRawFlow(flow, index)).filter(Boolean) as NormalizedHttpFlow[];
        if (typeof data?.capture === 'string') return parseFlowText(data.capture, 'capture.jsonl');
        if (typeof body?.capture === 'string') return parseFlowText(body.capture, 'capture.jsonl');
      } catch {
        // Try next configured source.
      }
    }
    return [];
  }

  async loadFlows(input?: { export_path?: string; flows?: any[] }): Promise<NormalizedHttpFlow[]> {
    if (Array.isArray(input?.flows)) {
      return input.flows.map((flow, index) => normalizeRawFlow(flow, index)).filter(Boolean) as NormalizedHttpFlow[];
    }
    const managed = !isOfflineProfile(this.profile) && (this.profile.proxy_type === 'mitmproxy' || this.profile.config_json?.managed_proxy === true);
    if (!input?.export_path && !managed) {
      const endpointFlows = await this.loadFlowsFromCaptureEndpoint();
      if (endpointFlows.length > 0) return endpointFlows;
    }

    const exportPath = String(input?.export_path || this.captureExportPath()).trim();
    if (!exportPath) return [];
    const resolved = path.resolve(exportPath);
    let stat;
    try { stat = await fs.stat(resolved); } catch { return []; }
    const files: string[] = [];
    if (stat.isDirectory()) {
      const entries = await fs.readdir(resolved);
      for (const entry of entries) {
        if (/\.(json|jsonl)$/i.test(entry)) files.push(path.join(resolved, entry));
      }
    } else {
      files.push(resolved);
    }
    const flows: NormalizedHttpFlow[] = [];
    for (const file of files.sort()) {
      const info = await fs.stat(file);
      if (info.size > 32 * 1024 * 1024) throw new Error('Capture exceeds 32 MiB; rotate it before import.');
      const text = await fs.readFile(file, 'utf8');
      flows.push(...parseFlowText(text, file));
    }
    return flows;
  }
}

export async function isTcpListening(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: host === '0.0.0.0' ? '127.0.0.1' : host, port });
    let settled = false;
    const finish = (ok: boolean) => { if (!settled) { settled = true; socket.destroy(); resolve(ok); } };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
