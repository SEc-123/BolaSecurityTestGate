package com.bstg.burp.recorder;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.function.Supplier;

public final class EventSenderWorker {
    private static final long INITIAL_BACKOFF_MILLIS = 1_000L;
    private static final long MAX_BACKOFF_MILLIS = 30_000L;

    private final EventQueue eventQueue;
    private final BstgApiClient apiClient;
    private final Supplier<SettingsStore.RecorderSettings> settingsSupplier;
    private final RecordingState recordingState;
    private final Runnable statusCallback;
    private final Consumer<String> logSink;
    private final ScheduledExecutorService executor;
    private final ReentrantLock flushLock = new ReentrantLock();
    private final AtomicBoolean started = new AtomicBoolean(false);

    private final int batchSize;
    private volatile long currentBackoffMillis = INITIAL_BACKOFF_MILLIS;
    private volatile long nextAllowedAttemptAt = 0L;

    public EventSenderWorker(
        EventQueue eventQueue,
        BstgApiClient apiClient,
        Supplier<SettingsStore.RecorderSettings> settingsSupplier,
        RecordingState recordingState,
        Runnable statusCallback,
        Consumer<String> logSink,
        int batchSize
    ) {
        this.eventQueue = eventQueue;
        this.apiClient = apiClient;
        this.settingsSupplier = settingsSupplier;
        this.recordingState = recordingState;
        this.statusCallback = statusCallback;
        this.logSink = logSink;
        this.batchSize = Math.max(1, batchSize);
        this.executor = Executors.newSingleThreadScheduledExecutor(new WorkerThreadFactory());
    }

    public void start() {
        if (!started.compareAndSet(false, true)) {
            return;
        }
        executor.scheduleWithFixedDelay(this::tick, 500L, 500L, TimeUnit.MILLISECONDS);
    }

    public void shutdown() {
        executor.shutdownNow();
    }

    public void flushNow() {
        executor.execute(() -> flushAvailable(true));
    }

    public void retryNow() {
        recordingState.markRetry();
        nextAllowedAttemptAt = 0L;
        executor.execute(() -> flushAvailable(true));
    }

    public boolean flushBlocking(Duration timeout) {
        long deadline = System.currentTimeMillis() + Math.max(1_000L, timeout.toMillis());
        while (System.currentTimeMillis() < deadline) {
            flushAvailable(true);
            if (eventQueue.isEmpty()) {
                return true;
            }
            sleep(Math.min(currentBackoffMillis, 1_000L));
        }
        return eventQueue.isEmpty();
    }

    private void tick() {
        if (eventQueue.isEmpty()) {
            return;
        }
        if (System.currentTimeMillis() < nextAllowedAttemptAt) {
            return;
        }
        flushAvailable(false);
    }

    private void flushAvailable(boolean manual) {
        if (!flushLock.tryLock()) {
            return;
        }
        try {
            while (!eventQueue.isEmpty()) {
                List<CapturedEvent> batch = eventQueue.pollBatch(batchSize);
                if (batch.isEmpty()) {
                    return;
                }

                try {
                    String sessionId = batch.get(0).sessionId();
                    apiClient.ingestBatch(settingsSupplier.get(), sessionId, batch);
                    recordingState.markUploadSuccess(batch.size());
                    recordingState.clearLastError();
                    currentBackoffMillis = INITIAL_BACKOFF_MILLIS;
                    nextAllowedAttemptAt = 0L;
                    statusCallback.run();
                } catch (Exception exception) {
                    eventQueue.requeueFront(batch);
                    recordingState.markBatchFailure(exception.getMessage());
                    currentBackoffMillis = Math.min(currentBackoffMillis * 2L, MAX_BACKOFF_MILLIS);
                    nextAllowedAttemptAt = System.currentTimeMillis() + currentBackoffMillis;
                    if (manual) {
                        logSink.accept("BSTG batch upload failed: " + exception.getMessage());
                    }
                    statusCallback.run();
                    return;
                }
            }
        } finally {
            flushLock.unlock();
        }
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private static final class WorkerThreadFactory implements ThreadFactory {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "bstg-recorder-sender");
            thread.setDaemon(true);
            return thread;
        }
    }
}
