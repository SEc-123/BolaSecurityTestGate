/**
 * Strict client contract for an optional, isolated desktop executor.
 *
 * This is deliberately not a general remote-command client.  It can call only
 * the four documented desktop routes, sends a bearer token on *every* request
 * (including health), and will not hand a desktop to business evidence code
 * until an independently-attested CDP + network-capture bridge proves that
 * the desktop and captured browser are the same owned browser.
 *
 * The current computer-use-offline bundle is intentionally incompatible: its
 * unauthenticated /health response and /state payload have neither this auth
 * attestation nor the required CDP/network bridge.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertUrlInTargetScope } from '../target-scope.js';

export const DESKTOP_EXECUTOR_CONFIG_VERSION = 1;
export const DESKTOP_EXECUTOR_BRIDGE_SCHEMA = 'bstg.desktop-executor.bridge.v1';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const ALLOWED_ENDPOINTS = ['health', 'state', 'screenshot', 'action'] as const;
const SAFE_KEYS = new Set(['enter', 'tab', 'escape', 'space', 'backspace', 'delete', 'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown', 'a', 'c', 'v', 'x', 'z', 'y']);

/**
 * Hotkeys are intentionally stricter than individual keys.  A generic
 * modifier + safe-key rule would accidentally admit application and system
 * escapes such as Alt+Tab, Ctrl+Tab, Ctrl+Alt+Delete, and Ctrl+Shift+C.  The
 * runner is an evidence surface, so retain only common in-page editing and
 * focus/selection gestures that cannot switch browser/application context.
 *
 * Command/Super is deliberately absent.  The current external executor is a
 * Linux desktop, where it maps to a window-manager key; a future platform
 * specific executor can add a separately attested platform contract instead
 * of treating that key as universally safe.
 */
const SAFE_HOTKEYS = new Set([
  'ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+y',
  'ctrl+shift+z',
  'shift+tab', 'shift+enter',
  'shift+left', 'shift+right', 'shift+up', 'shift+down',
  'shift+home', 'shift+end', 'shift+pageup', 'shift+pagedown',
]);

export type DesktopExecutorAction =
  | { action: 'open'; url: string }
  | { action: 'click' | 'double_click' | 'move'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { action: 'drag'; x: number; y: number; to_x: number; to_y: number; duration?: number; button?: 'left' | 'middle' | 'right' }
  | { action: 'type' | 'insert_text'; text: string }
  | { action: 'press'; key: string }
  | { action: 'hotkey'; keys: string[] }
  | { action: 'scroll'; clicks: number }
  | { action: 'wait'; seconds: number };

export interface DesktopExecutorConfig {
  version: 1;
  /** Origin only.  The adapter appends its fixed allowlisted endpoint paths. */
  endpoint: string;
  /** Kept in a 0600 private JSON file; never included in diagnostic output. */
  bearer_token: string;
  /** Non-loopback endpoints require explicit opt-in and HTTPS. */
  allow_remote?: boolean;
  request_timeout_ms?: number;
}

export interface DesktopExecutorBridge {
  schema: typeof DESKTOP_EXECUTOR_BRIDGE_SCHEMA;
  browser_instance_id: string;
  cdp_ws_endpoint: string;
  target_id: string;
  ownership: 'exclusive';
  network_capture: {
    mode: 'cdp_fetch';
    active: true;
    capture_id: string;
    target_id: string;
  };
}

export interface DesktopExecutorState {
  url: string;
  title?: string;
  screen: [number, number];
  mouse?: [number, number];
  viewport?: Record<string, unknown>;
  bridge: DesktopExecutorBridge;
}

export interface DesktopExecutorHealth {
  ok: true;
  authentication: { required: true; scheme: 'bearer' };
  allowed_endpoints: readonly ['health', 'state', 'screenshot', 'action'];
  bridge_schema: typeof DESKTOP_EXECUTOR_BRIDGE_SCHEMA;
}

export interface DesktopExecutorBridgeAttestation {
  /** The attester connected through the returned CDP endpoint, not a copy. */
  same_browser: true;
  /** A CDP Network + Fetch observer is attached to the exact captured target. */
  network_capture_attached: true;
  browser_instance_id: string;
  target_id: string;
  capture_id: string;
}

export interface DesktopExecutorBridgeAttester {
  attest(input: { state: DesktopExecutorState; bridge: DesktopExecutorBridge; scope_base_url: string }): Promise<DesktopExecutorBridgeAttestation>;
}

export interface DesktopExecutorAcquireInput {
  config: DesktopExecutorConfig;
  scope_base_url: string;
  bridge_attester: DesktopExecutorBridgeAttester;
  fetch_impl?: typeof fetch;
  signal?: AbortSignal;
}

export class DesktopExecutorContractError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = 'DesktopExecutorContractError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, label: string, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONTRACT', `${label} is invalid.`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONFIG', `${label} must be a boolean.`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONTRACT', `${label} is invalid.`);
  return Number(value);
}

function actionInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_ACTION', `${label} is invalid.`);
  return Number(value);
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_ACTION', `${label} is invalid.`);
  return value;
}

function normalizedOrigin(value: string, allowRemote: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONFIG', 'Desktop executor endpoint must be an absolute HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONFIG', 'Desktop executor endpoint must be an origin without credentials, path, query, or fragment.');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (!loopback && !allowRemote) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_REMOTE_NOT_ALLOWED', 'A non-loopback desktop executor requires allow_remote: true.');
  if (!loopback && url.protocol !== 'https:') throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_REMOTE_TLS_REQUIRED', 'A remote desktop executor must use HTTPS.');
  return url;
}

function configKeys(value: Record<string, unknown>): void {
  const allowed = new Set(['version', 'endpoint', 'bearer_token', 'allow_remote', 'request_timeout_ms']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONFIG', `Unknown desktop executor configuration key: ${key}.`);
}

/** Parse a deliberately small private config.  It does not accept bridge data:
 * bridge identity must come from authenticated runtime state, per session. */
export function parseDesktopExecutorConfig(value: unknown): DesktopExecutorConfig {
  if (!isRecord(value)) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONFIG', 'Desktop executor configuration must be an object.');
  configKeys(value);
  if (value.version !== DESKTOP_EXECUTOR_CONFIG_VERSION) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONFIG', `Desktop executor configuration version must be ${DESKTOP_EXECUTOR_CONFIG_VERSION}.`);
  const allowRemote = value.allow_remote === undefined ? false : boolean(value.allow_remote, 'allow_remote');
  const endpoint = text(value.endpoint, 'endpoint', 2048);
  normalizedOrigin(endpoint, allowRemote);
  const bearerToken = text(value.bearer_token, 'bearer_token', 4096);
  const requestTimeout = value.request_timeout_ms === undefined ? undefined : integer(value.request_timeout_ms, 'request_timeout_ms', 250, 60_000);
  return { version: 1, endpoint, bearer_token: bearerToken, ...(allowRemote ? { allow_remote: true } : {}), ...(requestTimeout ? { request_timeout_ms: requestTimeout } : {}) };
}

/** The file is intentionally the only environment-provided configuration.
 * Environment variables must not carry a bearer token or a mutable bridge. */
export async function loadDesktopExecutorConfigFromFile(file: string): Promise<DesktopExecutorConfig> {
  if (!path.isAbsolute(file)) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONFIG', 'BSTG_DESKTOP_EXECUTOR_CONFIG_FILE must be an absolute path.');
  let details: Awaited<ReturnType<typeof stat>>;
  try { details = await stat(file); } catch { throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CONFIG_UNREADABLE', 'Desktop executor configuration file cannot be read.'); }
  if (!details.isFile()) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONFIG', 'Desktop executor configuration must be a regular file.');
  if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CONFIG_PERMISSIONS', 'Desktop executor configuration file must be owner-readable only (0600).');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONFIG', 'Desktop executor configuration is not valid JSON.'); }
  return parseDesktopExecutorConfig(parsed);
}

export async function loadDesktopExecutorConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<DesktopExecutorConfig | null> {
  const file = env.BSTG_DESKTOP_EXECUTOR_CONFIG_FILE?.trim();
  return file ? loadDesktopExecutorConfigFromFile(file) : null;
}

function endpointUrl(config: DesktopExecutorConfig, name: (typeof ALLOWED_ENDPOINTS)[number]): URL {
  const base = normalizedOrigin(config.endpoint, config.allow_remote === true);
  const pathname = name === 'screenshot' ? '/screenshot.png' : `/${name}`;
  return new URL(pathname, base);
}

function requireJson(value: unknown, endpoint: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_RESPONSE', `${endpoint} did not return an object.`);
  return value;
}

/** Do not rely on Content-Length alone: a compromised local/remote runner may
 * stream an unbounded body or omit that header. */
async function readBoundedResponse(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (!Number.isFinite(contentLength) || contentLength > MAX_RESPONSE_BYTES) {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_RESPONSE_TOO_LARGE', 'Desktop executor response exceeds the allowed size.');
  }
  const body: any = response.body;
  if (!body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_RESPONSE_TOO_LARGE', 'Desktop executor response exceeds the allowed size.');
    return bytes;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_RESPONSE_TOO_LARGE', 'Desktop executor response exceeds the allowed size.');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const bytes = await readBoundedResponse(response);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { return null; }
}

function parseHealth(value: unknown): DesktopExecutorHealth {
  const data = requireJson(value, 'health');
  if (data.ok !== true || !isRecord(data.authentication) || data.authentication.required !== true || data.authentication.scheme !== 'bearer') {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_HEALTH_AUTH_REQUIRED', 'Desktop executor health must attest that bearer authentication is required.');
  }
  const endpoints = Array.isArray(data.allowed_endpoints) ? data.allowed_endpoints : undefined;
  const advertised = endpoints ? new Set(endpoints) : null;
  if (!endpoints || !advertised || endpoints.length !== ALLOWED_ENDPOINTS.length || advertised.size !== ALLOWED_ENDPOINTS.length ||
    ALLOWED_ENDPOINTS.some(item => !advertised.has(item))) {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_ENDPOINT_ALLOWLIST_REQUIRED', 'Desktop executor must attest exactly the health, state, screenshot, and action endpoint allowlist.');
  }
  if (data.bridge_schema !== DESKTOP_EXECUTOR_BRIDGE_SCHEMA) {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_REQUIRED', 'Desktop executor does not advertise the required CDP/network bridge schema.');
  }
  return data as unknown as DesktopExecutorHealth;
}

function parseBridge(value: unknown, executor: URL): DesktopExecutorBridge {
  if (!isRecord(value)) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_REQUIRED', 'Desktop executor state has no CDP/network capture bridge.');
  const data = value;
  if (data.schema !== DESKTOP_EXECUTOR_BRIDGE_SCHEMA || data.ownership !== 'exclusive') {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_REQUIRED', 'Desktop executor has no exclusive CDP/network capture bridge.');
  }
  const browserInstanceId = text(data.browser_instance_id, 'bridge.browser_instance_id', 300);
  const cdpWsEndpoint = text(data.cdp_ws_endpoint, 'bridge.cdp_ws_endpoint', 2048);
  let cdp: URL;
  try { cdp = new URL(cdpWsEndpoint); } catch { throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_REQUIRED', 'Desktop executor CDP endpoint is invalid.'); }
  if (!['ws:', 'wss:'].includes(cdp.protocol) || cdp.username || cdp.password || cdp.search || cdp.hash) {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_REQUIRED', 'Desktop executor CDP endpoint must be a credential-free ws:// or wss:// endpoint.');
  }
  const executorLoopback = executor.hostname === '127.0.0.1' || executor.hostname === '[::1]' || executor.hostname === '::1';
  if (cdp.hostname !== executor.hostname || (!executorLoopback && cdp.protocol !== 'wss:')) {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_REQUIRED', 'Desktop executor CDP endpoint must stay on the executor host and use WSS for remote execution.');
  }
  const targetId = text(data.target_id, 'bridge.target_id', 500);
  if (!isRecord(data.network_capture) || data.network_capture.mode !== 'cdp_fetch' || data.network_capture.active !== true || data.network_capture.target_id !== targetId) {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_REQUIRED', 'Desktop executor does not expose an active CDP Fetch capture for its target.');
  }
  const captureId = text(data.network_capture.capture_id, 'bridge.network_capture.capture_id', 500);
  return { schema: DESKTOP_EXECUTOR_BRIDGE_SCHEMA, browser_instance_id: browserInstanceId, cdp_ws_endpoint: cdpWsEndpoint,
    target_id: targetId, ownership: 'exclusive', network_capture: { mode: 'cdp_fetch', active: true, capture_id: captureId, target_id: targetId } };
}

function parseState(value: unknown, executor: URL): DesktopExecutorState {
  const data = requireJson(value, 'state');
  const url = text(data.url, 'state.url', 8192);
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch { throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_RESPONSE', 'Desktop executor state URL is invalid.'); }
  if (!Array.isArray(data.screen) || data.screen.length !== 2) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_RESPONSE', 'Desktop executor state screen is invalid.');
  const screen: [number, number] = [integer(data.screen[0], 'state.screen[0]', 100, 16_384), integer(data.screen[1], 'state.screen[1]', 100, 16_384)];
  let mouse: [number, number] | undefined;
  if (data.mouse !== undefined) {
    if (!Array.isArray(data.mouse) || data.mouse.length !== 2) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_RESPONSE', 'Desktop executor state mouse is invalid.');
    mouse = [integer(data.mouse[0], 'state.mouse[0]', 0, screen[0]), integer(data.mouse[1], 'state.mouse[1]', 0, screen[1])];
  }
  return { url, ...(typeof data.title === 'string' ? { title: data.title.slice(0, 1000) } : {}), screen, ...(mouse ? { mouse } : {}),
    ...(isRecord(data.viewport) ? { viewport: data.viewport } : {}), bridge: parseBridge(data.bridge, executor) };
}

function sameBridge(expected: DesktopExecutorBridge, actual: DesktopExecutorBridge): void {
  if (actual.browser_instance_id !== expected.browser_instance_id || actual.target_id !== expected.target_id ||
    actual.cdp_ws_endpoint !== expected.cdp_ws_endpoint || actual.network_capture.capture_id !== expected.network_capture.capture_id ||
    actual.network_capture.target_id !== expected.network_capture.target_id) {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_BROWSER_BINDING_CHANGED', 'Desktop executor browser or capture binding changed during an evidence session.');
  }
}

function assertStateInTargetScope(state: DesktopExecutorState, scopeBaseUrl: string): void {
  try { assertUrlInTargetScope(state.url, scopeBaseUrl); }
  catch { throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_OUT_OF_SCOPE', 'Desktop executor state left the declared business target scope.'); }
}

function validateAttestation(attestation: DesktopExecutorBridgeAttestation, bridge: DesktopExecutorBridge): void {
  if (!isRecord(attestation) || attestation.same_browser !== true || attestation.network_capture_attached !== true ||
    attestation.browser_instance_id !== bridge.browser_instance_id || attestation.target_id !== bridge.target_id ||
    attestation.capture_id !== bridge.network_capture.capture_id) {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_UNATTESTED', 'The CDP/network capture attestation does not bind to this desktop browser.');
  }
}

function actionObject(action: DesktopExecutorAction, screen: [number, number], scopeBaseUrl: string): Record<string, unknown> {
  if (!action || typeof action !== 'object' || typeof (action as any).action !== 'string') {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_ACTION', 'Desktop action must be an allowlisted object.');
  }
  const point = (x: unknown, y: unknown, prefix = '') => ({
    [`${prefix}x`]: actionInteger(x, `${prefix}x`, 0, screen[0] - 1),
    [`${prefix}y`]: actionInteger(y, `${prefix}y`, 0, screen[1] - 1),
  });
  const button = (value: unknown) => {
    if (value === undefined) return undefined;
    if (!['left', 'middle', 'right'].includes(String(value))) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_ACTION', 'Desktop mouse button is invalid.');
    return value as 'left' | 'middle' | 'right';
  };
  switch (action.action) {
    case 'open': {
      const url = text(action.url, 'action.url', 8192);
      return { action: 'open', url: assertUrlInTargetScope(url, scopeBaseUrl).toString() };
    }
    case 'click': case 'double_click': case 'move': {
      const out: Record<string, unknown> = { action: action.action, ...point(action.x, action.y) };
      const selected = button(action.button); if (selected) out.button = selected;
      return out;
    }
    case 'drag': {
      const out: Record<string, unknown> = { action: 'drag', ...point(action.x, action.y), ...point(action.to_x, action.to_y, 'to_') };
      const duration = action.duration === undefined ? undefined : number(action.duration, 'duration', 0.1, 3);
      const selected = button(action.button); if (duration !== undefined) out.duration = duration; if (selected) out.button = selected;
      return out;
    }
    case 'type': case 'insert_text': {
      const value = text(action.text, 'action.text', 4096);
      if (action.action === 'type' && !/^[\x20-\x7e\r\n\t]*$/.test(value)) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_ACTION', 'Physical keyboard type action accepts ASCII only; use insert_text for Unicode.');
      return { action: action.action, text: value };
    }
    case 'press': {
      const key = text(action.key, 'action.key', 40).toLowerCase();
      if (!SAFE_KEYS.has(key)) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_ACTION', 'Desktop key is outside the evidence action allowlist.');
      return { action: 'press', key };
    }
    case 'hotkey': {
      if (!Array.isArray(action.keys) || action.keys.length < 2 || action.keys.length > 3) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_ACTION', 'Desktop hotkey must have two or three allowlisted keys.');
      const keys = action.keys.map(key => text(key, 'action.keys', 40).toLowerCase());
      if (new Set(keys).size !== keys.length || !SAFE_HOTKEYS.has(keys.join('+'))) {
        throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_ACTION', 'Desktop hotkey is outside the evidence action allowlist.');
      }
      return { action: 'hotkey', keys };
    }
    case 'scroll':
      return { action: 'scroll', clicks: actionInteger(action.clicks, 'clicks', -100, 100) };
    case 'wait':
      return { action: 'wait', seconds: number(action.seconds, 'seconds', 0, 5) };
    default:
      throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_ACTION', 'Desktop action is unsupported.');
  }
}

class AuthorizedDesktopExecutorTransport {
  readonly #config: DesktopExecutorConfig;
  readonly #fetch: typeof fetch;
  readonly #signal?: AbortSignal;

  constructor(config: DesktopExecutorConfig, fetchImpl: typeof fetch | undefined, signal?: AbortSignal) {
    this.#config = parseDesktopExecutorConfig(config);
    this.#fetch = fetchImpl || fetch;
    this.#signal = signal;
  }

  private async request(name: (typeof ALLOWED_ENDPOINTS)[number], init: { method: 'GET' | 'POST'; body?: string; accept: string }): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#config.request_timeout_ms || DEFAULT_TIMEOUT_MS);
    const abort = () => controller.abort();
    this.#signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.#fetch(endpointUrl(this.#config, name), {
        method: init.method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#config.bearer_token}`,
          accept: init.accept,
          'cache-control': 'no-store',
          ...(init.body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
      });
      if (!response.ok) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_REQUEST_REJECTED', `Desktop executor ${name} request was rejected (${response.status}).`);
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (!Number.isFinite(contentLength) || contentLength > MAX_RESPONSE_BYTES) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_RESPONSE_TOO_LARGE', 'Desktop executor response exceeds the allowed size.');
      return response;
    } catch (error) {
      if (error instanceof DesktopExecutorContractError) throw error;
      if (controller.signal.aborted) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_REQUEST_TIMEOUT', 'Desktop executor request did not finish within its bounded timeout.');
      throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_UNAVAILABLE', 'Desktop executor is unavailable.');
    } finally {
      clearTimeout(timeout);
      this.#signal?.removeEventListener('abort', abort);
    }
  }

  async health(): Promise<DesktopExecutorHealth> {
    const response = await this.request('health', { method: 'GET', accept: 'application/json' });
    return parseHealth(await readJsonResponse(response));
  }

  async state(): Promise<DesktopExecutorState> {
    const response = await this.request('state', { method: 'GET', accept: 'application/json' });
    return parseState(await readJsonResponse(response), endpointUrl(this.#config, 'state'));
  }

  async screenshot(): Promise<Buffer> {
    const response = await this.request('screenshot', { method: 'GET', accept: 'image/png' });
    if (!/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_RESPONSE', 'Desktop executor screenshot must be PNG.');
    const bytes = await readBoundedResponse(response);
    if (!bytes.length || bytes.length > MAX_RESPONSE_BYTES) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_RESPONSE', 'Desktop executor screenshot is empty or too large.');
    return bytes;
  }

  async action(payload: Record<string, unknown>): Promise<DesktopExecutorState> {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 16 * 1024) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_ACTION', 'Desktop action is too large.');
    const response = await this.request('action', { method: 'POST', body, accept: 'application/json' });
    const data = requireJson(await readJsonResponse(response), 'action');
    if (data.ok !== true || !isRecord(data.state)) throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_RESPONSE', 'Desktop executor action did not return an authenticated state result.');
    return parseState(data.state, endpointUrl(this.#config, 'action'));
  }
}

/** A lease is the only adapter surface suitable for a business evidence chain.
 * It is created only after a server-side CDP/Fetch attester binds the external
 * desktop browser to the exact network-captured target. */
export class BusinessEvidenceDesktopExecutor {
  readonly bridge: DesktopExecutorBridge;
  readonly initial_state: DesktopExecutorState;
  readonly #transport: AuthorizedDesktopExecutorTransport;
  readonly #scopeBaseUrl: string;
  #closed = false;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(transport: AuthorizedDesktopExecutorTransport, state: DesktopExecutorState, scopeBaseUrl: string) {
    this.#transport = transport;
    this.initial_state = state;
    this.bridge = state.bridge;
    this.#scopeBaseUrl = scopeBaseUrl;
  }

  /**
   * Evidence leases are deliberately one-way.  A failure can leave a visual
   * action partly applied, or make its browser/capture identity unknowable;
   * allowing a later call to recover that lease would turn an uncertain
   * operation into evidence.  Callers must acquire and attest a new lease.
   */
  #assertOpen(): void {
    if (this.#closed) {
      throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_LEASE_CLOSED', 'Desktop evidence lease is closed after a failed transport, action, scope, or bridge check. Acquire a new attested lease.');
    }
  }

  async #withOpenLease<T>(operation: () => Promise<T>): Promise<T> {
    // Serialize calls on a lease.  Without this, a second action could pass
    // its initial open check while a first action is still failing, then issue
    // an executor request after the first action closes the lease.
    const previous = this.#operationTail;
    let release: (() => void) | undefined;
    this.#operationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      this.#assertOpen();
      return await operation();
    } catch (error) {
      this.#closed = true;
      throw error;
    } finally {
      release?.();
    }
  }

  async #readBoundState(): Promise<DesktopExecutorState> {
    const state = await this.#transport.state();
    sameBridge(this.bridge, state.bridge);
    assertStateInTargetScope(state, this.#scopeBaseUrl);
    return state;
  }

  async health(): Promise<DesktopExecutorHealth> {
    return this.#withOpenLease(() => this.#transport.health());
  }

  async state(): Promise<DesktopExecutorState> {
    return this.#withOpenLease(() => this.#readBoundState());
  }

  async screenshot(): Promise<Buffer> {
    // A PNG has no self-describing browser identity. Bind it to the same
    // authenticated bridge immediately before and after capture.
    return this.#withOpenLease(async () => {
      await this.#readBoundState();
      const screenshot = await this.#transport.screenshot();
      await this.#readBoundState();
      return screenshot;
    });
  }

  async action(action: DesktopExecutorAction): Promise<DesktopExecutorState> {
    return this.#withOpenLease(async () => {
      // The pre-action state establishes both the browser binding and scope.
      const before = await this.#readBoundState();
      const state = await this.#transport.action(actionObject(action, before.screen, this.#scopeBaseUrl));
      sameBridge(this.bridge, state.bridge);
      // Never accept an action result that navigated outside the declared
      // target.  A separate state read also prevents a stale action payload
      // from being treated as the post-action browser state.
      assertStateInTargetScope(state, this.#scopeBaseUrl);
      return this.#readBoundState();
    });
  }
}

/**
 * Acquire the only desktop-executor object that an evidence-producing flow may
 * use.  A runtime merely exposing PyAutoGUI/Playwright actions is insufficient:
 * it must expose the authenticated bridge state and the caller must attach an
 * exact CDP Fetch/Network observer before this resolves.
 */
export async function acquireBusinessEvidenceDesktopExecutor(input: DesktopExecutorAcquireInput): Promise<BusinessEvidenceDesktopExecutor> {
  if (!input?.bridge_attester || typeof input.bridge_attester.attest !== 'function') {
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_UNATTESTED', 'Business evidence requires an explicit server-side CDP/network bridge attester.');
  }
  const scopeBaseUrl = text(input.scope_base_url, 'scope_base_url', 8192);
  try { assertUrlInTargetScope(scopeBaseUrl, scopeBaseUrl); } catch { throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_INVALID_CONFIG', 'Business evidence scope_base_url is invalid.'); }
  const transport = new AuthorizedDesktopExecutorTransport(input.config, input.fetch_impl, input.signal);
  await transport.health();
  const state = await transport.state();
  assertStateInTargetScope(state, scopeBaseUrl);
  let attestation: DesktopExecutorBridgeAttestation;
  try {
    attestation = await input.bridge_attester.attest({ state, bridge: state.bridge, scope_base_url: scopeBaseUrl });
  } catch {
    // No lease has been created yet.  Normalize attester transport/runtime
    // failures so callers cannot mistake an unverified desktop for a usable
    // evidence source.
    throw new DesktopExecutorContractError('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_UNATTESTED', 'Desktop CDP/network bridge attestation failed.');
  }
  validateAttestation(attestation, state.bridge);
  return new BusinessEvidenceDesktopExecutor(transport, state, scopeBaseUrl);
}
