import type { AgentToolSpec } from '../tool-types.js';
import { getMobileSession, getLatestMobileSessionForScan } from '../../services/mobile/mobile-session-service.js';
import { exportAndImportMobileCapture, installMobileApp, launchMobileApp, observeMobileApp, prepareMobileLab, runConfiguredMobileFlow, runMobileAction, verifyMobileLabHealth, stopMobileLab } from '../../services/mobile/mobile-lab-service.js';
import { resolveTargetContract, validateTargetPrerequisites } from '../../services/mobile/mobile-target-contract.js';

async function resolveSessionId(context: any, explicit?: unknown): Promise<string> {
  if (explicit) {
    const session = await getMobileSession(context.db, String(explicit));
    if (!session || session.scan_run_id !== context.scanRunId) throw new Error('Mobile session does not belong to this scan.');
    return session.id;
  }
  const existing = await getLatestMobileSessionForScan(context.db, context.scanRunId);
  if (!existing) throw new Error('No mobile session exists for this scan. Call mobile.lab.prepare first.');
  return existing.id;
}

async function mobileConfig(context: any): Promise<Record<string, any>> {
  const scan = await context.repo.getRun(context.scanRunId);
  if (!scan) throw new Error('AI scan not found.');
  return scan.scan_config?.mobile || scan.scan_config?.android || scan.scan_config || {};
}

export function buildMobileScanToolSpecs(): AgentToolSpec[] {
  return [
    { name: 'mobile.lab.stop', description: 'Restores the prior device proxy, closes owned Appium sessions and stops only owned capture/emulator processes. Call after capture or failure.', input_schema: { type: 'object', properties: { session_id: { type: 'string' } } }, side_effects: ['releases owned mobile resources'], handler: async (input, context) => {
      const result = await stopMobileLab(context.db, await resolveSessionId(context, input.session_id));
      return { ok: result.ok === true, data: result, summary: result.ok ? 'Mobile runtime cleaned up.' : 'Mobile cleanup needs operator attention.' };
    } },
    {
      name: 'mobile.lab.prepare',
      description: 'Starts or attaches to the preconfigured Android Mobile Lab: internal Burp bridge, emulator/device, proxy, certificate-ready profile, and HTTPS capture health gate. Preparation only verifies infrastructure. Actual App TLS trust and business outcomes must subsequently be proved by the Appium flow with HTTPS assertions. It does not bypass certificate pinning.',
      input_schema: { type: 'object', properties: { profile_id: { type: 'string' }, app_package: { type: 'string' }, app_activity: { type: 'string' }, apk_path: { type: 'string' } } },
      side_effects: ['creates/updates mobile_sessions', 'runs adb/emulator/proxy health checks', 'creates mobile_lab_state artifact'],
      handler: async (input, context) => {
        const cfg = await mobileConfig(context);
        const result = await prepareMobileLab(context.db, {
          scan_run_id: context.scanRunId,
          profile_id: String(input.profile_id || cfg.lab_profile_id || cfg.profile_id || 'android-burp-ready-default'),
          app_package: input.app_package ? String(input.app_package) : cfg.app_package,
          app_activity: input.app_activity ? String(input.app_activity) : cfg.app_activity,
          apk_path: input.apk_path ? String(input.apk_path) : cfg.apk_path,
          device_id: cfg.device_id, apk_source: cfg.apk_source, apk_sha256: cfg.apk_sha256, apk_signer_sha256: cfg.apk_signer_sha256,
        });
        await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'mobile_lab_state', title: 'Android Mobile Lab prepared', content_json: { session: result.session, health: result.health, details: result.details } });
        return { ok: result.health.status !== 'blocked', data: { session: result.session, health: result.health, target_contract: resolveTargetContract(result.profile) }, summary: result.health.summary };
      },
    },
    {
      name: 'mobile.lab.health_check',
      description: 'Verifies the current Android Mobile Lab state: adb device, proxy, preinstalled Burp CA status inferred from decryptable HTTPS flows, and capture readiness. Blocks deep App testing when HTTPS is not decrypted.',
      input_schema: { type: 'object', properties: { session_id: { type: 'string' } } },
      side_effects: ['updates mobile_sessions.health_json', 'creates mobile_health_check artifact'],
      handler: async (input, context) => {
        const sessionId = await resolveSessionId(context, input.session_id);
        const health = await verifyMobileLabHealth(context.db, sessionId);
        await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'mobile_health_check', title: 'Android HTTPS capture health check', content_json: { session_id: sessionId, health } });
        return { ok: health.status !== 'blocked', data: { session_id: sessionId, health }, summary: health.summary };
      },
    },
    {
      name: 'mobile.app.install',
      description: 'Installs the target APK onto the prepared Android device using adb install -r and verifies the declared package exists after installation. Strict real-device profiles do not accept an install skip.',
      input_schema: { type: 'object', properties: { session_id: { type: 'string' }, apk_path: { type: 'string' } } },
      side_effects: ['installs APK on lab device', 'updates mobile session'],
      handler: async (input, context) => {
        const sessionId = await resolveSessionId(context, input.session_id);
        const cfg = await mobileConfig(context);
        const result = await installMobileApp(context.db, sessionId, input.apk_path ? String(input.apk_path) : cfg.apk_path);
        return { ok: result.ok === true && result.package_verified !== false, data: { session_id: sessionId, result }, summary: result.skipped ? 'APK install skipped only because this non-strict profile permits it.' : `APK install ${result.ok ? 'completed and package verified' : 'failed'}.` };
      },
    },
    {
      name: 'mobile.app.launch',
      description: 'Launches the authorized Android App package/activity on the prepared device.',
      input_schema: { type: 'object', properties: { session_id: { type: 'string' }, app_package: { type: 'string' }, app_activity: { type: 'string' } } },
      side_effects: ['launches Android App', 'updates mobile session'],
      handler: async (input, context) => {
        const sessionId = await resolveSessionId(context, input.session_id);
        const cfg = await mobileConfig(context);
        const pkg = input.app_package ? String(input.app_package) : cfg.app_package;
        const result = await launchMobileApp(context.db, sessionId, pkg, input.app_activity ? String(input.app_activity) : cfg.app_activity);
        return { ok: result.ok === true, data: { session_id: sessionId, result }, summary: `Launched Android App package ${pkg}.` };
      },
    },
    {
      name: 'mobile.observe',
      description: 'Observes the current Android App screen using screenshot + UIAutomator accessibility hierarchy. Creates a mobile_device_state artifact for the right-side App panel and returns actionable UI nodes.',
      input_schema: { type: 'object', properties: { session_id: { type: 'string' } } },
      side_effects: ['creates mobile_device_state artifact'],
      handler: async (input, context) => {
        const sessionId = await resolveSessionId(context, input.session_id);
        const observation = await observeMobileApp(context.db, sessionId, context.repo, context.taskId);
        return { ok: Boolean(observation.screenshot_base64 && observation.ui_tree.length), data: { ...observation, screenshot_base64: observation.screenshot_base64 ? '[artifact]' : undefined }, summary: `Observed Android App screen with ${observation.ui_tree.length} UI nodes.` };
      },
    },
    {
      name: 'mobile.action.run',
      description: 'Runs one Android UI action exclusively through Appium UiAutomator2 in strict mode: tap, input, swipe, back, or wait. It observes the screen afterward and creates a mobile_device_state artifact.',
      input_schema: { type: 'object', properties: { session_id: { type: 'string' }, action: { type: 'string' }, target: { type: 'object' }, value: { type: 'string' }, expect: { type: 'object' }, expect_network: { type: 'array', items: { type: 'object' } }, timeout_ms: { type: 'number' }, ms: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, duration_ms: { type: 'number' } } },
      side_effects: ['performs Android UI action', 'creates mobile action record', 'creates mobile_device_state artifact'],
      handler: async (input, context) => {
        const sessionId = await resolveSessionId(context, input.session_id);
        const result = await runMobileAction(context.db, sessionId, input, context.repo, context.taskId);
        return { ok: result.ok === true, data: { session_id: sessionId, action: result.action, result: result.result, observation: result.observation ? { ...result.observation, screenshot_base64: result.observation.screenshot_base64 ? '[artifact]' : undefined } : null }, error: result.ok ? undefined : result.result?.error, summary: `${result.ok ? 'Completed' : 'Failed'} Android UI action ${input.action || input.type}.` };
      },
    },
    {
      name: 'mobile.flow.run',
      description: 'Tests the actual Android App through deterministic Appium UI actions plus same-step HTTPS request/response business assertions. Steps require UI expect, and at least one business action requires expect_network. UI-only success, intercepted traffic alone, and server-side replay are not App test completion.',
      input_schema: { type: 'object', properties: { session_id: { type: 'string' }, steps: { type: 'array', items: { type: 'object' } } } },
      side_effects: ['performs Android UI actions', 'creates mobile_device_state artifacts'],
      handler: async (input, context) => {
        const sessionId = await resolveSessionId(context, input.session_id);
        const cfg = await mobileConfig(context);
        const steps = Array.isArray(input.steps) ? input.steps : Array.isArray(cfg.flow_steps) ? cfg.flow_steps : [];
        const result = await runConfiguredMobileFlow(context.db, sessionId, steps, context.repo, context.taskId);
        await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'mobile_appium_test_result', title: 'Appium UI + HTTPS business test (cleanup still required)', content_json: { session_id: sessionId, result } });
        return { ok: result.ok === true, data: { session_id: sessionId, ...result }, error: result.ok ? undefined : 'Mobile flow did not satisfy all assertions.', summary: `${result.ok ? 'Completed' : 'Failed'} Android flow with ${result.steps_executed} steps.` };
      },
    },
    {
      name: 'mobile.capture.import',
      description: 'Reads verified HTTPS history from the session-owned proxy and imports only the current Appium run’s successfully asserted flows into BSTG recording_events, then regenerates API/Workflow drafts and discovered endpoints for native evidence-gated testing.',
      input_schema: { type: 'object', properties: { session_id: { type: 'string' }, export_path: { type: 'string' }, flows: { type: 'array', items: { type: 'object' } }, regenerate: { type: 'boolean' } } },
      side_effects: ['creates recording_session', 'creates recording_events', 'creates workflow/test-run drafts', 'upserts ai_discovered_endpoints'],
      handler: async (input, context) => {
        const sessionId = await resolveSessionId(context, input.session_id);
        const result = await exportAndImportMobileCapture(context.db, sessionId, { export_path: input.export_path ? String(input.export_path) : undefined, flows: Array.isArray(input.flows) ? input.flows : undefined, regenerate: input.regenerate !== false });
        await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'mobile_capture_import', title: 'Mobile Burp capture imported into BSTG recording', content_json: { session_id: sessionId, result } });
        return { ok: result.accepted_flows > 0 && result.verified_target_flows > 0, data: { session_id: sessionId, result }, summary: `Imported ${result.accepted_flows || 0} target-bound decrypted mobile flows into recording ${result.recording_session_id || 'n/a'}.` };
      },
    },
  ];
}
