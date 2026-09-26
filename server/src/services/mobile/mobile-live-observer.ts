import type { AIScanRepository } from '../ai-scan/repository.js';

export interface DeviceDisplayFrame {
  device_id: string;
  package: string;
  activity?: string;
  screenshot_base64: string;
  observed_at: string;
}

/** Read-only ADB display sampling runs independently of the Appium action queue.
 * These frames are for observation; they cannot satisfy UI/network assertions. */
export function startMobileLiveObserver(input: {
  repo: AIScanRepository; scanRunId: string; taskId?: string; operationId: string;
  sessionId: string; deviceId: string; appPackage: string; testKey?: string;
  sample: () => Promise<DeviceDisplayFrame>; intervalMs?: number;
}): () => Promise<void> {
  let stopped = false;
  let pending: Promise<void> | undefined;
  let last: DeviceDisplayFrame | undefined;
  const publish = async (frame: DeviceDisplayFrame, observing: boolean) => {
    await input.repo.upsertProductArtifact({
      scan_run_id: input.scanRunId, task_id: input.taskId, key: 'android-display',
      artifact_type: 'assessment_live_frame', content_text: frame.screenshot_base64,
      content_json: { surface: 'android', source: 'adb_display_observer', preview_only: true,
        evidence_level: 'device_observation', observing, operation_id: input.operationId,
        test_key: input.testKey, session_id: input.sessionId, device_id: frame.device_id,
        package: frame.package, activity: frame.activity, observed_at: frame.observed_at },
    });
  };
  function sample() {
    if (stopped || pending) return;
    pending = (async () => {
      try {
        const frame = await input.sample();
        if (stopped || frame.device_id !== input.deviceId || frame.package !== input.appPackage) return;
        await publish(frame, true);
        last = frame;
      } catch { /* Keep the last timestamp; a failing device must become stale, not fabricate frames. */ }
    })().finally(() => { pending = undefined; });
  }
  const timer = setInterval(sample, Math.max(250, input.intervalMs || 1000));
  timer.unref?.(); sample();
  return async () => {
    stopped = true; clearInterval(timer); await pending;
    if (last) await publish(last, false).catch(() => undefined);
  };
}
