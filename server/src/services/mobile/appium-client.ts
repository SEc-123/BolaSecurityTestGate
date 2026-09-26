import type { MobileLabProfile } from './mobile-types.js';

/** Native UI transport. Never falls back to ADB and never retries a mutating command. */
export interface AppiumSessionEvidence {
  session_id: string; device_id: string; automation_name: string; platform_name: string;
  source: 'appium_uiautomator2'; created_at: string; capabilities: Record<string, unknown>;
}
interface Entry { evidence: AppiumSessionEvidence; trace: Array<Record<string, unknown>>; }
const sessions = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';

export class AppiumCommandError extends Error {
  constructor(public readonly code: string, public readonly route: string, public readonly httpStatus?: number) {
    // Do not copy the Appium response: it may contain credentials sent to a text field.
    super(`APPIUM_${code}: ${route}. Inspect the protected Appium server log for details.`);
  }
}
function bounded(value: unknown, fallback: number, max = 180000): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 100 || Number(value) > max) throw new Error(`Appium timeout must be an integer between 100 and ${max} ms.`);
  return Number(value);
}
export function xpathLiteral(text: string): string {
  return !text.includes("'") ? `'${text}'` : !text.includes('"') ? `"${text}"` : `concat(${text.split("'").map(part => `'${part}'`).join(', "\'", ')})`;
}
export function appiumLocator(target: Record<string, any>, pkg: string): { using: string; value: string } {
  const selectors: string[] = [];
  const id = target.resourceId ?? target.resource_id;
  const desc = target.contentDesc ?? target.content_desc ?? target.accessibility_id;
  if (target.index !== undefined) throw new Error('Appium does not accept an unstable UI-tree index; use resource_id, content_desc or text.');
  if (target.match !== undefined && !['exact', 'contains'].includes(target.match)) throw new Error('Appium selector match must be exact or contains.');
  if (id !== undefined) selectors.push(`@resource-id=${xpathLiteral(String(id).includes('/') ? String(id) : `${pkg}:id/${id}`)}`);
  const comparison = (attribute: string, value: unknown) => target.match === 'contains'
    ? `contains(@${attribute},${xpathLiteral(String(value))})` : `@${attribute}=${xpathLiteral(String(value))}`;
  if (desc !== undefined) selectors.push(comparison('content-desc', desc));
  if (target.text !== undefined) selectors.push(comparison('text', target.text));
  if (!selectors.length) throw new Error('An explicit Appium selector is required.');
  selectors.push('@enabled="true"');
  return { using: 'xpath', value: `//*[${selectors.join(' and ')}]` };
}

export class NativeAppiumClient {
  readonly base: string;
  private readonly key: string;
  private readonly cfg: Record<string, any>;
  constructor(private readonly profile: MobileLabProfile) {
    this.cfg = profile.config_json || {};
    this.base = String(profile.appium_server_url || this.cfg.appium_server_url || '').replace(/\/+$/, '');
    this.key = `${this.base}|${profile.adb_serial || ''}|${this.cfg.mobile_session_id || ''}|${this.cfg.app_package || ''}`;
  }
  private validateEndpoint(): void {
    let url: URL;
    try { url = new URL(this.base); } catch { throw new Error('A real Appium server URL is required.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Appium URL. Use an HTTP(S) endpoint without credentials, query or fragment.');
    if (!this.profile.adb_serial) throw new Error('An explicit Appium UDID/ADB serial is required.');
  }
  private async request(route: string, method = 'GET', body?: unknown, timeoutMs?: number): Promise<any> {
    this.validateEndpoint();
    const started = Date.now();
    const entry = sessions.get(this.key);
    const trace: Record<string, unknown> = { method, route, started_at: new Date(started).toISOString(), ok: false };
    try {
      const response = await fetch(this.base + route, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? bounded(this.cfg.appium_command_timeout_ms, 30000)),
      });
      let payload: any;
      try { payload = await response.json(); } catch { throw new AppiumCommandError('invalid_response', route, response.status); }
      if (!response.ok || payload?.value?.error) throw new AppiumCommandError(String(payload?.value?.error || `http_${response.status}`).replace(/[^a-z0-9_ ]/gi, ''), route, response.status);
      trace.ok = true;
      return payload;
    } catch (error) {
      const safe = error instanceof AppiumCommandError ? error : new AppiumCommandError(error instanceof Error && /timeout|abort/i.test(error.name) ? 'timeout' : 'transport_error', route);
      trace.error_code = safe.code;
      throw safe;
    } finally {
      trace.duration_ms = Date.now() - started;
      if (entry) { entry.trace.push(trace); if (entry.trace.length > 2000) entry.trace.shift(); }
    }
  }
  async health(): Promise<Record<string, any>> {
    try {
      const body = await this.request('/status', 'GET', undefined, bounded(this.cfg.appium_health_timeout_ms, 10000, 30000));
      return { ok: body?.value?.ready === true, source: 'appium_status', ready: body?.value?.ready === true, version: body?.value?.build?.version, checked_at: new Date().toISOString() };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error), source: 'appium_status' }; }
  }
  async ensureSession(): Promise<Entry> {
    const existing = sessions.get(this.key);
    if (existing) return existing; // An invalid session must fail, not silently reset the App.
    const starting = pending.get(this.key);
    if (starting) return starting;
    const operation = this.createSession();
    pending.set(this.key, operation);
    try { return await operation; } finally { pending.delete(this.key); }
  }
  private async createSession(): Promise<Entry> {
    const capabilities: Record<string, unknown> = {
      platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': this.profile.adb_serial,
      'appium:noReset': true, 'appium:fullReset': false, 'appium:autoLaunch': false, 'appium:noSign': true,
      'appium:appPackage': this.cfg.app_package, 'appium:appActivity': this.cfg.app_activity,
      'appium:newCommandTimeout': 600, 'appium:uiautomator2ServerLaunchTimeout': 60000,
      'appium:uiautomator2ServerInstallTimeout': 60000,
    };
    if (this.cfg.appium_system_port !== undefined) {
      const port = this.cfg.appium_system_port;
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('appium_system_port must be an integer in 1024–65535.');
      capabilities['appium:systemPort'] = port;
    }
    const created = await this.request('/session', 'POST', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, bounded(this.cfg.appium_session_timeout_ms, 120000));
    const id = created?.value?.sessionId || created?.sessionId;
    if (typeof id !== 'string' || !id) throw new Error('Appium did not return a W3C session id.');
    const returned = created?.value?.capabilities || created?.capabilities || {};
    const strict = this.cfg.strict_real_e2e !== false;
    const udid = returned['appium:udid'] || returned.udid || returned.deviceUDID;
    const automation = returned['appium:automationName'] || returned.automationName;
    const platform = returned.platformName;
    // Retain even a mismatched session so cleanup can always delete it.
    const entry: Entry = { evidence: { session_id: id, device_id: String(udid || ''), automation_name: String(automation || ''), platform_name: String(platform || ''), source: 'appium_uiautomator2', created_at: new Date().toISOString(), capabilities: { udid, automationName: automation, platformName: platform, systemPort: returned['appium:systemPort'] || returned.systemPort } }, trace: [] };
    sessions.set(this.key, entry);
    if (strict && (udid !== this.profile.adb_serial || String(automation).toLowerCase() !== 'uiautomator2' || String(platform).toLowerCase() !== 'android')) {
      try { await this.close(); } catch { /* Ownership remains in the map for cleanup retry. */ }
      throw new Error('Appium returned unverified/mismatched UDID, platform or automation capabilities.');
    }
    return entry;
  }
  evidence(): AppiumSessionEvidence | undefined { return sessions.get(this.key)?.evidence; }
  trace(): Array<Record<string, unknown>> { return [...(sessions.get(this.key)?.trace || [])]; }
  async command(route: string, method = 'GET', body?: unknown): Promise<any> {
    const entry = await this.ensureSession();
    const result = await this.request(`/session/${encodeURIComponent(entry.evidence.session_id)}${route}`, method, body);
    return result.value;
  }
  async execute(script: string, args: Record<string, unknown> = {}): Promise<any> { return this.command('/execute/sync', 'POST', { script, args: [args] }); }
  async launch(pkg: string, activity?: string): Promise<Record<string, any>> {
    await this.ensureSession();
    if (activity) {
      const intent = activity.includes('/') ? activity : `${pkg}/${activity}`;
      const result = await this.execute('mobile: startActivity', { intent, wait: true, stop: false });
      if (/Error type \d+|Error: Activity class|Exception occurred/i.test(typeof result === 'string' ? result : JSON.stringify(result))) throw new Error('Appium startActivity failed.');
    } else await this.execute('mobile: activateApp', { appId: pkg });
    const end = Date.now() + bounded(this.cfg.launch_timeout_ms, 15000, 60000);
    let foreground: { package?: string; activity?: string; raw: string };
    do {
      foreground = await this.currentActivity();
      if (foreground.package === pkg) return { ok: true, package: pkg, focused_package: foreground.package, focused_activity: foreground.activity, package_verified: true, source: 'appium_uiautomator2', appium: this.evidence() };
      await sleep(250);
    } while (Date.now() < end);
    throw new Error('Appium launch did not reach the declared foreground package.');
  }
  async currentActivity(): Promise<{ package?: string; activity?: string; raw: string }> {
    const pkg = await this.execute('mobile: getCurrentPackage');
    const activity = await this.execute('mobile: getCurrentActivity');
    return { package: typeof pkg === 'string' ? pkg : undefined, activity: typeof activity === 'string' ? activity : undefined, raw: 'appium_uiautomator2' };
  }
  async source(): Promise<string> { const value = await this.command('/source'); if (typeof value !== 'string') throw new Error('Appium returned no XML source.'); return value; }
  async screenshot(): Promise<string> { const value = await this.command('/screenshot'); if (typeof value !== 'string') throw new Error('Appium returned no screenshot.'); return value; }
  private async element(target: Record<string, any>): Promise<string> {
    const locator = appiumLocator(target, String(this.cfg.app_package || ''));
    const end = Date.now() + bounded(this.cfg.appium_find_timeout_ms, 5000, 30000);
    do {
      const found = await this.command('/elements', 'POST', locator);
      if (!Array.isArray(found)) throw new Error('Appium returned an invalid element list.');
      if (found.length > 1) throw new Error('Appium selector must match exactly one enabled element; ambiguous selector.');
      if (found.length === 1) {
        const id = found[0]?.[elementKey] || found[0]?.ELEMENT;
        if (!id) throw new Error('Appium element has no identifier.');
        const visible = await this.command(`/element/${encodeURIComponent(id)}/displayed`);
        if (visible === true) return String(id);
      }
      if (Date.now() >= end) throw new Error('Appium selector must match exactly one visible enabled element before timeout.');
      await sleep(150); // Only selector lookup is retried, never click/fill.
    } while (true);
  }
  async tap(target: Record<string, any>): Promise<Record<string, any>> {
    if (target.x !== undefined || target.y !== undefined) {
      this.point(target.x, target.y);
      await this.pointer([{ type: 'pointerMove', duration: 0, x: target.x, y: target.y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }]);
    } else {
      const id = await this.element(target);
      await this.command(`/element/${encodeURIComponent(id)}/click`, 'POST', {});
    }
    return { ok: true, source: 'appium_uiautomator2', appium: this.evidence() };
  }
  async input(target: Record<string, any>, value: string, clear: boolean): Promise<Record<string, any>> {
    const id = await this.element(target);
    if (clear) await this.command(`/element/${encodeURIComponent(id)}/clear`, 'POST', {});
    await this.command(`/element/${encodeURIComponent(id)}/value`, 'POST', { text: value, value: Array.from(value) });
    return { ok: true, source: 'appium_uiautomator2', cleared: clear, appium: this.evidence() };
  }
  private point(x: unknown, y: unknown): void { if (![x, y].every(v => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 100000)) throw new Error('Appium coordinates must be non-negative integers.'); }
  private async pointer(actions: unknown[]): Promise<void> {
    let error: unknown;
    try { await this.command('/actions', 'POST', { actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }] }); }
    catch (e) { error = e; }
    // Release even after a partial failed gesture; do not repeat the gesture.
    try { await this.command('/actions', 'DELETE'); } catch (e) { error ||= e; }
    if (error) throw error;
  }
  async swipe(input: Record<string, any>): Promise<Record<string, any>> {
    this.point(input.x1, input.y1); this.point(input.x2, input.y2);
    const duration = input.duration_ms ?? 450;
    if (!Number.isInteger(duration) || duration < 0 || duration > 30000) throw new Error('Invalid Appium swipe duration.');
    await this.pointer([{ type: 'pointerMove', duration: 0, x: input.x1, y: input.y1 }, { type: 'pointerDown', button: 0 }, { type: 'pointerMove', duration, x: input.x2, y: input.y2 }, { type: 'pointerUp', button: 0 }]);
    return { ok: true, source: 'appium_uiautomator2', appium: this.evidence() };
  }
  async back(): Promise<Record<string, any>> { await this.command('/back', 'POST', {}); return { ok: true, source: 'appium_uiautomator2', appium: this.evidence() }; }
  async close(): Promise<Record<string, any>> {
    const entry = sessions.get(this.key);
    if (!entry) return { ok: true, skipped: true };
    try {
      await this.request(`/session/${encodeURIComponent(entry.evidence.session_id)}`, 'DELETE');
      sessions.delete(this.key);
      return { ok: true, appium_session_id: entry.evidence.session_id };
    } catch (error) {
      if (error instanceof AppiumCommandError && error.code === 'invalid session id') { sessions.delete(this.key); return { ok: true, already_absent: true }; }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
