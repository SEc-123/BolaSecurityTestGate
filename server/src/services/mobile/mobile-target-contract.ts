import { validateNetworkExpectations, tlsCompletenessFailure } from './mobile-network-assertions.js';
import type { MobileLabProfile, MobileObservation, MobileSession, MobileUiNode, NormalizedHttpFlow } from './mobile-types.js';

export interface MobileTargetContract {
  strict_real_e2e: boolean;
  require_apk_install: boolean;
  require_explicit_app_identity: boolean;
  require_explicit_tls_evidence: boolean;
  require_capture_app_identity: boolean;
  require_flow_steps: boolean;
  require_flow_assertions: boolean;
  require_apk_attestation: boolean;
  require_proxy_certificate: boolean;
  minimum_decrypted_flows: number;
  minimum_workflow_drafts: number;
}

export function asPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function isOfflineProfile(profile: MobileLabProfile): boolean {
  const cfg = profile.config_json || {};
  return cfg.offline_simulator === true || cfg.offline_simulator === 'true' || profile.id === 'offline-simulator-v0.2.0';
}

export function resolveTargetContract(profile: MobileLabProfile): MobileTargetContract {
  const cfg = profile.config_json || {};
  const offline = isOfflineProfile(profile);
  const strict = !offline && cfg.strict_real_e2e !== false;
  return {
    strict_real_e2e: strict,
    require_apk_install: strict || cfg.require_apk_install === true,
    require_explicit_app_identity: strict || cfg.require_explicit_app_identity === true,
    require_explicit_tls_evidence: strict || cfg.require_explicit_tls_evidence === true,
    require_capture_app_identity: strict || cfg.require_capture_app_identity === true,
    require_flow_steps: strict || cfg.require_flow_steps === true,
    require_flow_assertions: strict || cfg.require_flow_assertions === true,
    require_apk_attestation: strict || cfg.require_apk_attestation === true,
    // A real App can only supply an HTTPS evidence chain when the intercepting
    // CA is actually trusted by the device.  Exploration does not change that
    // fact: it is an acquisition strategy, not a plaintext exception.
    require_proxy_certificate: strict || cfg.require_proxy_certificate === true,
    minimum_decrypted_flows: asPositiveInt(cfg.minimum_decrypted_flows, 1),
    minimum_workflow_drafts: strict ? asPositiveInt(cfg.minimum_workflow_drafts, 1) : Math.max(0, Number(cfg.minimum_workflow_drafts) || 0),
  };
}

export function explicitAppIdentity(profile: MobileLabProfile, session?: MobileSession): string {
  return String(session?.app_package || profile.config_json?.app_package || '').trim();
}

export function validateTargetPrerequisites(profile: MobileLabProfile, session: MobileSession, phase: 'manifest' | 'prepare' | 'capture' = 'prepare'): string[] {
  const contract = resolveTargetContract(profile);
  const errors: string[] = [];
  const config = profile.config_json || {};
  const offline = isOfflineProfile(profile);
  // A simulator may exercise fixture semantics, but it is never evidence of a
  // device assessment.  Every non-simulated Android path is HTTPS-only,
  // including bounded automatic exploration.
  if (!offline && config.capture_http_only === true) {
    errors.push('Android execution requires decrypted HTTPS capture; capture_http_only is only permitted for the explicitly simulated offline profile.');
  }
  const origin = String(config.capture_origin || '').trim();
  if (!offline && origin) {
    try {
      if (new URL(origin).protocol !== 'https:') errors.push('Android execution requires an HTTPS capture_origin; plaintext HTTP targets cannot enter the device evidence pipeline.');
    } catch {
      errors.push('Android execution requires a valid HTTPS capture_origin.');
    }
  }
  if (!contract.strict_real_e2e) return errors;
  if (contract.require_explicit_app_identity && !explicitAppIdentity(profile, session)) {
    errors.push('Real Android E2E requires explicit app_package in the target manifest/profile or uploaded APK metadata.');
  }
  if (contract.require_apk_install && !String(session.apk_path || '').trim()) {
    errors.push('Real Android E2E requires apk_path so installation can be evidenced; preinstalled-App assumptions are not accepted.');
  }
  if (contract.require_apk_attestation) {
    if (!String(session.apk_source || '').trim()) errors.push('Real Android E2E requires an explicit apk_source; Google Play or preinstalled-App assumptions are not accepted.');
    if (!/^[a-f0-9]{64}$/i.test(String(session.apk_sha256 || '').trim())) errors.push('Real Android E2E requires a verified 64-character apk_sha256.');
    if (!/^[a-f0-9]{64}$/i.test(String(session.apk_signer_sha256 || '').replace(/:/g, ''))) errors.push('Real Android E2E requires APK signer SHA-256 evidence from apksigner.');
    if (!String(session.apk_package_name || '').trim()) errors.push('Real Android E2E requires package metadata from aapt.');
    if (session.app_package && session.apk_package_name && session.app_package !== session.apk_package_name) errors.push(`APK package metadata mismatch: session=${session.app_package}, APK=${session.apk_package_name}.`);
    if (session.app_activity && session.apk_launch_activity && normalizeActivity(session.app_package || '', session.app_activity) !== normalizeActivity(session.apk_package_name || '', session.apk_launch_activity)) errors.push(`APK launch activity mismatch: session=${session.app_activity}, APK=${session.apk_launch_activity}.`);
    if (!session.apk_launch_activity || !session.app_activity) errors.push('Real Android E2E requires an attested launch activity.');
    const deviceAbis = Array.isArray(profile.config_json?.device_abis) ? profile.config_json.device_abis.map((value: unknown) => String(value).trim()).filter(Boolean) : [];
    const apkAbis = Array.isArray(session.apk_native_abis) ? session.apk_native_abis.map(value => String(value).trim()).filter(Boolean) : [];
    // Java/Kotlin-only APKs have no native libraries and are ABI-independent.
    if (deviceAbis.length && apkAbis.length && !apkAbis.some(abi => deviceAbis.includes(abi))) errors.push(`APK native ABI is incompatible with the configured device: APK=${apkAbis.join(', ')}, device=${deviceAbis.join(', ')}.`);
  }
  if (phase !== 'manifest' && contract.require_proxy_certificate && profile.proxy_type !== 'none' && session.certificate_evidence?.install_verified !== true) {
    errors.push('Real Android E2E requires verified proxy CA installation/trust evidence before capture import.');
  }
  if (!String(session.device_id || profile.adb_serial || '').trim()) errors.push('Real Android E2E requires an explicit adb_serial (device_name is a display label, not an ADB selector).');
  if (profile.proxy_type !== 'none' && (!profile.proxy_host || !profile.proxy_port)) errors.push('Real Android E2E requires an explicit proxy host and port.');
  if (!String(profile.appium_server_url || profile.config_json?.appium_server_url || '').trim()) errors.push('Strict App tests require appium_server_url; ADB-only UI actions are not Appium acceptance.');
  if (profile.proxy_type === 'none') errors.push('Strict HTTPS App tests require a managed capture proxy.');
  if (profile.config_json?.allow_insecure_upstream === true) errors.push('Strict HTTPS tests cannot disable upstream certificate verification.');
  if (phase === 'capture') {
    if (contract.require_apk_install && session.health_json?.apk_install?.ok !== true) errors.push('Capture import requires a successful, persisted APK installation.');
    if (session.health_json?.app_launch?.ok !== true) errors.push('Capture import requires a verified target launch.');
    if (profile.config_json?.acquisition_mode === 'explore') {
      const discovery = session.health_json?.discovery_run;
      if (!discovery?.ok || !discovery.id || discovery.driver !== 'appium_uiautomator2' || !discovery.matched_flow_ids?.length) errors.push('自动探索尚未获取可验证的设备业务流量。');
    } else {
    if (contract.require_flow_steps && session.health_json?.flow_run?.ok !== true) errors.push('Capture import requires a completed UI flow with passing assertions.');
    if (!session.health_json?.flow_run?.id || !session.health_json?.flow_run?.network_assertions_passed || session.health_json?.flow_run?.driver !== 'appium_uiautomator2') errors.push('Capture import requires an Appium test run with step-bound HTTPS assertions.');
    }
  }
  return errors;
}

export function validateObservation(profile: MobileLabProfile, session: MobileSession, observation: MobileObservation): string[] {
  const contract = resolveTargetContract(profile);
  if (!contract.strict_real_e2e) return [];
  const errors: string[] = [];
  const expectedPackage = explicitAppIdentity(profile, session);
  if (!isPngScreenshot(observation.screenshot_base64)) errors.push('Real Android E2E requires a fresh device screenshot artifact.');
  if (!observation.ui_tree?.length) errors.push('Real Android E2E requires a non-empty UIAutomator hierarchy.');
  if (expectedPackage && observation.package !== expectedPackage) errors.push(`Foreground package mismatch: expected ${expectedPackage}, observed ${observation.package || 'unknown'}.`);
  return errors;
}

export function isPngScreenshot(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    && bytes.length >= 57 && bytes.readUInt32BE(8) === 13 && bytes.includes(Buffer.from('IDAT'))
    && bytes.subarray(-12).equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]));
}

export function normalizeActivity(pkg: string, activity: string): string {
  const name = activity.includes('/') ? activity.split('/')[1] : activity;
  return name.startsWith('.') ? pkg + name : name.includes('.') ? name : `${pkg}.${name}`;
}

export function matchesUiNode(node: MobileUiNode, expected: Record<string, any>): boolean {
  const id = expected.resourceId || expected.resource_id;
  if (id && !(node.resourceId === id || (!String(id).includes('/') && node.resourceId?.split('/').pop() === id))) return false;
  const contains = expected.match === 'contains';
  const equal = (a: unknown, b: unknown) => contains ? String(a ?? '').includes(String(b)) : String(a ?? '') === String(b);
  if (expected.text !== undefined && !equal(node.text, expected.text)) return false;
  const desc = expected.contentDesc ?? expected.content_desc;
  if (desc !== undefined && !equal(node.contentDesc, desc)) return false;
  if (expected.enabled !== undefined && node.enabled !== expected.enabled) return false;
  if (expected.index !== undefined && node.index !== Number(expected.index)) return false;
  return Boolean(id || expected.text !== undefined || desc !== undefined || expected.index !== undefined);
}

const EXPECT_KEYS = new Set(['package', 'activity', 'min_ui_nodes', 'resourceId', 'resource_id', 'text', 'contentDesc', 'content_desc', 'enabled', 'match', 'absent']);
export function validateExpectationShape(expected: unknown): string | undefined {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return 'An expect object is required.';
  const obj = expected as Record<string, any>;
  if (Object.keys(obj).some(key => !EXPECT_KEYS.has(key))) return 'Unknown expectation field.';
  if (!['package', 'activity', 'min_ui_nodes', 'resourceId', 'resource_id', 'text', 'contentDesc', 'content_desc'].some(key => obj[key] !== undefined)) return 'Expectation is empty or has no observable assertion.';
  if (obj.min_ui_nodes !== undefined && (!Number.isInteger(obj.min_ui_nodes) || obj.min_ui_nodes < 1)) return 'min_ui_nodes must be a positive integer.';
  if (obj.match !== undefined && !['exact', 'contains'].includes(obj.match)) return 'match must be exact or contains.';
  for (const key of ['package', 'activity', 'resourceId', 'resource_id', 'text', 'contentDesc', 'content_desc']) {
    if (obj[key] !== undefined && (typeof obj[key] !== 'string' || !obj[key].length)) return `${key} must be a non-empty string.`;
  }
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') return 'enabled must be boolean.';
  if ((obj.absent !== undefined || obj.enabled !== undefined || obj.match !== undefined) && !['text','resourceId','resource_id','contentDesc','content_desc'].some(key => obj[key] !== undefined)) return 'Node modifiers require a node selector.';
  if (obj.absent !== undefined && typeof obj.absent !== 'boolean') return 'absent must be boolean.';
  return undefined;
}

export function validateStepExpectation(observation: MobileObservation | null | undefined, expected: Record<string, any> | undefined): string | undefined {
  if (!expected) return undefined;
  const invalid = validateExpectationShape(expected);
  if (invalid) return invalid;
  if (!observation) return 'Post-action device observation is missing.';
  if (expected.package && observation.package !== expected.package) return `Expected package ${expected.package}, observed ${observation.package || 'unknown'}.`;
  if (expected.activity && normalizeActivity(observation.package || '', observation.activity || '') !== normalizeActivity(expected.package || observation.package || '', expected.activity)) return 'Expected activity was not observed.';
  if (expected.min_ui_nodes !== undefined && observation.ui_tree.length < expected.min_ui_nodes) return `Expected at least ${expected.min_ui_nodes} UI nodes, observed ${observation.ui_tree.length}.`;
  const nodeExpected = ['text', 'resourceId', 'resource_id', 'contentDesc', 'content_desc'].some(key => expected[key] !== undefined);
  if (nodeExpected) {
    const found = observation.ui_tree.some(node => matchesUiNode(node, expected));
    if (expected.absent === true ? found : !found) return 'Expected UI state was not observed after action.';
  }
  return undefined;
}

export function validateFlowSteps(steps: unknown, strict = true): string[] {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 200) return ['A flow requires 1–200 configured actions; an empty flow is not success.'];
  const errors: string[] = [];
  if (strict && !steps.some(step => step && String(step.action || step.type).toLowerCase() !== 'wait')) errors.push('A wait-only flow is not a business flow.');
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) { errors.push(`Step ${index + 1}: invalid action.`); return; }
    const type = String(step.action || step.type || '').toLowerCase();
    if (!['tap', 'click', 'input', 'type', 'fill', 'swipe', 'back', 'wait'].includes(type)) errors.push(`Step ${index + 1}: unsupported action ${type}.`);
    if ((strict && type !== 'wait') || step.expect !== undefined) {
      const error = validateExpectationShape(step.expect);
      if (error) errors.push(`Step ${index + 1}: ${error}`);
    }
    if (step.expect_network !== undefined) errors.push(...validateNetworkExpectations(step.expect_network).map(error => `Step ${index + 1}: ${error}`));
    const target = step.target || step;
    const selectors = ['resourceId','resource_id','text','contentDesc','content_desc','accessibility_id',...(strict ? [] : ['index'])];
    if (strict && target.index !== undefined) errors.push(`Step ${index + 1}: strict Appium tests require a stable selector, not UI-tree index.`);
    if (['tap','click','input','type','fill'].includes(type)) {
      const point = Number.isFinite(target.x) && Number.isFinite(target.y) && target.x >= 0 && target.y >= 0;
      if (!point && !selectors.some(key => target[key] !== undefined)) errors.push(`Step ${index + 1}: an explicit target selector or point is required.`);
      if (strict && ['input','type','fill'].includes(type) && !selectors.some(key => target[key] !== undefined)) errors.push(`Step ${index + 1}: Appium text input requires an element selector, not coordinates.`);
      if (target.index !== undefined && (!Number.isInteger(target.index) || target.index < 0)) errors.push(`Step ${index + 1}: index must be non-negative integer.`);
    }
    if (['input','type','fill'].includes(type) && typeof (step.value ?? step.text) !== 'string') errors.push(`Step ${index + 1}: text input must be a string.`);
    if (type === 'swipe' && !['x1','y1','x2','y2'].every(key => Number.isFinite(step[key]) && step[key] >= 0)) errors.push(`Step ${index + 1}: swipe requires four finite non-negative coordinates.`);
    for (const key of ['ms', 'duration_ms', 'timeout_ms']) {
      if (step[key] !== undefined && (!Number.isFinite(step[key]) || step[key] < 0 || step[key] > 30000)) errors.push(`Step ${index + 1}: ${key} must be between 0 and 30000.`);
    }
  });
  return errors;
}

export function isVerifiedDecryptedAppFlow(flow: NormalizedHttpFlow, expectedPackage: string, requirePackage: boolean): boolean {
  let url: URL;
  try { url = new URL(flow.url); } catch { return false; }
  const status = flow.response_status;
  const validResponse = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;
  const identityMatches = !requirePackage || (Boolean(expectedPackage) && flow.app_package === expectedPackage);
  return url.protocol === 'https:' && !url.username && !url.password && Boolean(flow.method) && flow.method.toUpperCase() !== 'CONNECT' && flow.tls_decrypted === true && validResponse && identityMatches;
}

export function captureRejectionReason(flow: NormalizedHttpFlow, session: MobileSession, allowedHosts: string[]): string | undefined {
  if (!isVerifiedDecryptedAppFlow(flow, session.app_package || '', true)) return 'invalid_tls_response_or_package';
  const tlsError = tlsCompletenessFailure(flow); if (tlsError) return tlsError;
  const capture = session.health_json?.capture || {};
  if (!capture.id || flow.capture_session_id !== capture.id) return 'wrong_capture_session';
  if (!session.device_id || flow.device_id !== session.device_id) return 'wrong_device';
  const started = Date.parse(String(flow.started_at || ''));
  const sessionStarted = Date.parse(String(capture.started_at || ''));
  if (!Number.isFinite(started) || !Number.isFinite(sessionStarted) || started < sessionStarted || started > Date.now() + 5000) return 'stale_or_invalid_timestamp';
  if (!allowedHosts.length || !allowedHosts.map(host => host.toLowerCase()).includes(new URL(flow.url).hostname.toLowerCase())) return 'outside_authorized_hosts';
  return undefined;
}
