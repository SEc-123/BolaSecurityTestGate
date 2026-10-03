import type { AgentToolSpec } from '../tool-types.js';
import { getLatestMobileSessionForScan } from '../../services/mobile/mobile-session-service.js';
import { androidBusinessStage, assertAndroidBusinessToolBoundary, isAndroidSurface, verifiedAndroidBusinessAssets } from '../../services/ai-scan/android-business-contract.js';

async function assets(context: any) {
  const run = await context.repo.getRun(context.scanRunId);
  if (!run || !isAndroidSurface(run)) throw new Error('Android business tools require an Android scan.');
  const task = context.taskId ? await context.repo.getTask(context.taskId) : undefined;
  const stage = task ? androidBusinessStage(task) : undefined;
  if (!stage) throw new Error('Android business tools require an Android business lifecycle task.');
  const session = await getLatestMobileSessionForScan(context.db, context.scanRunId);
  if (!session) throw new Error('Android business learning is blocked until a Mobile Lab session imports verified HTTPS traffic.');
  const [workflows, testRuns] = await Promise.all([context.db.repos.workflows.findAll(), context.db.repos.testRuns.findAll()]);
  return { run, stage, verified: verifiedAndroidBusinessAssets(run, { session, workflows, testRuns }) };
}

/** The lifecycle needs the raw session/workflow/run bindings locally to reject
 * receipt borrowing.  A model only needs the bounded proof counts; giving it
 * opaque database handles creates an unnecessary correlation surface. */
function privateReceiptAssets(value: ReturnType<typeof verifiedAndroidBusinessAssets>) {
  return { private: true, recording_session_id: value.recording_session_id, workflow_ids: value.workflow_ids,
    completed_test_run_ids: value.completed_test_run_ids, explicitly_decrypted_https_flows: value.explicitly_decrypted_https_flows,
    workflow_count: value.workflow_ids.length, completed_test_run_count: value.completed_test_run_ids.length,
    verified_decrypted_https: true };
}

function safeAssets(value: ReturnType<typeof verifiedAndroidBusinessAssets>) {
  return { workflow_count: value.workflow_ids.length, completed_test_run_count: value.completed_test_run_ids.length,
    explicitly_decrypted_https_flows: value.explicitly_decrypted_https_flows, verified_decrypted_https: true };
}

export function buildAndroidBusinessToolSpecs(): AgentToolSpec[] {
  return [
    { name: 'android.business.assets.inspect', description: 'Inspect only the current Android session-owned, Appium-asserted decrypted HTTPS import and its published native Workflow/Test Run assets. It never starts browser capture.',
      input_schema: { type: 'object', properties: {} }, side_effects: [], handler: async (_input, context) => {
        const current = await assets(context); assertAndroidBusinessToolBoundary(current.stage, 'android.business.assets.inspect');
        return { ok: true, data: safeAssets(current.verified), summary: `Verified Android capture assets: ${current.verified.workflow_ids.length} workflow(s), ${current.verified.completed_test_run_ids.length} completed native run(s).` };
      } },
    { name: 'android.business.normal.replay', description: 'Release the imported Android capture-replay Workflow as the native normal-flow evidence source. It requires verified Appium/decrypted HTTPS import and a completed native Test Run; it never calls Playwright.',
      input_schema: { type: 'object', properties: {} }, side_effects: ['creates Android normal-flow lifecycle receipt'], handler: async (_input, context) => {
        const current = await assets(context); assertAndroidBusinessToolBoundary(current.stage, 'android.business.normal.replay');
        if (!current.verified.completed_test_run_ids.length) throw new Error('Android normal replay is blocked until the imported Workflow has a completed native Test Run.');
        await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'android_business_normal_validation', title: 'Android native normal-flow validation', content_json: privateReceiptAssets(current.verified) });
        return { ok: true, data: safeAssets(current.verified), summary: 'Android normal-flow evidence is bound to verified HTTPS capture and a completed native Test Run.' };
      } },
    { name: 'android.business.experiment.ready', description: 'Verify that an Android experiment may be handed to the native generic vulnerability executor. Requires the imported HTTPS evidence and an Android normal-flow validation receipt; browser capture is prohibited.',
      input_schema: { type: 'object', properties: {} }, side_effects: ['creates Android experiment readiness receipt'], handler: async (_input, context) => {
        const current = await assets(context); assertAndroidBusinessToolBoundary(current.stage, 'android.business.experiment.ready');
        if (!current.verified.completed_test_run_ids.length) throw new Error('Android experiment is blocked until native normal replay succeeds.');
        const receipts = await context.repo.listArtifacts(context.scanRunId);
        if (!receipts.some((artifact: any) => artifact.artifact_type === 'android_business_normal_validation' &&
          String(artifact.content_json?.recording_session_id || '') === current.verified.recording_session_id &&
          Array.isArray(artifact.content_json?.workflow_ids) && artifact.content_json.workflow_ids.some((id: unknown) => current.verified.workflow_ids.includes(String(id))) &&
          Array.isArray(artifact.content_json?.completed_test_run_ids) && artifact.content_json.completed_test_run_ids.some((id: unknown) => current.verified.completed_test_run_ids.includes(String(id))))) {
          throw new Error('Android experiment is blocked until a current-session Android normal-flow validation receipt exists.');
        }
        await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: context.taskId, artifact_type: 'android_business_experiment_ready', title: 'Android native experiment readiness', content_json: privateReceiptAssets(current.verified) });
        return { ok: true, data: { ...safeAssets(current.verified), delegated_native_tool: 'bstg.generic_vuln.run_test' }, summary: 'Android experiment may now use the native captured-traffic executor.' };
      } },
  ];
}
