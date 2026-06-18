package com.bstg.burp.recorder;

import java.time.Instant;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

public final class RecordingState {
    private final AtomicBoolean acceptingEvents = new AtomicBoolean(false);
    private final AtomicLong sequence = new AtomicLong(0);
    private final AtomicLong uploadedEvents = new AtomicLong(0);
    private final AtomicLong failedBatches = new AtomicLong(0);
    private final AtomicLong retriedBatches = new AtomicLong(0);
    private final AtomicLong droppedEvents = new AtomicLong(0);

    private volatile String sessionId;
    private volatile String sessionName;
    private volatile String mode;
    private volatile String startedAt;
    private volatile String lastError;
    private volatile String lastResultMessage;

    public synchronized void start(String newSessionId, String newSessionName, String newMode) {
        sessionId = newSessionId;
        sessionName = newSessionName;
        mode = newMode;
        startedAt = Instant.now().toString();
        lastError = null;
        lastResultMessage = null;
        sequence.set(0);
        uploadedEvents.set(0);
        failedBatches.set(0);
        retriedBatches.set(0);
        droppedEvents.set(0);
        acceptingEvents.set(true);
    }

    public synchronized void stopAcceptingEvents() {
        acceptingEvents.set(false);
    }

    public synchronized void finish(String resultMessage) {
        acceptingEvents.set(false);
        lastResultMessage = resultMessage;
        sessionId = null;
        sessionName = null;
        mode = null;
    }

    public synchronized void resetAfterClear() {
        lastError = null;
        lastResultMessage = "Local queue cleared";
        uploadedEvents.set(0);
        failedBatches.set(0);
        retriedBatches.set(0);
        droppedEvents.set(0);
    }

    public boolean isAcceptingEvents() {
        return acceptingEvents.get();
    }

    public boolean hasActiveSession() {
        return sessionId != null && !sessionId.isBlank();
    }

    public String sessionId() {
        return sessionId;
    }

    public long nextSequence() {
        return sequence.incrementAndGet();
    }

    public void markUploadSuccess(int count) {
        uploadedEvents.addAndGet(Math.max(0, count));
        lastError = null;
    }

    public void markRetry() {
        retriedBatches.incrementAndGet();
    }

    public void markBatchFailure(String error) {
        failedBatches.incrementAndGet();
        lastError = error;
    }

    public void markDropped(long droppedCount) {
        droppedEvents.addAndGet(Math.max(0, droppedCount));
    }

    public void clearLastError() {
        lastError = null;
    }

    public void setLastError(String error) {
        lastError = error;
    }

    public void setLastResultMessage(String resultMessage) {
        lastResultMessage = resultMessage;
    }

    public Snapshot snapshot() {
        return new Snapshot(
            hasActiveSession(),
            acceptingEvents.get(),
            sessionId,
            sessionName,
            mode,
            startedAt,
            uploadedEvents.get(),
            failedBatches.get(),
            retriedBatches.get(),
            droppedEvents.get(),
            lastError,
            lastResultMessage
        );
    }

    public record Snapshot(
        boolean hasActiveSession,
        boolean acceptingEvents,
        String sessionId,
        String sessionName,
        String mode,
        String startedAt,
        long uploadedEvents,
        long failedBatches,
        long retriedBatches,
        long droppedEvents,
        String lastError,
        String lastResultMessage
    ) {
    }
}
