interface FramePublisher {
  upsertProductArtifact(input: { scan_run_id: string; task_id?: string; key: string;
    artifact_type: 'assessment_live_frame'; content_text: string; content_json: Record<string, unknown> }): Promise<void>;
}

/** Read-only, bounded screenshot sampling. A failed viewer does not issue/retry business actions. */
export function startBrowserLiveObserver(input: {
  page: any; repo: FramePublisher; scanRunId: string; taskId?: string; intervalMs?: number;
}): () => Promise<void> {
  let stopped = false, inFlight: Promise<void> | null = null;
  let last: {image: string; observed_at: string} | null = null;
  async function sample(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = (async () => {
      try {
        const image: Buffer = await input.page.screenshot({ type: 'png', fullPage: false, timeout: 2500,
          mask: input.page.locator ? [input.page.locator('input[type="password"],input[autocomplete="one-time-code"],[data-sensitive]')] : [] });
        if (stopped || image.length > 8 * 1024 * 1024) return;
        last = {image: image.toString('base64'), observed_at: new Date().toISOString()};
        await input.repo.upsertProductArtifact({ scan_run_id: input.scanRunId, task_id: input.taskId, key: 'web',
          artifact_type: 'assessment_live_frame', content_text: last.image,
          content_json: { surface: 'web', observed_at: last.observed_at, source: 'playwright', observing: true } });
      } catch { /* Navigation/closed page: keep the last frame and let its timestamp become stale. */ }
    })();
    try { await inFlight; } finally { inFlight = null; }
  }
  const timer = setInterval(() => void sample(), Math.max(500, input.intervalMs || 1000));
  timer.unref?.(); void sample();
  return async () => {
    stopped = true; clearInterval(timer); await inFlight;
    if (last) try {
      await input.repo.upsertProductArtifact({scan_run_id:input.scanRunId, task_id:input.taskId, key:'web',
        artifact_type:'assessment_live_frame', content_text:last.image,
        content_json:{surface:'web',observed_at:last.observed_at,source:'playwright',observing:false}});
    } catch { /* Observer teardown must not replace the business execution result. */ }
  };
}
