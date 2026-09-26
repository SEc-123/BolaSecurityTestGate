import { discoveryCaptureRejection } from './discovery-capture-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { DbProvider } from '../../types/index.js';
import { AIScanRepository } from '../ai-scan/repository.js';
import { getMobileProfile } from './mobile-profile-service.js';
import { AndroidDeviceManager } from './android-device-manager.js';
import { installAndVerifyProxyCertificate, provisionProxyCertificate } from './android-certificate-manager.js';
import { BurpCaptureService } from './burp-capture-service.js';
import { createMobileAction, createMobileSession, getLatestMobileSessionForScan, getMobileSession, setMobileSessionStatus, updateMobileSession } from './mobile-session-service.js';
import type { MobileHealthCheck, MobileLabProfile, MobileObservation, MobileSession, NormalizedHttpFlow } from './mobile-types.js';
import { isBackgroundCommandRunning, stopBackgroundCommand } from './command-runner.js';
import { importMobileFlowsToRecording } from './mobile-traffic-importer.js';
import { captureRejectionReason, explicitAppIdentity, isOfflineProfile, isVerifiedDecryptedAppFlow, normalizeActivity, resolveTargetContract, validateObservation, validateStepExpectation, validateTargetPrerequisites, validateFlowSteps, validateExpectationShape } from './mobile-target-contract.js';
import { attestMobileApk } from './mobile-app-service.js';
import { acquireMobileResources, assertSessionUsable, newCaptureContext, profileForSession, releaseMobileResources, withMobileOperation, withMobileTestRun } from './mobile-runtime-state.js';

import { evaluateNetworkExpectations, validateNetworkExpectations, type StepCaptureScope, type NetworkExpectation } from './mobile-network-assertions.js';
import { captureDiagnostics, persistStepEvidence, setCaptureStep, verifyEvidenceFile } from './mobile-test-evidence.js';
import { listMobileActions } from './mobile-session-service.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function context(db: DbProvider, sessionId: string, requireUsable = true) {
  const session = await getMobileSession(db, sessionId);
  if (!session) throw new Error(`Mobile session not found: ${sessionId}`);
  const current = await getMobileProfile(db, session.profile_id);
  const frozen = session.health_json?.execution_profile;
  const profile = profileForSession(frozen ? { ...frozen, is_enabled: current.is_enabled } : current, session);
  if (requireUsable) assertSessionUsable(session, profile);
  return { session, profile, android: new AndroidDeviceManager(profile), contract: resolveTargetContract(profile) };
}

interface PrepareInput {
  session_id?: string; scan_run_id?: string; profile_id?: string; device_id?: string;
  app_package?: string; app_activity?: string; apk_path?: string; apk_source?: string;
  apk_sha256?: string; apk_signer_sha256?: string;
  acquisition_mode?: string; authorized_base_url?: string;
}

export async function prepareMobileLab(db: DbProvider, input: PrepareInput): Promise<{ profile: MobileLabProfile; session: MobileSession; health: MobileHealthCheck; details: Record<string, any> }> {
  return withMobileOperation(input.session_id || `scan:${input.scan_run_id || input.profile_id || 'default'}`, async () => {
    let session = input.session_id ? await getMobileSession(db, input.session_id) : input.scan_run_id ? await getLatestMobileSessionForScan(db, input.scan_run_id) : null;
    if (input.session_id && !session) throw new Error('Mobile session not found.');
    if (session && input.profile_id && input.profile_id !== session.profile_id) throw new Error('Cannot change a mobile session profile; create a new session.');
    let profile = await getMobileProfile(db, session?.profile_id || input.profile_id);
    if (!profile.is_enabled) throw new Error('Mobile profile is disabled.');
    if (input.authorized_base_url) {
      const target = new URL(input.authorized_base_url);
      const allowed = profile.config_json?.capture_allowed_hosts || [];
      if ((!['http:','https:'].includes(target.protocol) || target.protocol==='http:' && input.acquisition_mode!=='explore') || target.username || target.password || (allowed.length && !allowed.includes(target.hostname))) throw new Error('Target is outside this mobile profile scope.');
      profile = {...profile,config_json:{...profile.config_json, acquisition_mode:input.acquisition_mode==='explore'?'explore':'scenario',capture_origin:target.origin,capture_http_only:target.protocol==='http:',capture_allowed_hosts:[target.hostname]}};
    }

    if (session && ['ready', 'running', 'starting'].includes(session.status)) {
      for (const key of ['app_package','app_activity','apk_path','device_id'] as const) if (input[key] && input[key] !== session[key]) throw new Error(`Cannot change ${key} in an active session.`);
      const health = await verifyMobileLabHealth(db, session.id);
      return { profile, session: (await getMobileSession(db, session.id))!, health, details: session.health_json?.details || {} };
    }
    if (session && session.health_json?.details?.device?.ok && !session.health_json?.cleanup?.ok) throw new Error('Previous session owns runtime resources; stop it and create a new session before retrying.');
    if (session?.status === 'stopped') throw new Error('Stopped sessions are immutable. Create a new session for a fresh capture.');
    const apkPath = input.apk_path || session?.apk_path;
    const attestation = apkPath ? await attestMobileApk(apkPath, { aapt_path: profile.config_json?.aapt_path, apksigner_path: profile.config_json?.apksigner_path }) : undefined;
    if (attestation) {
      const expected = input.apk_sha256 || session?.apk_sha256;
      if (expected && expected.toLowerCase() !== attestation.sha256) throw new Error('APK digest changed after upload/session creation.');
      const signer = input.apk_signer_sha256 || session?.apk_signer_sha256;
      if (signer && signer.replace(/:/g, '').toLowerCase() !== attestation.signer_sha256) throw new Error('APK signer does not match the declared attestation.');
      if (resolveTargetContract(profile).require_apk_attestation && !attestation.signature_verified) throw new Error('APK signature verification failed; configure apksigner and use a signed authorized APK.');
    }
    const fields = {
      profile_id: profile.id, scan_run_id: input.scan_run_id || session?.scan_run_id,
      device_id: input.device_id || session?.device_id || profile.adb_serial,
      app_package: input.app_package || session?.app_package || attestation?.package_name || profile.config_json?.app_package,
      app_activity: input.app_activity || session?.app_activity || attestation?.launch_activity || profile.config_json?.app_activity,
      apk_path: apkPath, apk_source: input.apk_source || session?.apk_source,
      apk_sha256: attestation?.sha256 || session?.apk_sha256, apk_signer_sha256: attestation?.signer_sha256 || session?.apk_signer_sha256,
      apk_package_name: attestation?.package_name || session?.apk_package_name, apk_launch_activity: attestation?.launch_activity || session?.apk_launch_activity,
      apk_native_abis: attestation?.native_abis || session?.apk_native_abis,
      screen_stream_url: profile.config_json?.screen_stream_url,
    };
    session = session ? await updateMobileSession(db, session.id, fields) : await createMobileSession(db, fields);
    const manifestErrors = validateTargetPrerequisites(profile, session, 'manifest');
    if (resolveTargetContract(profile).strict_real_e2e && !profile.config_json?.capture_allowed_hosts?.length) manifestErrors.push('Set capture_allowed_hosts to the authorized App API hostnames.');
    if (manifestErrors.length) {
      const health: MobileHealthCheck = { status: 'blocked', capture_status: 'not_started', checks: [{ name: 'target_manifest', ok: false, message: manifestErrors.join(' ') }], summary: manifestErrors.join(' ') };
      session = await setMobileSessionStatus(db, session.id, 'blocked', 'not_started', health);
      return { profile, session, health, details: { target_contract: resolveTargetContract(profile) } };
    }
    session = await updateMobileSession(db, session.id, { health_json: { execution_profile: profile } });
    await acquireMobileResources(db, session, profile);
    // Allocate once; retries never silently change the identity of collected evidence.
    if (!session.health_json?.capture?.id) session = await updateMobileSession(db, session.id, { health_json: { capture: newCaptureContext(session.id) } });
    profile = profileForSession(profile, session);
    const android = new AndroidDeviceManager(profile);
    const details: Record<string, any> = { target_contract: resolveTargetContract(profile), evidence_level: isOfflineProfile(profile) ? 'simulated' : 'device_pending' };
    await setMobileSessionStatus(db, session.id, 'starting', 'not_started');
    try {
      details.emulator = await android.startEmulatorIfConfigured();
      await updateMobileSession(db, session.id, { health_json: { details } });
      details.device = details.emulator.acceleration_check ? { ok: false, error: details.emulator.reason } : await android.waitForDevice(Number(profile.config_json?.device_wait_timeout_ms || 90000));
      if (details.device.ok !== true) throw new Error('Android is not fully booted/available. Check ADB serial and device diagnostics.');
      if (!isOfflineProfile(profile)) {
        details.device.capabilities = await android.deviceCapabilities();
        if (!details.device.capabilities.ok) throw new Error(details.device.capabilities.error);
        // Select the trust store and validate APK ABI against the actual device,
        // never only the operator-entered display configuration.
        profile = { ...profile, android_api_level: details.device.capabilities.api_level,
          config_json: { ...profile.config_json, device_abis: details.device.capabilities.abis } };
        session = await updateMobileSession(db, session.id, { health_json: { execution_profile: profile, details } });
        const deviceErrors = validateTargetPrerequisites(profile, session, 'manifest');
        if (deviceErrors.length) throw new Error(deviceErrors.join(' '));
      }
      details.appium = await android.appiumHealth();
      if (resolveTargetContract(profile).strict_real_e2e && details.appium.ok !== true) throw new Error(details.appium.error || 'Appium server is not ready.');
      await updateMobileSession(db, session.id, { health_json: { details } });
      details.certificate = profile.config_json?.capture_http_only ? {ok:true,install_verified:false,skipped:'plaintext_http_target'} : await installAndVerifyProxyCertificate(profile, android, await provisionProxyCertificate(profile));
      session = await updateMobileSession(db, session.id, { certificate_evidence: details.certificate, health_json: { details } });
      if (resolveTargetContract(profile).require_proxy_certificate && profile.proxy_type !== 'none' && (details.certificate.ok !== true || details.certificate.install_verified !== true)) throw new Error(details.certificate.error || 'Proxy CA trust was not verified.');
      details.burp = await new BurpCaptureService(profile).startIfConfigured();
      await updateMobileSession(db, session.id, { health_json: { details } });
      const managed = !isOfflineProfile(profile) && (profile.proxy_type === 'mitmproxy' || profile.config_json?.managed_proxy === true);
      if (managed && details.burp.started !== true) throw new Error(details.burp.error || details.burp.reason || 'Capture proxy did not start.');
      details.proxy = await android.configureProxy();
      await updateMobileSession(db, session.id, { health_json: { details } });
      if (profile.proxy_type !== 'none' && details.proxy.configured !== true) throw new Error(details.proxy.reason || 'Android proxy configuration failed.');
      const health = await verifyMobileLabHealth(db, session.id, profile, { details });
      session = await setMobileSessionStatus(db, session.id, health.status === 'blocked' ? 'blocked' : 'ready', health.capture_status, { ...health, details });
      if (health.status === 'blocked') {
        const cleanup = await cleanupMobileRuntime(db, session.id);
        session = await updateMobileSession(db, session.id, { health_json: { cleanup } });
      }
      return { profile, session, health, details };
    } catch (error) {
      details.error = message(error);
      await updateMobileSession(db, session.id, { health_json: { details } });
      const cleanup = await cleanupMobileRuntime(db, session.id);
      const health: MobileHealthCheck = { status: 'blocked', capture_status: 'not_started', checks: [{ name: 'mobile_prepare', ok: false, message: message(error), details }], summary: message(error) };
      session = await setMobileSessionStatus(db, session.id, 'blocked', 'not_started', { ...health, details, cleanup });
      return { profile, session, health, details };
    }
  });
}

export async function verifyMobileLabHealth(db: DbProvider, sessionId: string, suppliedProfile?: MobileLabProfile, options: { details?: Record<string, any> } = {}): Promise<MobileHealthCheck> {
  const { session, profile: loaded } = await context(db, sessionId, false);
  const profile = profileForSession(suppliedProfile || loaded, session);
  const details = { ...(session.health_json?.details || {}), ...(options.details || {}) };
  const android = new AndroidDeviceManager(profile);
  const checks: MobileHealthCheck['checks'] = [];
  if (resolveTargetContract(profile).strict_real_e2e) {
    const appium = await android.appiumHealth();
    checks.push({ name: 'appium_server', ok: appium.ok === true, details: appium, message: appium.error });
  }
  const device = await android.runAdb(['get-state'], 8000);
  checks.push({ name: 'adb_device', ok: device.ok && device.stdout.trim() === 'device', message: device.ok ? device.stdout.trim() : device.stderr });
  if (profile.proxy_type !== 'none') {
    const proxy = await android.runAdb(['shell', 'settings', 'get', 'global', 'http_proxy'], 8000);
    checks.push({ name: 'android_proxy', ok: proxy.ok && proxy.stdout.trim() === (session.health_json?.details?.proxy?.proxy || `${profile.config_json?.proxy_device_host || profile.proxy_host}:${profile.proxy_port}`), message: proxy.stdout.trim() });
  }
  const certificate = details.certificate || session.certificate_evidence || {};
  checks.push({ name: 'proxy_ca_trust', ok: !resolveTargetContract(profile).require_proxy_certificate || profile.proxy_type === 'none' || certificate.ok === true && certificate.install_verified === true, details: { sha256: certificate.sha256, mode: certificate.mode }, message: certificate.error });
  const managed = !isOfflineProfile(profile) && (profile.proxy_type === 'mitmproxy' || profile.config_json?.managed_proxy === true);
  const proxyOk = !managed || isBackgroundCommandRunning(Number(details.burp?.pid));
  checks.push({ name: 'proxy_capture_process', ok: proxyOk, details: { managed, pid: details.burp?.pid }, message: proxyOk ? undefined : 'Owned capture process is not running; no PID/port-based success inference is allowed.' });
  const prerequisites = validateTargetPrerequisites(profile, session);
  if (prerequisites.length) checks.push({ name: 'target_prerequisites', ok: false, message: prerequisites.join(' ') });
  let flows: NormalizedHttpFlow[] = [];
  try { flows = await new BurpCaptureService(profile).loadFlows(); }
  catch (error) { checks.push({ name: 'capture_parse', ok: false, message: message(error) }); }
  const decrypted = flows.filter(flow => isOfflineProfile(profile)
    ? isVerifiedDecryptedAppFlow(flow, session.app_package || '', false)
    : !(profile.config_json?.acquisition_mode==='explore'?discoveryCaptureRejection(flow,session,profile):captureRejectionReason(flow, session, profile.config_json?.capture_allowed_hosts || [])));
  checks.push({ name: profile.config_json?.capture_http_only?'http_capture':'burp_https_decryption', ok: decrypted.length > 0 || flows.length === 0, status: decrypted.length ? (profile.config_json?.capture_http_only?'http_only':'https_decrypted') : flows.length ? 'unverified_traffic' : 'no_traffic_yet', details: { total: flows.length, verified: decrypted.length } });
  const diagnostics = await captureDiagnostics(session);
  checks.push({ name: 'https_diagnostics', ok: true, details: { events: diagnostics.slice(-30), effective_app_trust_verified: !profile.config_json?.capture_http_only && decrypted.length > 0 } });
  const captureStatus = decrypted.length ? (session.capture_status === 'imported' ? 'imported' : (profile.config_json?.capture_http_only ? 'http_only' : 'https_decrypted')) : flows.length ? 'tls_not_decrypted' : 'no_traffic';
  const status = checks.some(check => !check.ok) ? 'blocked' : decrypted.length ? 'ready' : 'warning';
  const summary = status === 'blocked' ? checks.filter(check => !check.ok).map(check => `${check.name}: ${check.message || check.status || 'failed'}`).join('; ') : status === 'warning' ? 'Device/lab is prepared; target HTTPS evidence has not been captured yet. Run the configured business flow.' : 'Device/lab and session-bound HTTPS evidence are available.';
  const health: MobileHealthCheck = { status, checks, capture_status: captureStatus, summary };
  await updateMobileSession(db, sessionId, { capture_status: captureStatus, health_json: { ...health, checked_at: new Date().toISOString(), details } });
  return health;
}

async function installImpl(db: DbProvider, sessionId: string, apkPath?: string): Promise<Record<string, any>> {
  const { session, profile, android, contract } = await context(db, sessionId);
  const finalPath = apkPath || session.apk_path;
  if (!finalPath) {
    if (contract.require_apk_install) throw new Error('Real Android E2E requires an attested APK.');
    return { ok: true, skipped: true, evidence_level: isOfflineProfile(profile) ? 'simulated' : 'non_strict', reason: 'No APK: non-strict installation skip is not real-device installation evidence.' };
  }
  const attestation = await attestMobileApk(finalPath, { aapt_path: profile.config_json?.aapt_path, apksigner_path: profile.config_json?.apksigner_path });
  if (contract.require_apk_attestation) {
    if (!attestation.signature_verified || !attestation.signer_sha256 || !attestation.package_name) throw new Error('APK signature/package verification failed.');
    if (session.apk_sha256 && session.apk_sha256 !== attestation.sha256) throw new Error('APK changed after session creation.');
    if (session.apk_signer_sha256 && session.apk_signer_sha256 !== attestation.signer_sha256) throw new Error('APK signer changed.');
    if (session.app_package !== attestation.package_name) throw new Error('APK package mismatch.');
    if (session.app_activity && attestation.launch_activity && normalizeActivity(session.app_package, session.app_activity) !== normalizeActivity(session.app_package, attestation.launch_activity)) throw new Error('APK launch activity mismatch.');
  }
  const result = await android.installApk(finalPath, session.app_package || attestation.package_name);
  await updateMobileSession(db, sessionId, { apk_path: finalPath, apk_sha256: attestation.sha256, apk_signer_sha256: attestation.signer_sha256, apk_package_name: attestation.package_name, apk_launch_activity: attestation.launch_activity, apk_native_abis: attestation.native_abis,
    status: result.ok === true ? 'ready' : 'failed', health_json: { apk_install: { ...result, attested_sha256: attestation.sha256, completed_at: new Date().toISOString() } } });
  if (result.ok !== true) throw new Error(`APK installation/package verification failed: ${result.stderr || result.stdout || 'unknown error'}`);
  return { ...result, attestation };
}
export const installMobileApp = (db: DbProvider, id: string, apkPath?: string) => withMobileOperation(id, () => installImpl(db, id, apkPath));

async function launchImpl(db: DbProvider, sessionId: string, appPackage?: string, activity?: string): Promise<Record<string, any>> {
  const { session, android, contract } = await context(db, sessionId);
  const pkg = appPackage || session.app_package;
  if (!pkg || session.app_package && pkg !== session.app_package) throw new Error('Launch target must match the attested session package.');
  if (contract.require_apk_install && session.health_json?.apk_install?.ok !== true) throw new Error('Install and verify the APK before launch.');
  if (activity && session.app_activity && normalizeActivity(pkg, activity) !== normalizeActivity(pkg, session.app_activity)) throw new Error('Launch activity must match the session manifest.');
  const result = await android.launchApp(pkg, activity || session.app_activity);
  await updateMobileSession(db, sessionId, { status: result.ok === true ? 'running' : 'failed', health_json: { app_launch: { ...result, completed_at: new Date().toISOString() } } });
  if (result.ok !== true) throw new Error(`Launch did not verify foreground package ${pkg}.`);
  return result;
}
export const launchMobileApp = (db: DbProvider, id: string, pkg?: string, activity?: string) => withMobileOperation(id, () => launchImpl(db, id, pkg, activity));

async function observeImpl(db: DbProvider, sessionId: string, repo?: AIScanRepository, taskId?: string, display?: { live?: boolean; test_key?: string }): Promise<MobileObservation & { screenshot_artifact_id?: string }> {
  const { session, profile, android } = await context(db, sessionId);
  const observation = await android.observe();
  observation.session_id = sessionId;
  observation.observed_at = new Date().toISOString();
  const errors = validateObservation(profile, session, observation);
  if (errors.length) throw new Error(errors.join(' '));
  let artifactId: string | undefined;
  if (repo && session.scan_run_id && observation.screenshot_base64) {
    const metadata = { session_id: sessionId, surface: 'android', test_key: display?.test_key, observed_at: observation.observed_at,
      evidence_level: isOfflineProfile(profile) ? 'simulated' : 'device_observation', device_id: observation.device_id, package: observation.package,
      activity: observation.activity, ui_tree_summary: observation.ui_tree.slice(0, 80), suggested_actions: observation.suggested_actions };
    if (display?.live) {
      await repo.upsertProductArtifact({ scan_run_id: session.scan_run_id, task_id: taskId, key: 'android',
        artifact_type: 'assessment_live_frame', content_json: metadata, content_text: observation.screenshot_base64 });
    } else {
      const artifact = await repo.createArtifact({ scan_run_id: session.scan_run_id, task_id: taskId,
        artifact_type: 'mobile_device_state', title: 'App business test observation', content_text: observation.screenshot_base64, content_json: metadata });
      artifactId = artifact.id;
    }
  }
  await updateMobileSession(db, sessionId, { health_json: { last_observation: { observed_at: observation.observed_at, package: observation.package, activity: observation.activity, ui_nodes: observation.ui_tree.length, screenshot_artifact_id: artifactId } } });
  // Never overwrite the attested launch identity with whatever screen is focused.
  return { ...observation, screenshot_artifact_id: artifactId };
}
export const observeMobileApp = (db: DbProvider, id: string, repo?: AIScanRepository, taskId?: string) => withMobileOperation(id, () => observeImpl(db, id, repo, taskId));

async function actionImpl(db: DbProvider, sessionId: string, action: Record<string, any>, repo?: AIScanRepository, taskId?: string, flowRunId?: string): Promise<Record<string, any>> {
  const { session, profile, android, contract } = await context(db, sessionId);
  const type = String(action.action || action.type || '').toLowerCase();
  const stepId = randomUUID();
  const scope: StepCaptureScope = { run_id: flowRunId || randomUUID(), step_id: stepId, capture_session_id: session.health_json?.capture?.id || '', device_id: session.device_id || '', app_package: session.app_package || '', started_at: new Date().toISOString() };
  const expectations: NetworkExpectation[] = Array.isArray(action.expect_network) ? action.expect_network : [];
  let result: Record<string, any> = { ok: false };
  let observation: Awaited<ReturnType<typeof observeImpl>> | null = null;
  let assertionError: string | undefined;
  let network: ReturnType<typeof evaluateNetworkExpectations> | undefined;
  let captured: NormalizedHttpFlow[] = [];
  let evidence: Record<string, any> | undefined;
  const traceStart = android.appiumTrace().length;
  try {
    if (contract.require_apk_install && session.health_json?.apk_install?.ok !== true) throw new Error('Install and verify the App before UI testing.');
    if (contract.strict_real_e2e && type !== 'launch' && session.health_json?.app_launch?.ok !== true) throw new Error('Launch and verify the App through Appium before UI testing.');
    if (contract.require_flow_assertions && type !== 'wait' && action.expect === undefined) throw new Error('A strict mobile action requires an observable expect assertion.');
    if (action.expect !== undefined) { const error = validateExpectationShape(action.expect); if (error) throw new Error(error); }
    if (action.expect_network !== undefined) {
      const errors = validateNetworkExpectations(action.expect_network, profile.config_json?.capture_allowed_hosts || []);
      if (errors.length) throw new Error(errors.join(' '));
      if (!contract.strict_real_e2e) throw new Error('Step-bound HTTPS assertions require a strict Appium test profile, not simulated traffic.');
    }
    const timeout = action.timeout_ms ?? 10000;
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 30000) throw new Error('timeout_ms must be 0–30000.');
    if (contract.strict_real_e2e) await setCaptureStep(session, scope);
    if (type === 'launch') result = await launchImpl(db,sessionId);
    else if (['tap','click'].includes(type)) result = await android.tap(action.target || action);
    else if (['input','type','fill'].includes(type)) result = await android.inputText(action.target || action, String(action.value ?? action.text ?? ''), type === 'fill');
    else if (type === 'swipe') result = await android.swipe(action);
    else if (type === 'back') result = await android.back();
    else if (type === 'wait') {
      const ms = action.ms ?? action.duration_ms ?? 1000;
      if (!Number.isFinite(ms) || ms < 0 || ms > 30000) throw new Error('Wait duration must be 0–30000 ms.');
      await sleep(ms); result = { ok: true, waited_ms: ms, source: 'explicit_wait' };
    } else throw new Error(`Unsupported mobile action: ${type}`);
    if (result.ok !== true) throw new Error(result.error || result.stderr || 'Android action failed.');
    if (contract.strict_real_e2e && type !== 'wait' && (result.source !== 'appium_uiautomator2' || !result.appium?.session_id || result.appium.device_id !== session.device_id)) throw new Error('UI action lacks matching Appium session/UDID evidence. ADB success is not Appium success.');
    // Keep attribution open while startup/SPA-like async requests settle. A
    // screenshot alone can otherwise finish before the first API response.
    if(profile.config_json.acquisition_mode==='explore')await sleep(type==='launch'?1500:800);
    const deadline = Date.now() + timeout;
    // Observe repeatedly, but issue each mutating Appium command exactly once.
    let lastFrameAt = 0;
    do {
      try {
        const publish = !!repo && Date.now() - lastFrameAt >= 750;
        observation = await observeImpl(db, sessionId, publish ? repo : undefined, taskId, { live: true, test_key: action.business_test_id });
        if (publish) lastFrameAt = Date.now();
        assertionError = validateStepExpectation(observation, action.expect);
      }
      catch (error) { assertionError = message(error); }
      if (expectations.length) {
        captured = await new BurpCaptureService(profile).loadFlows();
        network = evaluateNetworkExpectations(expectations, captured, scope);
      }
      const hardNetworkFailure = network?.assertions.some(a => a.failures.some(f => f !== 'expected_https_request_not_observed'));
      if (hardNetworkFailure) throw new Error('HTTPS business assertion failed; inspect network assertion codes.');
      // A maximum count assertion must observe the entire declared window.
      const needsFullWindow = expectations.some(e => e.max_count !== undefined);
      if (!assertionError && (!network || network.ok) && (!needsFullWindow || Date.now() >= deadline)) break;
      if (Date.now() >= deadline) throw new Error(assertionError || 'Expected step-bound HTTPS request/response was not observed before timeout.');
      await sleep(200);
    } while (true);
    if (repo && session.scan_run_id) {
      observation = await observeImpl(db, sessionId, repo, taskId, { test_key: action.business_test_id });
      assertionError = validateStepExpectation(observation, action.expect);
      if (assertionError) throw new Error(assertionError);
    }
  } catch (error) {
    result = { ...result, ok: false, error: message(error) };
  } finally {
    if (contract.strict_real_e2e) {
      try { await setCaptureStep(session, null); } catch (error) { result = { ...result, ok: false, error: `Cannot close capture step: ${message(error)}` }; }
      try {
        if (!observation) observation = await observeImpl(db, sessionId).catch(() => null);
        captured = await new BurpCaptureService(profile).loadFlows().catch(() => captured);
        const stepFlows = captured.filter(f => f.test_run_id === scope.run_id && f.step_id === scope.step_id);
        evidence = await persistStepEvidence(session, stepId, observation, stepFlows, android.appiumTrace().slice(traceStart));
      } catch (error) { result = { ...result, ok: false, error: `Cannot persist test evidence: ${message(error)}` }; }
    }
  }
  const diagnostics = expectations.length ? await captureDiagnostics(session, scope) : [];
  // Expected body/header values can contain credentials. Store only the assertion
  // structure in the action log; actual wire evidence stays in protected files.
  const safeInput = { ...action };
  if (['input','type','fill'].includes(type)) { safeInput.value = '[redacted]'; safeInput.text = '[redacted]'; if (safeInput.expect?.text) safeInput.expect = { ...safeInput.expect, text: '[redacted]' }; }
  if (safeInput.expect_network) safeInput.expect_network = expectations.map(e => ({ id: e.id, method: e.method, url: e.url, response: { status: e.response.status }, assertions_redacted: true }));
  const stored = { ...result, test_run_id: scope.run_id, step_id: stepId, started_at: scope.started_at, completed_at: new Date().toISOString(), assertion_error: assertionError, observed_at: observation?.observed_at, network, diagnostics, evidence };
  const record = await createMobileAction(db, { session_id: sessionId, scan_run_id: session.scan_run_id, task_id: taskId, action_type: type, input_json: safeInput, result_json: stored, screenshot_artifact_id: observation?.screenshot_artifact_id, status: result.ok === true ? 'completed' : 'failed' });
  return { ok: result.ok === true, action: record, result: stored, observation, assertion_error: assertionError, network };
}
/** Internal acquisition operation; business assertions remain a separate explicit contract. */
export const runDiscoveryAction = (db:DbProvider,id:string,action:Record<string,any>,runId:string,repo:AIScanRepository,taskId:string) =>
  withMobileOperation(id,()=>actionImpl(db,id,action,repo,taskId,runId));

export const runMobileAction = (db: DbProvider, id: string, action: Record<string, any>, repo?: AIScanRepository, taskId?: string) => withMobileOperation(id, async () => {
  const { session, contract } = await context(db, id);
  if (contract.strict_real_e2e && session.health_json?.capture_import?.result) throw new Error('Imported test sessions are immutable. Create a new session.');
  await updateMobileSession(db, id, { health_json: { flow_run: { ok: false, status: 'manual_action', reason: 'Standalone UI debugging is not a complete test run.' } } });
  return actionImpl(db, id, action, repo, taskId);
});

export async function runConfiguredMobileFlow(db: DbProvider, sessionId: string, steps: Array<Record<string, any>>, repo?: AIScanRepository, taskId?: string): Promise<Record<string, any>> {
  return withMobileOperation(sessionId, async () => {
    const { session, profile, contract, android } = await context(db, sessionId);
    if (contract.strict_real_e2e && session.health_json?.capture_import?.result) throw new Error('Imported test sessions are immutable. Create a new session for another test.');
    const errors = validateFlowSteps(steps, contract.require_flow_assertions);
    if (contract.strict_real_e2e && !steps?.some(step => String(step?.action || step?.type).toLowerCase() !== 'wait' && Array.isArray(step?.expect_network) && step.expect_network.length)) errors.push('An Appium HTTPS test requires expect_network on at least one business action; UI-only or capture-only is not acceptance.');
    for (const step of Array.isArray(steps) ? steps : []) if (step?.expect_network !== undefined) errors.push(...validateNetworkExpectations(step.expect_network, profile.config_json?.capture_allowed_hosts || []));
    const runId = randomUUID(), startedAt = new Date().toISOString();
    if (errors.length) {
      await updateMobileSession(db, sessionId, { health_json: { flow_run: { id: runId, ok: false, status: 'invalid', gate_result: 'BLOCK', errors, steps_executed: 0, started_at: startedAt, completed_at: new Date().toISOString() } } });
      throw new Error(errors.join(' '));
    }
    await updateMobileSession(db, sessionId, { health_json: { flow_run: { id: runId, ok: false, status: 'running', started_at: startedAt } } });
    const results: Record<string, any>[] = [];
    const deadline = Date.now() + 300000;
    const caseKeys = steps.map((step, index) => String(step.business_test_id || `step-${index}`));
    const caseResults = new Map<string, Array<Record<string, any>>>();
    const attemptedCases = new Set<string>();
    const updateCase = async (key: string, status: string) => {
      if (!repo || !session.scan_run_id) return;
      const done = caseResults.get(key) || [];
      const expected = caseKeys.filter(k => k === key).length;
      const assertionsVerified = done.length === expected && done.every(r => r.ok === true && r.result?.evidence?.files?.['screen.png'] && r.result?.evidence?.files?.['ui.json'] && (!r.network || r.network.ok === true));
      await repo.upsertProductArtifact({ scan_run_id: session.scan_run_id, task_id: taskId, key,
        artifact_type: 'business_test_progress', content_json: { test_key: key, status, assertions_verified: assertionsVerified,
          executed_steps: done.length, expected_steps: expected, evidence_count: done.length, updated_at: new Date().toISOString(), run_id: runId } });
    };
    // Reset every case at the start: a retry must not inherit a previous green check.
    for (const key of new Set(caseKeys)) await updateCase(key, 'pending');
    try {
      for (const [index, configuredStep] of steps.entries()) {
        if (Date.now() >= deadline) { errors.push('Flow exceeded its five-minute execution budget.'); break; }
        const key = caseKeys[index];
        await updateCase(key, 'running');
        attemptedCases.add(key);
        const step: Record<string, any> = { ...configuredStep, business_test_id: key };
        const result = await actionImpl(db, sessionId, step, repo, taskId, runId);
        const done = caseResults.get(key) || []; done.push(result); caseResults.set(key, done);
        results.push({ type: step.action || step.type, business_test_id: key, ok: result.ok === true, action_id: result.action.id, step_id: result.result.step_id, error: result.result.error, assertion_error: result.assertion_error, network: result.network, source: result.result.source, appium_session_id: result.result.appium?.session_id, evidence: result.result.evidence });
        const full = done.length === caseKeys.filter(k => k === key).length;
        await updateCase(key, done.some(r => !r.ok) ? 'failed' : full ? 'completed' : 'running');
        if (!result.ok && step.stop_on_error !== false) break;
      }
    } catch (error) { errors.push(message(error)); }
    for (const key of new Set(caseKeys)) {
      const done = caseResults.get(key) || [];
      if (done.length < caseKeys.filter(k => k === key).length) await updateCase(key, attemptedCases.has(key) ? 'failed' : 'not_run');
    }
    const networkAssertions = results.flatMap(r => r.network?.assertions || []);
    const networkPassed = networkAssertions.length > 0 && networkAssertions.every(a => a.ok);
    const ok = !errors.length && results.length === steps.length && results.every(r => r.ok) && (!contract.strict_real_e2e || networkPassed);
    const result = { id: runId, scope: 'appium_ui_and_https_business_assertions', driver: contract.strict_real_e2e ? 'appium_uiautomator2' : 'non_strict_or_simulator', started_at: startedAt, expected_steps: steps.length,
      steps_executed: results.length, results, errors, ok, status: ok ? 'completed' : 'failed', gate_result: ok ? 'PASS' : 'BLOCK',
      network_assertions_passed: networkPassed, network_assertion_count: networkAssertions.length,
      matched_flow_ids: [...new Set(results.flatMap(r => r.network?.matched_flow_ids || []))], appium: android.appiumEvidence(),
      completed_at: new Date().toISOString() };
    await updateMobileSession(db, sessionId, { health_json: { flow_run: result } });
    return result;
  });
}

/** Persisted App test result, independent of optional server-side HTTP replay. */
export async function getMobileTestReport(db: DbProvider, sessionId: string): Promise<Record<string, any>> {
  const { session, profile } = await context(db, sessionId, false);
  const run = session.health_json?.flow_run;
  const actions = run?.id ? (await listMobileActions(db, sessionId)).filter(a => a.result_json.test_run_id === run.id) : [];
  const integrityErrors: string[] = [];
  for (const action of actions) {
    const result = action.result_json;
    const files = result.evidence?.files || {};
    for (const name of ['screen.png','ui.json','network.json','appium.json']) {
      try {
        if (!files[name]) throw new Error('missing');
        const bytes = await verifyEvidenceFile(files[name]);
        if (name === 'ui.json') {
          const ui = JSON.parse(bytes.toString('utf8'));
          if (ui.session_id !== session.id || ui.device_id !== session.device_id || ui.package !== session.app_package || ui.health?.source !== 'appium_uiautomator2' || ui.health?.appium?.session_id !== run?.appium?.session_id) throw new Error('wrong UI identity');
        }
        if (name === 'network.json') {
          const flows: NormalizedHttpFlow[] = JSON.parse(bytes.toString('utf8'));
          if (!Array.isArray(flows)) throw new Error('invalid network snapshot');
          for (const id of result.network?.matched_flow_ids || []) {
            const f = flows.find(f => f.flow_id === id);
            if (!f || f.test_run_id !== run?.id || f.step_id !== result.step_id || captureRejectionReason(f, session, profile.config_json?.capture_allowed_hosts || [])) throw new Error('wrong HTTPS identity');
          }
        }
      } catch { integrityErrors.push(`Missing, changed or mismatched ${name} for action ${action.id}.`); }
    }
    if (action.action_type !== 'wait' && (result.source !== 'appium_uiautomator2' || result.appium?.session_id !== run?.appium?.session_id || result.appium?.device_id !== session.device_id)) integrityErrors.push(`Appium identity mismatch for action ${action.id}.`);
  }
  const strict = resolveTargetContract(profile).strict_real_e2e;
  const complete = !!run?.ok && !!run.appium?.session_id && run.appium.device_id === session.device_id && run.driver === 'appium_uiautomator2' && run.network_assertions_passed === true && actions.length === run.expected_steps && actions.every(a => a.status === 'completed' && a.result_json.evidence?.files?.['screen.png'] && a.result_json.evidence?.files?.['ui.json']);
  const cleanupOk = session.health_json?.cleanup?.ok === true && session.status === 'stopped';
  const pass = strict && complete && !integrityErrors.length && cleanupOk && session.health_json?.test_orchestration?.ok !== false;
  return { format_version: 2, mobile_session_id: sessionId, app_package: session.app_package, device_id: session.device_id, apk_sha256: session.apk_sha256,
    capture_session_id: session.health_json?.capture?.id, orchestration: session.health_json?.test_orchestration, run, actions, cleanup: session.health_json?.cleanup || null, integrity_errors: integrityErrors,
    gate_result: pass ? 'PASS' : 'BLOCK', acceptance_complete: pass, execution_passed: complete && !integrityErrors.length,
    scope: 'Declared Appium UI and HTTPS request/response business assertions; not a whole-App security certification.',
    evidence_level: strict ? 'appium_server_and_proxy_reported_requires_trusted_lab' : 'simulated_or_non_strict',
    blocked_reason: pass ? undefined : !run ? 'test_not_run' : !complete || integrityErrors.length || session.health_json?.test_orchestration?.ok === false ? 'test_or_evidence_failed' : !cleanupOk ? 'cleanup_not_verified' : 'non_strict_profile' };
}

/** Owns the complete lifecycle on the server, even when an HTTP client disconnects.
 * Do not repeat failed mutating steps or silently resume an earlier completed run. */
export async function runMobileAppTest(db: DbProvider, sessionId: string, steps: Array<Record<string, any>>, options: { import_capture?: boolean } = {}): Promise<Record<string, any>> {
  return withMobileTestRun(sessionId, async () => {
    const before = await getMobileSession(db, sessionId);
    if (!before) throw new Error('Mobile session not found.');
    if (before.status === 'stopped' || before.health_json?.test_orchestration) throw new Error('Create a fresh session for every App test; completed tests cannot be replayed implicitly.');
    const errors: string[] = [];
    const startedAt = new Date().toISOString();
    await updateMobileSession(db, sessionId, { health_json: { test_orchestration: { ok: false, status: 'running', started_at: startedAt } } });
    try {
      const selected = await getMobileProfile(db, before.profile_id);
      const planErrors = validateFlowSteps(steps, true);
      if (!steps.some(s => (s?.action || s?.type) !== 'wait' && Array.isArray(s?.expect_network) && s.expect_network.length)) planErrors.push('A business action must declare HTTPS assertions.');
      for (const s of steps) if (s?.expect_network !== undefined) planErrors.push(...validateNetworkExpectations(s.expect_network, selected.config_json?.capture_allowed_hosts || []));
      if (planErrors.length) throw new Error(planErrors.join(' '));
      const prepared = await prepareMobileLab(db, { session_id: sessionId });
      if (prepared.health.status === 'blocked') throw new Error(prepared.health.summary);
      await installMobileApp(db, sessionId);
      await launchMobileApp(db, sessionId);
      const run = await runConfiguredMobileFlow(db, sessionId, steps);
      if (!run.ok) throw new Error('Appium UI/HTTPS business test failed. Inspect persisted step results.');
      if (options.import_capture !== false) await exportAndImportMobileCapture(db, sessionId, { regenerate: true });
    } catch (error) { errors.push(message(error)); }
    finally {
      try { const cleanup = await stopMobileLab(db, sessionId); if (!cleanup.ok) errors.push('Runtime cleanup failed.'); }
      catch (error) { errors.push(`Runtime cleanup: ${message(error)}`); }
      await updateMobileSession(db, sessionId, { health_json: { test_orchestration: { ok: errors.length === 0, status: errors.length ? 'failed' : 'completed', started_at: startedAt, completed_at: new Date().toISOString(), errors } } });
    }
    return getMobileTestReport(db, sessionId);
  });
}

export async function exportAndImportMobileCapture(db: DbProvider, sessionId: string, input: { export_path?: string; flows?: NormalizedHttpFlow[]; regenerate?: boolean } = {}): Promise<Record<string, any>> {
  return withMobileOperation(sessionId, async () => {
    const { session, profile, contract } = await context(db, sessionId);
    const prerequisites = validateTargetPrerequisites(profile, session, 'capture');
    if (prerequisites.length) throw new Error(prerequisites.join(' '));
    if (contract.strict_real_e2e && input.flows) throw new Error('Strict acceptance reads the configured capture source, not caller-supplied evidence objects.');
    const managed = profile.proxy_type === 'mitmproxy' || profile.config_json?.managed_proxy === true;
    if (contract.strict_real_e2e && managed && input.export_path && path.resolve(input.export_path) !== path.resolve(session.health_json.capture.path)) throw new Error('Capture path must match this session-owned capture file.');
    const flows = await new BurpCaptureService(profile).loadFlows(input);
    const rejected: Record<string, number> = {};
    const acquired = profile.config_json?.acquisition_mode === 'explore' ? session.health_json.discovery_run : session.health_json.flow_run;
    const accepted = flows.filter(flow => {
      const reason = contract.strict_real_e2e ? ((profile.config_json?.acquisition_mode==='explore' ? discoveryCaptureRejection(flow,session,profile) : captureRejectionReason(flow, session, profile.config_json?.capture_allowed_hosts || []))
        || (flow.test_run_id !== acquired?.id || !acquired?.matched_flow_ids?.includes(flow.flow_id) ? 'not_asserted_by_current_appium_test' : undefined)) : undefined;
      if (reason) { rejected[reason] = (rejected[reason] || 0) + 1; return false; }
      return true;
    });
    const seen = new Set<string>();
    const unique = accepted.filter(flow => { const key = flow.flow_id || createHash('sha256').update(JSON.stringify(flow)).digest('hex'); if (seen.has(key)) return false; seen.add(key); return true; });
    unique.sort((a, b) => (Date.parse(a.started_at || '') || 0) - (Date.parse(b.started_at || '') || 0));
    const verified = unique.filter(flow => profile.config_json?.acquisition_mode==='explore' ? !discoveryCaptureRejection(flow,session,profile) : isVerifiedDecryptedAppFlow(flow, explicitAppIdentity(profile, session), contract.require_capture_app_identity));
    if (!unique.length || contract.strict_real_e2e && verified.length < contract.minimum_decrypted_flows) throw new Error(`Insufficient session-bound target network evidence: accepted=${verified.length}, required=${contract.minimum_decrypted_flows}, rejected=${JSON.stringify(rejected)}.`);
    const digest = createHash('sha256').update(JSON.stringify(unique)).digest('hex');
    const previous = session.health_json?.capture_import;
    if (previous?.sha256 === digest && previous?.result) return { ...previous.result, reused: true };
    if (previous?.result) throw new Error('This session already imported a different evidence snapshot. Create a new session rather than duplicate recordings.');
    const result = await importMobileFlowsToRecording(db, { scan_run_id: session.scan_run_id,
      environment_id: session.scan_run_id ? (await new AIScanRepository(db).getRun(session.scan_run_id))?.environment_id : undefined,
      mobile_session_id: sessionId, app_package: session.app_package, flows: unique, mode: 'workflow', regenerate: input.regenerate !== false,
      require_explicit_tls_evidence: !profile.config_json?.capture_http_only && contract.require_explicit_tls_evidence, require_capture_app_identity: contract.require_capture_app_identity, minimum_decrypted_flows: contract.minimum_decrypted_flows,
      minimum_workflow_drafts: profile.config_json?.acquisition_mode === 'explore' ? 0 : contract.minimum_workflow_drafts });
    const output = { ...result, received_flows: flows.length, rejected_flows: flows.length - accepted.length, rejection_reasons: rejected, duplicate_flows: accepted.length - unique.length,
      flow_count: flows.length, verified_target_flows: verified.length, evidence_sha256: digest, target_contract: contract,
      evidence_level: isOfflineProfile(profile) ? 'simulated' : contract.strict_real_e2e ? 'session_bound_device_capture' : 'non_strict', capture_session_id: session.health_json?.capture?.id };
    const snapshotPath = session.health_json?.capture?.path ? `${session.health_json.capture.path}.accepted.json` : undefined;
    if (snapshotPath) {
      await fs.mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(snapshotPath, JSON.stringify(unique), { mode: 0o600 });
    }
    await updateMobileSession(db, sessionId, { health_json: { capture_import: { sha256: digest, snapshot_path: snapshotPath, result: output, completed_at: new Date().toISOString() } } });
    return output;
  });
}

/** Immutable accepted snapshot, not the live capture file that may still grow. */
export async function exportMobileCaptureEvidence(db: DbProvider, sessionId: string): Promise<Record<string, any>> {
  const { session } = await context(db, sessionId, false);
  const imported = session.health_json?.capture_import;
  if (!imported?.result || !imported.snapshot_path) throw new Error('No successfully imported capture snapshot exists for this session.');
  const bytes = await fs.readFile(imported.snapshot_path);
  if (createHash('sha256').update(bytes).digest('hex') !== imported.sha256) throw new Error('Capture snapshot integrity check failed.');
  return { session_id: sessionId, capture_session_id: session.health_json?.capture?.id, sha256: imported.sha256,
    evidence_level: imported.result.evidence_level, attribution: 'operator_isolated_device_and_host_allowlist', flows: JSON.parse(bytes.toString('utf8')) };
}

async function cleanupMobileRuntime(db: DbProvider, sessionId: string): Promise<Record<string, any>> {
  const { session, profile, android } = await context(db, sessionId, false);
  const details = session.health_json?.details || {};
  let proxy: Record<string, any> = { cleared: true, skipped: true };
  if (details.proxy?.configured || details.proxy?.changed || details.proxy?.reverse?.configured) proxy = await android.clearProxy(details.proxy.previous_proxy, details.proxy.reverse?.configured === true).catch(error => ({ cleared: false, error: message(error) }));
  let captureContextCleared = true;
  try { await setCaptureStep(session, null); } catch { captureContextCleared = false; }
  const appium = await android.closeAppiumSessions();
  const capture = details.burp?.pid ? await stopBackgroundCommand(Number(details.burp.pid)) : { stopped: true, skipped: true };
  const emulator = details.emulator?.pid ? await stopBackgroundCommand(Number(details.emulator.pid)) : { stopped: true, skipped: true };
  const ok = captureContextCleared && proxy.cleared === true && appium.ok === true && capture.stopped === true && emulator.stopped === true;
  if (ok) await releaseMobileResources(db, sessionId);
  return { ok, capture_context_cleared: captureContextCleared, proxy, appium, capture_process: capture, emulator, completed_at: new Date().toISOString() };
}

export async function stopMobileLab(db: DbProvider, sessionId: string): Promise<Record<string, any>> {
  return withMobileOperation(sessionId, async () => {
    const { session } = await context(db, sessionId, false);
    if (session.status === 'stopped' && session.health_json?.cleanup?.ok) return { ...session.health_json.cleanup, session_id: sessionId, reused: true };
    const cleanup = await cleanupMobileRuntime(db, sessionId);
    await setMobileSessionStatus(db, sessionId, cleanup.ok ? 'stopped' : 'blocked', session.capture_status, { cleanup });
    return { ...cleanup, session_id: sessionId };
  });
}
