import type { AIScanArtifact, AIScanRun, AIScanTask } from './types.js';
import type { MobileSession } from '../mobile/mobile-types.js';
import type { Workflow, TestRun } from '../../types/index.js';

/**
 * Android business learning has a deliberately separate execution contract.
 * It begins after Appium has proved an App action and the session-owned proxy
 * has imported the resulting decrypted HTTPS traffic.  It must never borrow
 * the Web business-capture path: there is no Playwright recording context for
 * an Android App and a server-side HTTP replay alone is not App evidence.
 */
export const ANDROID_BUSINESS_PLAN_INTENT = 'plan_android_business_flows';
export const ANDROID_BUSINESS_LEARNING_INTENT = 'learn_android_business_flow';
export const ANDROID_BUSINESS_EXPERIMENT_INTENT = 'model_android_business_experiment';

export type AndroidBusinessStage = 'planning' | 'normal_replay' | 'experiment';

const STAGE_TOOLS: Record<AndroidBusinessStage, readonly string[]> = {
  planning: ['android.business.assets.inspect'],
  normal_replay: ['android.business.assets.inspect', 'android.business.normal.replay'],
  // The experiment is compiled and executed by the existing native mutation
  // executor.  The Android-specific stage only releases that executor after
  // the App capture + normal replay receipts are present.
  experiment: ['android.business.assets.inspect', 'android.business.experiment.ready', 'bstg.generic_vuln.run_test'],
};

export function isAndroidSurface(run: Pick<AIScanRun, 'scan_config'> | { scan_config?: any }): boolean {
  const config = run.scan_config || {};
  return [config.surface, config.surface_type, config.mobile?.platform, config.android?.platform].includes('android');
}

export function androidBusinessStage(task: Pick<AIScanTask, 'execution_plan' | 'task_type'>): AndroidBusinessStage | undefined {
  const intent = String(task.execution_plan?.intent || task.task_type || '');
  if (intent === ANDROID_BUSINESS_PLAN_INTENT) return 'planning';
  if (intent === ANDROID_BUSINESS_LEARNING_INTENT) return 'normal_replay';
  if (intent === ANDROID_BUSINESS_EXPERIMENT_INTENT) return 'experiment';
  return undefined;
}

export function androidBusinessAllowedTools(stage: AndroidBusinessStage): readonly string[] {
  return STAGE_TOOLS[stage];
}

/** The native generic executor remains the implementation for Android
 * experiments, but it is not itself a readiness proof. Gate it on the
 * server-created receipt for this exact Android lifecycle task so a model
 * cannot invoke the executor before android.business.experiment.ready. */
export function assertAndroidBusinessExperimentExecutorReady(
  task: Pick<AIScanTask, 'id' | 'execution_plan' | 'task_type'>,
  artifacts: AIScanArtifact[],
): void {
  if (androidBusinessStage(task) !== 'experiment') return;
  const ready = artifacts.some(artifact => artifact.task_id === task.id &&
    artifact.artifact_type === 'android_business_experiment_ready' &&
    typeof artifact.content_json?.recording_session_id === 'string' &&
    artifact.content_json.recording_session_id.length > 0 &&
    Array.isArray(artifact.content_json?.workflow_ids) && artifact.content_json.workflow_ids.length > 0 &&
    Array.isArray(artifact.content_json?.completed_test_run_ids) && artifact.content_json.completed_test_run_ids.length > 0);
  if (!ready) {
    throw new Error('Android generic execution requires the current task Android experiment-readiness receipt first.');
  }
}

/** Explicitly reject browser tools even if a caller accidentally combines
 * model scopes. This is a fail-closed guard at the Android stage boundary. */
export function assertAndroidBusinessToolBoundary(stage: AndroidBusinessStage, toolName: string): void {
  if (toolName.startsWith('browser.') || toolName.startsWith('bstg.business.capture.')) {
    throw new Error('Android business stages never use Web browser capture or Playwright tools.');
  }
  if (!androidBusinessAllowedTools(stage).includes(toolName)) {
    throw new Error(`Tool ${toolName} is not available in the Android ${stage} business stage.`);
  }
}

export interface AndroidBusinessAssets {
  session: MobileSession;
  workflows: Workflow[];
  testRuns: TestRun[];
}

export interface VerifiedAndroidBusinessAssets {
  recording_session_id: string;
  workflow_ids: string[];
  completed_test_run_ids: string[];
  explicitly_decrypted_https_flows: number;
}

function positive(value: unknown): boolean {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

/**
 * Require the same evidence properties that mobile import established.  An
 * emulator/profile declaration, an HTTPS-looking URL, an imported draft, or
 * an offline fixture are insufficient.  This leaves a missing device as a
 * blocked prerequisite rather than silently falling back to browser capture.
 */
export function verifiedAndroidBusinessAssets(run: Pick<AIScanRun, 'scan_config'>, assets: AndroidBusinessAssets): VerifiedAndroidBusinessAssets {
  if (!isAndroidSurface(run)) throw new Error('Android business assets require an Android scan surface.');
  const session = assets.session;
  const imported = session.health_json?.capture_import?.result;
  const contract = imported?.target_contract;
  if (session.capture_status !== 'imported' || !session.recording_session_id || !imported) {
    throw new Error('Android business learning requires a session-owned imported mobile capture.');
  }
  if (imported.evidence_level !== 'session_bound_device_capture' || contract?.require_explicit_tls_evidence !== true ||
      !positive(imported.verified_target_flows) || !positive(imported.explicitly_decrypted_https_flows)) {
    throw new Error('Android business learning requires verified decrypted HTTPS evidence from the current Appium session.');
  }
  const workflows = assets.workflows.filter(workflow => workflow.source_recording_session_id === session.recording_session_id &&
    workflow.baseline_config?.capture_replay_only === true);
  if (!workflows.length) throw new Error('Android business learning requires a published capture-replay Workflow from the imported mobile recording.');
  const workflowIds = new Set(workflows.map(workflow => workflow.id));
  const completed = assets.testRuns.filter(testRun => workflowIds.has(String(testRun.workflow_id || '')) &&
    testRun.source_recording_session_id === session.recording_session_id && testRun.status === 'completed' && testRun.has_execution_error !== true);
  return {
    recording_session_id: session.recording_session_id,
    workflow_ids: workflows.map(workflow => workflow.id).sort(),
    completed_test_run_ids: completed.map(testRun => testRun.id).sort(),
    explicitly_decrypted_https_flows: Number(imported.explicitly_decrypted_https_flows),
  };
}
