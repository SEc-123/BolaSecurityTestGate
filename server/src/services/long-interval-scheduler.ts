const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface LongIntervalScheduler {
  start(intervalMs: number): void;
  updateInterval(intervalMs: number): void;
  stop(): void;
}

function normalizeInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`Invalid scheduler interval: ${intervalMs}`);
  }

  return Math.floor(intervalMs);
}

export function createLongIntervalScheduler(task: () => Promise<void> | void): LongIntervalScheduler {
  let timer: NodeJS.Timeout | null = null;
  let active = false;
  let intervalMs = 0;
  let remainingMs = 0;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number) => {
    if (!active) {
      return;
    }

    const chunkMs = Math.min(delayMs, MAX_TIMER_DELAY_MS);
    remainingMs = delayMs - chunkMs;
    timer = setTimeout(async () => {
      if (!active) {
        return;
      }

      if (remainingMs > 0) {
        const nextDelay = remainingMs;
        remainingMs = 0;
        schedule(nextDelay);
        return;
      }

      try {
        await task();
      } finally {
        schedule(intervalMs);
      }
    }, chunkMs);
  };

  const restart = (nextIntervalMs: number) => {
    intervalMs = normalizeInterval(nextIntervalMs);
    active = true;
    remainingMs = 0;
    clearTimer();
    schedule(intervalMs);
  };

  return {
    start(nextIntervalMs: number) {
      restart(nextIntervalMs);
    },
    updateInterval(nextIntervalMs: number) {
      restart(nextIntervalMs);
    },
    stop() {
      active = false;
      remainingMs = 0;
      clearTimer();
    },
  };
}
