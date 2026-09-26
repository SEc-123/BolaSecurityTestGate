import { NativeAppiumClient } from './appium-client.js';
import { runCommand, runCommandBinary, splitCommandLine, startBackgroundCommand } from './command-runner.js';
import { isPngScreenshot, matchesUiNode, isOfflineProfile } from './mobile-target-contract.js';
import type { MobileLabProfile, MobileObservation, MobileUiNode } from './mobile-types.js';

const appiumSessions = new Map<string, string>();

function adb(profile: MobileLabProfile): { command: string; baseArgs: string[] } {
  const command = String(profile.config_json?.adb_path || 'adb');
  const serial = String(profile.adb_serial || '').trim();
  return { command, baseArgs: serial ? ['-s', serial] : [] };
}

function appiumBase(profile: MobileLabProfile): string {
  return String(profile.appium_server_url || profile.config_json?.appium_server_url || profile.config_json?.simulator_url || '').replace(/\/$/, '');
}

function appPackage(profile: MobileLabProfile): string {
  return String(profile.config_json?.app_package || process.env.BSTG_MOBILE_APP_PACKAGE || process.env.BSTG_MOBILE_ALLOWED_PACKAGE || '');
}

function appActivity(profile: MobileLabProfile): string {
  return String(profile.config_json?.app_activity || process.env.BSTG_MOBILE_APP_ACTIVITY || '');
}

export function isOfflineSimulator(profile: MobileLabProfile): boolean {
  return isOfflineProfile(profile);
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 10000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (body?.value?.error) throw new Error(`Appium ${body.value.error}: ${body.value.message || 'command failed'}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

export function parseBounds(value?: string): [number, number, number, number] | undefined {
  const match = String(value || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attr(nodeXml: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
  const match = nodeXml.match(re);
  return match ? xmlUnescape(match[1]) : undefined;
}

export function parseUiAutomatorXml(xml: string): MobileUiNode[] {
  const nodes: MobileUiNode[] = [];
  const matches = String(xml || '').matchAll(/<(?:node|[A-Za-z_][\w.:-]*)\b[^>]*>/g);
  let index = 0;
  for (const match of matches) {
    const item = match[0];
    const className = attr(item, 'class');
    const text = attr(item, 'password') === 'true' ? '[redacted]' : attr(item, 'text');
    const resourceId = attr(item, 'resource-id');
    const contentDesc = attr(item, 'content-desc');
    const bounds = parseBounds(attr(item, 'bounds'));
    const clickable = attr(item, 'clickable') === 'true';
    const enabled = attr(item, 'enabled') !== 'false';
    const password = attr(item, 'password') === 'true';
    const input = /EditText|AutoCompleteTextView/i.test(String(className || '')) || Boolean(password);
    const useful = Boolean(text || resourceId || contentDesc || clickable || input);
    if (!useful) continue;
    nodes.push({ index: index++, className, text, resourceId, contentDesc, bounds, clickable, enabled, password, input });
  }
  return nodes.slice(0, 500);
}

export function findNode(nodes: MobileUiNode[], target: Record<string, any>): MobileUiNode | undefined {
  const hasSelector = ['resourceId','resource_id','text','contentDesc','content_desc','index'].some(key => target[key] !== undefined);
  if (!hasSelector) throw new Error('An explicit UI target is required; implicit first-clickable selection is disabled.');
  const matches = nodes.filter(node => node.enabled !== false && matchesUiNode(node, target));
  if (matches.length > 1) throw new Error('UI target is ambiguous; use a unique resourceId or refine the selector.');
  return matches[0];
}

export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('NUL is not permitted in an ADB argument.');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function validatePoint(x: unknown, y: unknown): { x: number; y: number } {
  if (![x, y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000)) throw new Error('Coordinates must be finite non-negative numbers.');
  return { x: Math.round(x as number), y: Math.round(y as number) };
}

export function center(bounds?: [number, number, number, number]): { x: number; y: number } | undefined {
  if (!bounds) return undefined;
  return { x: Math.round((bounds[0] + bounds[2]) / 2), y: Math.round((bounds[1] + bounds[3]) / 2) };
}

function normalizeSimulatorObservation(profile: MobileLabProfile, body: any): MobileObservation | null {
  const data = body?.data || body;
  if (!data) return null;
  const screen = data.screen || {};
  const tree = Array.isArray(data.ui_tree) ? data.ui_tree : [];
  const uiTree: MobileUiNode[] = tree.map((node: any, index: number) => ({
    index: Number(node.index ?? index),
    className: node.className || node.class || node.class_name,
    text: node.text,
    resourceId: node.resourceId || node.resource_id,
    contentDesc: node.contentDesc || node.content_desc || node.contentDescription,
    bounds: Array.isArray(node.bounds) ? node.bounds as [number, number, number, number] : parseBounds(node.bounds),
    clickable: Boolean(node.clickable),
    enabled: node.enabled !== false,
    password: Boolean(node.password),
    input: Boolean(node.input) || /EditText/i.test(String(node.className || node.class || '')),
  }));
  return {
    session_id: '',
    device_id: profile.adb_serial || profile.device_name,
    package: screen.package || data.package || appPackage(profile),
    activity: screen.activity || data.activity || appActivity(profile),
    screenshot_base64: screen.screenshot_base64 || data.screenshot_base64,
    ui_tree: uiTree,
    suggested_actions: Array.isArray(data.suggested_actions) ? data.suggested_actions : [],
  };
}

export class AndroidDeviceManager {
  constructor(private readonly profile: MobileLabProfile) {}

  private nativeAppium(): NativeAppiumClient | undefined {
    if (isOfflineSimulator(this.profile)) return undefined;
    if (appiumBase(this.profile) || this.profile.config_json?.strict_real_e2e !== false) return new NativeAppiumClient(this.profile);
    return undefined;
  }
  async appiumHealth(): Promise<Record<string, any>> {
    if (isOfflineSimulator(this.profile)) return { ok: true, simulated: true };
    return new NativeAppiumClient(this.profile).health();
  }
  appiumEvidence() { return this.nativeAppium()?.evidence(); }
  appiumTrace() { return this.nativeAppium()?.trace() || []; }


  async runAdb(args: string[], timeoutMs = 30000) {
    const cfg = adb(this.profile);
    // ADB forwards shell arguments to the device shell. spawn(shell=false) alone
    // does NOT escape that second shell. Quote each token at the remote boundary.
    const safeArgs = args[0] === 'shell' && !isOfflineSimulator(this.profile)
      ? ['shell', args.slice(1).map(shellQuote).join(' ')] : args;
    return runCommand(cfg.command, [...cfg.baseArgs, ...safeArgs], { timeoutMs });
  }

  async startEmulatorIfConfigured(): Promise<Record<string, any>> {
    const commandLine = String(this.profile.config_json?.emulator_start_command || '').trim();
    if (!commandLine) return { started: false, reason: 'No emulator_start_command configured; assuming external/prestarted emulator or offline simulator.' };
    const parsed = splitCommandLine(commandLine);
    if (this.profile.runtime_type === 'local_avd' && this.profile.config_json?.skip_emulator_acceleration_check !== true && this.profile.config_json?.allow_software_emulation !== true) {
      const emulatorBinary = String(this.profile.config_json?.emulator_path || parsed.command).trim();
      const acceleration = await runCommand(emulatorBinary, ['-accel-check'], { timeoutMs: 15000 }).catch(error => ({ ok: false, stdout: '', stderr: String(error?.message || error) } as any));
      const diagnostics = `${acceleration.stdout || ''}\n${acceleration.stderr || ''}`.trim();
      if (!acceleration.ok || /not found|disabled|requires hardware acceleration|cannot use.*acceleration/i.test(diagnostics)) {
        return { started: false, command: parsed.command, args: parsed.args, reason: 'Local Android Emulator acceleration preflight failed. Provide a compatible software-emulated AVD only when it actually boots, or run this profile on an authorized host with KVM.', acceleration_check: diagnostics.slice(0, 4000) };
      }
    }
    const result = await startBackgroundCommand(parsed.command, parsed.args, { startupGraceMs: Number(this.profile.config_json?.emulator_start_grace_ms || 900) });
    return { started: result.ok, command: result.command, args: result.args, pid: result.pid, error: result.error };
  }

  async waitForDevice(timeoutMs = 90000): Promise<Record<string, any>> {
    const base = appiumBase(this.profile);
    if (base && isOfflineSimulator(this.profile)) {
      try {
        const status = await fetchJson(`${base}/status`, undefined, Math.min(timeoutMs, 10000));
        if (status?.value?.ready) return { ok: true, state: 'device', source: 'appium_or_simulator', status };
      } catch (error: any) {
        // fall back to adb below
      }
    }
    const start = Date.now();
    let last: any = null;
    while (Date.now() - start < timeoutMs) {
      const result = await this.runAdb(['get-state'], 8000);
      last = result;
      if (result.ok && result.stdout.trim() === 'device') {
        const boot = await this.runAdb(['shell', 'getprop', 'sys.boot_completed'], 8000);
        if (boot.ok && boot.stdout.trim() === '1') return { ok: true, state: 'device', boot_completed: true, waited_ms: Date.now() - start, source: 'adb' };
      }
      await delay(1500);
    }
    return { ok: false, waited_ms: Date.now() - start, last_stdout: last?.stdout, last_stderr: last?.stderr };
  }

  async deviceCapabilities(): Promise<{ ok: boolean; api_level?: number; abis: string[]; error?: string }> {
    const sdk = await this.runAdb(['shell', 'getprop', 'ro.build.version.sdk'], 10000);
    const abi = await this.runAdb(['shell', 'getprop', 'ro.product.cpu.abilist'], 10000);
    const apiLevel = Number(sdk.stdout.trim());
    const abis = abi.stdout.trim().split(',').map(item => item.trim()).filter(Boolean);
    if (!sdk.ok || !abi.ok || !Number.isInteger(apiLevel) || apiLevel < 16 || !abis.length) {
      return { ok: false, abis, error: 'Cannot verify device Android API level and supported ABIs from ADB.' };
    }
    return { ok: true, api_level: apiLevel, abis };
  }

  async configureProxy(): Promise<Record<string, any>> {
    if (!this.profile.proxy_host || !this.profile.proxy_port || this.profile.proxy_type === 'none') return { configured: false, reason: 'proxy disabled or incomplete' };
    if (isOfflineSimulator(this.profile)) return { configured: true, proxy: `${this.profile.proxy_host}:${this.profile.proxy_port}`, source: 'offline_simulator_preconfigured' };
    const previous = await this.runAdb(['shell', 'settings', 'get', 'global', 'http_proxy'], 10000);
    if (!previous.ok) return { configured: false, reason: 'Cannot read previous Android proxy; refusing to overwrite unknown state.' };
    const host = String(this.profile.proxy_host).trim();
    const port = Number(this.profile.proxy_port);
    const useAdbReverse = this.profile.config_json?.proxy_use_adb_reverse === true || this.profile.config_json?.proxy_use_adb_reverse === 'true' || /^(127\.0\.0\.1|localhost|::1)$/i.test(host);
    const deviceHost = String(this.profile.config_json?.proxy_device_host || (useAdbReverse ? '127.0.0.1' : host)).trim();
    let reverse: Record<string, any> | undefined;
    if (useAdbReverse) {
      const mappings = await this.runAdb(['reverse', '--list'], 10000);
      if (!mappings.ok || mappings.stdout.split(/\r?\n/).some(line => line.split(/\s+/).includes(`tcp:${port}`))) return { configured: false, reason: 'Cannot own ADB reverse port: existing mapping or unreadable reverse table.' };
      const result = await this.runAdb(['reverse', `tcp:${port}`, `tcp:${port}`], 20000);
      reverse = { configured: result.ok, local: `tcp:${port}`, remote: `tcp:${port}`, stdout: result.stdout, stderr: result.stderr };
      if (!result.ok) return { configured: false, proxy: `${deviceHost}:${port}`, reverse, reason: `ADB reverse failed: ${result.stderr || result.stdout}` };
    }
    const proxy = `${deviceHost}:${port}`;
    const result = await this.runAdb(['shell', 'settings', 'put', 'global', 'http_proxy', proxy], 15000);
    let readback: any;
    let verified = false;
    // SettingsProvider can acknowledge the write before its shell read path is
    // observable on a freshly booted AVD. Retry the read only; never infer
    // success from the write command alone.
    for (let attempt = 0; result.ok && attempt < 8 && !verified; attempt += 1) {
      readback = await this.runAdb(['shell', 'settings', 'get', 'global', 'http_proxy'], 10000);
      const observed = String(readback?.stdout || '').replace(/\\r/g, '').trim();
      verified = Boolean(readback?.ok && observed === proxy);
      if (!verified) await delay(500);
    }
    return { configured: verified, changed: result.ok, previous_proxy: previous.stdout.trim(), proxy, reverse, stdout: result.stdout, stderr: result.stderr, readback: readback?.stdout, reason: verified ? undefined : `Android proxy readback did not match ${proxy}.` };
  }

  async clearProxy(previousProxy?: string, removeOwnedReverse = false): Promise<Record<string, any>> {
    if (isOfflineSimulator(this.profile)) return { cleared: true, source: 'offline_simulator_noop' };
    if (this.profile.proxy_type === 'none') return { cleared: true, skipped: true };
    const previous = previousProxy && !['null', ':0'].includes(previousProxy) ? previousProxy : '';
    const result = await this.runAdb(previous ? ['shell','settings','put','global','http_proxy', previous] : ['shell', 'settings', 'delete', 'global', 'http_proxy'], 15000);
    const readback = await this.runAdb(['shell','settings','get','global','http_proxy'], 10000);
    const restored = readback.ok && (previous ? readback.stdout.trim() === previous : ['', 'null', ':0'].includes(readback.stdout.trim()));
    const host = String(this.profile.proxy_host || '').trim();
    const useAdbReverse = this.profile.config_json?.proxy_use_adb_reverse === true || this.profile.config_json?.proxy_use_adb_reverse === 'true' || /^(127\.0\.0\.1|localhost|::1)$/i.test(host);
    let reverse: { ok: boolean; stdout: string; stderr: string } | undefined;
    if (removeOwnedReverse && useAdbReverse && this.profile.proxy_port) {
      const port = `tcp:${Number(this.profile.proxy_port)}`;
      const mappings = await this.runAdb(['reverse', '--list'], 10000);
      // A cleanup retry must accept an already-removed owned mapping, but must
      // not delete a replacement mapping installed by a different operator.
      const mapping = mappings.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[parts.length - 2] === port);
      if (!mappings.ok) reverse = { ok: false, stdout: '', stderr: 'Cannot verify the reverse mapping before cleanup.' };
      else if (!mapping) reverse = { ok: true, stdout: 'Owned reverse mapping already absent.', stderr: '' };
      else if (mapping[mapping.length - 1] !== port) reverse = { ok: false, stdout: '', stderr: 'Reverse mapping changed ownership; refusing to remove it.' };
      else reverse = await this.runAdb(['reverse', '--remove', port], 15000);
    }
    return { cleared: result.ok && restored && (!reverse || reverse.ok), restored_proxy: previous || null, stdout: result.stdout, stderr: result.stderr, reverse: reverse ? { ok: reverse.ok, stdout: reverse.stdout, stderr: reverse.stderr } : undefined };
  }

  async listInstalledPackages(): Promise<string[]> {
    if (isOfflineSimulator(this.profile)) return [appPackage(this.profile)];
    const result = await this.runAdb(['shell', 'pm', 'list', 'packages'], 30000);
    if (!result.ok) return [];
    return result.stdout.split(/\r?\n/).map(line => line.replace(/^package:/, '').trim()).filter(Boolean);
  }

  async installApk(apkPath: string, expectedPackage?: string): Promise<Record<string, any>> {
    if (isOfflineSimulator(this.profile)) return { ok: true, apk_path: apkPath, package: appPackage(this.profile), source: 'offline_simulator_noop' };
    const before = await this.listInstalledPackages().catch(() => []);
    const beforeSet = new Set(before);
    const installTimeout = Number(this.profile.config_json?.apk_install_timeout_ms || 120000);
    const allowCleanReinstall = this.profile.config_json?.allow_clean_reinstall === true || this.profile.config_json?.allow_clean_reinstall === 'true';
    const packageForReinstall = String(expectedPackage || this.profile.config_json?.app_package || '').trim();
    let clearData: Record<string, any> | undefined;
    if (allowCleanReinstall && (this.profile.config_json?.clear_app_data_before_install === true || this.profile.config_json?.clear_app_data_before_install === 'true') && packageForReinstall && beforeSet.has(packageForReinstall)) {
      const cleared = await this.runAdb(['shell', 'pm', 'clear', packageForReinstall], installTimeout);
      clearData = { authorized: true, package: packageForReinstall, ok: cleared.ok, stdout: cleared.stdout, stderr: cleared.stderr };
    }
    let result = await this.runAdb(['install', '-r', apkPath], installTimeout);
    const installFailed = (candidate: any) => !candidate?.ok || /Failure \[/i.test(`${candidate?.stdout || ''}\n${candidate?.stderr || ''}`);
    let cleanReinstall: Record<string, any> | undefined;
    if (installFailed(result) && allowCleanReinstall && packageForReinstall && /UPDATE_INCOMPATIBLE|INSTALL_FAILED_VERSION_DOWNGRADE/i.test(`${result.stdout} ${result.stderr}`)) {
      const uninstall = await this.runAdb(['uninstall', packageForReinstall], installTimeout);
      if (uninstall.ok || /Unknown package|DELETE_FAILED_INTERNAL_ERROR/i.test(`${uninstall.stdout} ${uninstall.stderr}`)) {
        result = await this.runAdb(['install', '-r', apkPath], installTimeout);
      }
      cleanReinstall = { authorized: true, package: packageForReinstall, uninstall: { ok: uninstall.ok, stdout: uninstall.stdout, stderr: uninstall.stderr } };
    }
    const finalInstallOk = !installFailed(result);
    const after = finalInstallOk ? await this.listInstalledPackages().catch(() => []) : [];
    const newlyInstalled = after.find(pkg => !beforeSet.has(pkg));
    const configuredPackage = String(expectedPackage || this.profile.config_json?.app_package || '').trim();
    const resolvedPackage = configuredPackage || newlyInstalled || undefined;
    const packageVerified = Boolean(resolvedPackage && after.includes(resolvedPackage));
    return { ok: finalInstallOk && packageVerified, apk_path: apkPath, package: resolvedPackage, package_verified: packageVerified, clear_data: clearData, clean_reinstall: cleanReinstall, installed_packages_before: before.length, installed_packages_after: after.length, stdout: result.stdout.slice(0, 4000), stderr: result.stderr.slice(0, 4000) };
  }

  async launchApp(appPkg: string, activity?: string): Promise<Record<string, any>> {
    const native = this.nativeAppium(); if (native) return native.launch(appPkg, activity);
    const base = appiumBase(this.profile);
    if (base && isOfflineSimulator(this.profile)) {
      const session = await this.ensureAppiumSession(appPkg, activity);
      return { ok: true, package: appPkg, activity: activity || appActivity(this.profile), session_id: session, source: 'appium_or_simulator' };
    }
    const fullActivity = activity ? (activity.includes('/') ? activity : `${appPkg}/${activity}`) : undefined;
    const result = await this.runAdb(fullActivity
      ? ['shell', 'am', 'start', '-n', fullActivity]
      : ['shell', 'monkey', '-p', appPkg, '-c', 'android.intent.category.LAUNCHER', '1'], 30000);
    const commandOk = result.ok && !/Error type \d+|Error: Activity class|Exception occurred/i.test(`${result.stdout} ${result.stderr}`);
    const timeout = Math.min(30000, Math.max(500, Number(this.profile.config_json?.launch_timeout_ms || 15000)));
    const deadline = Date.now() + timeout;
    let focused: { package?: string; activity?: string; raw: string } = { raw: '' };
    // Cold starts can take longer than one frame. Retry observations only;
    // relaunching would erase state or execute the same intent twice.
    while (commandOk && Date.now() < deadline) {
      focused = await this.currentActivity().catch(() => ({ raw: '' }));
      if (focused.package === appPkg) break;
      await delay(300);
    }
    const packageVerified = focused.package === appPkg;
    return { ok: commandOk && packageVerified, package: appPkg, activity: fullActivity, focused_package: focused.package, focused_activity: focused.activity, package_verified: packageVerified, stdout: result.stdout, stderr: result.stderr };
  }

  async currentActivity(): Promise<{ package?: string; activity?: string; raw: string }> {
    const native = this.nativeAppium(); if (native) return native.currentActivity();
    const base = appiumBase(this.profile);
    if (base && isOfflineSimulator(this.profile)) {
      try {
        const observed = normalizeSimulatorObservation(this.profile, await fetchJson(`${base}/bstg/mobile/observe`, undefined, 10000));
        if (observed) return { package: observed.package, activity: observed.activity, raw: 'offline_simulator_observe' };
      } catch {}
    }
    const result = await this.runAdb(['shell', 'dumpsys', 'window', 'windows'], 15000);
    const raw = result.stdout || result.stderr || '';
    const match = raw.match(/mCurrentFocus=.*?\s([A-Za-z0-9_.]+)\/([^}\s]+)/) || raw.match(/mFocusedApp=.*?\s([A-Za-z0-9_.]+)\/([^}\s]+)/);
    return { package: match?.[1], activity: match?.[2], raw: raw.slice(0, 2000) };
  }

  async screenshotBase64(): Promise<string | undefined> {
    const native = this.nativeAppium(); if (native) { const image = await native.screenshot(); if (!isPngScreenshot(image)) throw new Error('Appium screenshot is not a valid PNG.'); return image; }
    const base = appiumBase(this.profile);
    if (base && isOfflineSimulator(this.profile)) {
      try {
        const observed = normalizeSimulatorObservation(this.profile, await fetchJson(`${base}/bstg/mobile/observe`, undefined, 10000));
        if (observed?.screenshot_base64) return observed.screenshot_base64;
      } catch {}
    }
    const cfg = adb(this.profile);
    const result = await runCommandBinary(cfg.command, [...cfg.baseArgs, 'exec-out', 'screencap', '-p'], { timeoutMs: 30000 });
    if (!result.ok || !isPngScreenshot(result.buffer.toString('base64'))) return undefined;
    return result.buffer.toString('base64');
  }

  async dumpUiTree(): Promise<MobileUiNode[]> {
    const native = this.nativeAppium(); if (native) return parseUiAutomatorXml(await native.source());
    const base = appiumBase(this.profile);
    if (base && isOfflineSimulator(this.profile)) {
      try {
        const observed = normalizeSimulatorObservation(this.profile, await fetchJson(`${base}/bstg/mobile/observe`, undefined, 10000));
        if (observed) return observed.ui_tree;
      } catch {}
    }
    const file = `/data/local/tmp/bstg-window-${String(this.profile.config_json?.mobile_session_id || 'device').replace(/[^a-zA-Z0-9-]/g, '')}.xml`;
    const removed = await this.runAdb(['shell', 'rm', '-f', file], 10000);
    if (!removed.ok) throw new Error('Unable to remove stale UI hierarchy before observation.');
    const dump = await this.runAdb(['shell', 'uiautomator', 'dump', file], 30000);
    if (!dump.ok || /ERROR|could not|exception/i.test(`${dump.stdout} ${dump.stderr}`)) throw new Error('UIAutomator could not produce a fresh hierarchy.');
    const result = await this.runAdb(['shell', 'cat', file], 30000);
    if (!result.ok || !result.stdout.includes('<hierarchy')) throw new Error('Fresh UI hierarchy is unavailable.');
    return parseUiAutomatorXml(result.stdout);
  }

  suggestedActions(nodes: MobileUiNode[]): Array<Record<string, any>> {
    const actions: Array<Record<string, any>> = [];
    const inputs = nodes.filter(node => node.input && node.enabled).slice(0, 6);
    for (const node of inputs) actions.push({ action: 'input', target: { resourceId: node.resourceId, text: node.text, index: node.index }, confidence: node.resourceId ? 0.86 : 0.55 });
    const buttons = nodes.filter(node => node.clickable && node.enabled && node.bounds).slice(0, 12);
    for (const node of buttons) actions.push({ action: 'tap', target: { resourceId: node.resourceId, text: node.text, contentDesc: node.contentDesc, index: node.index }, confidence: node.text || node.resourceId ? 0.82 : 0.5 });
    return actions.slice(0, 18);
  }

  async observe(): Promise<MobileObservation> {
    const native = this.nativeAppium();
    if (native) {
      // Sequential WebDriver commands avoid racing the device instrumentation.
      const activity = await native.currentActivity();
      const screenshot = await this.screenshotBase64();
      const tree = await this.dumpUiTree();
      return { session_id: '', observed_at: new Date().toISOString(), device_id: this.profile.adb_serial,
        package: activity.package, activity: activity.activity, screenshot_base64: screenshot, ui_tree: tree,
        suggested_actions: this.suggestedActions(tree), health: { source: 'appium_uiautomator2', appium: native.evidence() } };
    }

    const base = appiumBase(this.profile);
    if (base && isOfflineSimulator(this.profile)) {
      try {
        const observed = normalizeSimulatorObservation(this.profile, await fetchJson(`${base}/bstg/mobile/observe`, undefined, 10000));
        if (observed) return observed;
      } catch {}
    }
    const [activity, screenshot, uiTree] = await Promise.all([
      this.currentActivity().catch(error => ({ package: undefined, activity: undefined, raw: String(error?.message || error) })),
      this.screenshotBase64().catch(() => undefined),
      this.dumpUiTree().catch(() => []),
    ]);
    return {
      session_id: '',
      observed_at: new Date().toISOString(),
      device_id: this.profile.adb_serial || this.profile.device_name,
      package: activity.package,
      activity: activity.activity,
      screenshot_base64: screenshot,
      ui_tree: uiTree,
      suggested_actions: this.suggestedActions(uiTree),
    };
  }

  private async ensureAppiumSession(appPkg?: string, activity?: string): Promise<string> {
    const base = appiumBase(this.profile);
    if (!base) throw new Error('appium_server_url is not configured');
    const key = `${base}|${this.profile.adb_serial || ''}|${this.profile.config_json?.mobile_session_id || ''}|${appPkg || appPackage(this.profile)}`;
    const cached = appiumSessions.get(key);
    if (cached) return cached;
    const created = await fetchJson(`${base}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilities: {
          alwaysMatch: {
            platformName: 'Android',
            'appium:automationName': 'UiAutomator2',
            'appium:udid': this.profile.adb_serial,
            'appium:noReset': true,
            'appium:autoLaunch': isOfflineSimulator(this.profile),
            'appium:appPackage': appPkg || appPackage(this.profile),
            'appium:appActivity': activity || appActivity(this.profile),
          },
        },
      }),
    }, 15000);
    const sessionId = created?.value?.sessionId || created?.sessionId;
    if (!sessionId) throw new Error(`Appium did not return a session id: ${JSON.stringify(created).slice(0, 500)}`);
    appiumSessions.set(key, sessionId);
    return sessionId;
  }

  private async findAppiumElement(target: Record<string, any>): Promise<{ sessionId: string; elementId: string }> {
    const sessionId = await this.ensureAppiumSession();
    const literal = (text: string) => !text.includes("'") ? `'${text}'` : !text.includes('"') ? `"${text}"` : `concat(${text.split("'").map(part => `'${part}'`).join(', "\'", ')})`;
    const conditions: string[] = [];
    const resourceId = target.resourceId || target.resource_id;
    if (resourceId) conditions.push(`@resource-id=${literal(String(resourceId).includes('/') ? String(resourceId) : `${appPackage(this.profile)}:id/${resourceId}`)}`);
    const desc = target.contentDesc || target.content_desc;
    if (desc) conditions.push(`@content-desc=${literal(String(desc))}`);
    if (target.text) conditions.push(`@text=${literal(String(target.text))}`);
    if (!conditions.length) throw new Error('An explicit Appium selector is required.');
    conditions.push('@enabled="true"');
    const using = 'xpath';
    const value = `//*[${conditions.join(' and ')}]`;
    const offline = isOfflineSimulator(this.profile);
    const found = await fetchJson(`${appiumBase(this.profile)}/session/${sessionId}/${offline ? 'element' : 'elements'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ using, value }),
    }, 10000);
    const elements = offline ? [found?.value] : found?.value;
    if (!Array.isArray(elements) || elements.length !== 1) throw new Error('Appium selector must match exactly one enabled element.');
    const elementId = elements[0]?.['element-6066-11e4-a52e-4f735466cecf'] || elements[0]?.ELEMENT;
    if (!elementId) throw new Error('Appium did not return an element identifier.');
    return { sessionId, elementId };
  }

  async tap(target: Record<string, any>): Promise<Record<string, any>> {
    const native = this.nativeAppium(); if (native) return native.tap(target);
    if (target.x !== undefined || target.y !== undefined) validatePoint(target.x, target.y);
    const base = appiumBase(this.profile);
    if (base && isOfflineSimulator(this.profile)) {
      if (target.x !== undefined && target.y !== undefined) {
        const sessionId = await this.ensureAppiumSession();
        const result = await fetchJson(`${base}/session/${sessionId}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: [{ type: 'pointerMove', duration: 0, x: Number(target.x), y: Number(target.y) }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] }) }, 10000);
        return { ok: true, target, result, source: 'appium_or_simulator' };
      }
      const { sessionId, elementId } = await this.findAppiumElement(target);
      const result = await fetchJson(`${base}/session/${sessionId}/element/${elementId}/click`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 10000);
      return { ok: true, target, element_id: elementId, result, source: 'appium_or_simulator' };
    }
    const nodes = await this.dumpUiTree();
    const node = target.x !== undefined && target.y !== undefined ? undefined : findNode(nodes, target);
    const point = target.x !== undefined && target.y !== undefined ? { x: Number(target.x), y: Number(target.y) } : center(node?.bounds);
    if (!point) throw new Error(`Tap target not found: ${JSON.stringify(target)}`);
    const result = await this.runAdb(['shell', 'input', 'tap', String(point.x), String(point.y)], 15000);
    await delay(Number(this.profile.config_json?.action_delay_ms || 700));
    return { ok: result.ok, target, point, matched_node: node, stdout: result.stdout, stderr: result.stderr };
  }

  async inputText(target: Record<string, any>, value: string, clear = false): Promise<Record<string, any>> {
    const native = this.nativeAppium(); if (native) return native.input(target, value, clear);
    const base = appiumBase(this.profile);
    if (base) {
      const { sessionId, elementId } = await this.findAppiumElement(target);
      if (clear) await fetchJson(`${base}/session/${sessionId}/element/${elementId}/clear`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await fetchJson(`${base}/session/${sessionId}/element/${elementId}/value`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: value, value: Array.from(value) }) });
      return { ok: true, target, element_id: elementId, source: isOfflineSimulator(this.profile) ? 'offline_simulator' : 'appium_uiautomator2', cleared: clear };
    }
    if (clear) throw new Error('fill requires Appium so existing text can be cleared reliably; input/type append text.');
    if (/[^\x20-\x7e]/.test(value) || value.includes('%s')) throw new Error('This text requires Appium Unicode input; ADB input text cannot preserve it losslessly.');
    const tapResult = await this.tap(target);
    if (tapResult.ok !== true) return { ok: false, error: 'Input focus failed.' };
    const encoded = value.replace(/ /g, '%s');
    const result = await this.runAdb(['shell', 'input', 'text', encoded], 15000);
    await delay(Number(this.profile.config_json?.action_delay_ms ?? 700));
    return { ok: result.ok, target, tapped: tapResult.point, error: result.ok ? undefined : 'ADB text input failed.' };
  }

  async closeAppiumSessions(): Promise<Record<string, any>> {
    const native = this.nativeAppium(); if (native) return native.close();
    const prefix = `${appiumBase(this.profile)}|${this.profile.adb_serial || ''}|${this.profile.config_json?.mobile_session_id || ''}|`;
    const errors: string[] = [];
    for (const [key, id] of appiumSessions) {
      if (!key.startsWith(prefix)) continue;
      try { await fetchJson(`${appiumBase(this.profile)}/session/${id}`, { method: 'DELETE' }); appiumSessions.delete(key); }
      catch (error: any) { errors.push(error.message); }
    }
    return { ok: errors.length === 0, errors };
  }

  async swipe(input: Record<string, any>): Promise<Record<string, any>> {
    const native = this.nativeAppium(); if (native) return native.swipe(input);
    validatePoint(input.x1, input.y1); validatePoint(input.x2, input.y2);
    if (input.duration_ms !== undefined && (!Number.isFinite(input.duration_ms) || input.duration_ms < 0 || input.duration_ms > 30000)) throw new Error('Invalid swipe duration.');
    const base = appiumBase(this.profile);
    if (base && isOfflineSimulator(this.profile)) {
      const sessionId = await this.ensureAppiumSession();
      const result = await fetchJson(`${base}/session/${sessionId}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: [{ type: 'pointerMove', duration: 0, x: input.x1, y: input.y1 }, { type: 'pointerDown', button: 0 }, { type: 'pointerMove', duration: input.duration_ms ?? 450, x: input.x2, y: input.y2 }, { type: 'pointerUp', button: 0 }] }] }) }, 10000);
      return { ok: true, result, input, source: 'appium_or_simulator' };
    }
    const args = ['shell', 'input', 'swipe', String(input.x1 ?? 500), String(input.y1 ?? 1400), String(input.x2 ?? 500), String(input.y2 ?? 400), String(input.duration_ms ?? 450)];
    const result = await this.runAdb(args, 15000);
    await delay(Number(this.profile.config_json?.action_delay_ms || 700));
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr, input };
  }

  async back(): Promise<Record<string, any>> {
    const native = this.nativeAppium(); if (native) return native.back();
    const base = appiumBase(this.profile);
    if (base && isOfflineSimulator(this.profile)) return { ok: true, source: 'offline_simulator_noop', keyevent: 'back' };
    const result = await this.runAdb(['shell', 'input', 'keyevent', '4'], 10000);
    await delay(Number(this.profile.config_json?.action_delay_ms || 700));
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
  }
}
