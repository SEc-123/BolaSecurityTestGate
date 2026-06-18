package com.bstg.burp.recorder;

import burp.api.montoya.BurpExtension;
import burp.api.montoya.MontoyaApi;
import burp.api.montoya.proxy.http.InterceptedResponse;
import burp.api.montoya.proxy.http.ProxyResponseHandler;
import burp.api.montoya.proxy.http.ProxyResponseReceivedAction;
import burp.api.montoya.proxy.http.ProxyResponseToBeSentAction;

public final class BstgExtension implements BurpExtension, ProxyResponseHandler {
    private MontoyaApi api;
    private EventSenderWorker eventSenderWorker;
    private RecorderTab recorderTab;
    private final CapturedEventFactory capturedEventFactory = new CapturedEventFactory();
    private final BstgApiClient apiClient = new BstgApiClient();
    private final SettingsStore settingsStore = new SettingsStore();
    private final PendingQueueStore pendingQueueStore = new PendingQueueStore();
    private final RecordingState recordingState = new RecordingState();
    private EventQueue eventQueue;

    @Override
    public void initialize(MontoyaApi montoyaApi) {
        this.api = montoyaApi;
        api.extension().setName("BSTG Recorder");

        SettingsStore.RecorderSettings settings = settingsStore.load();
        var pendingEvents = pendingQueueStore.load();
        this.eventQueue = new EventQueue(settings.queueCapacity(), pendingEvents, pendingQueueStore);
        this.recorderTab = new RecorderTab(
            settingsStore,
            recordingState,
            eventQueue,
            apiClient,
            this::logError
        );
        this.eventSenderWorker = new EventSenderWorker(
            eventQueue,
            apiClient,
            settingsStore::load,
            recordingState,
            recorderTab::refreshStatus,
            this::logError,
            settings.batchSize()
        );
        recorderTab.attachWorker(eventSenderWorker);
        eventSenderWorker.start();

        api.userInterface().registerSuiteTab("BSTG Recorder", recorderTab.getComponent());
        api.proxy().registerResponseHandler(this);
        api.extension().registerUnloadingHandler(this::shutdown);

        if (!pendingEvents.isEmpty()) {
            recordingState.setLastResultMessage("Restored " + pendingEvents.size() + " unsent events from local cache.");
        }
        logOutput("BSTG Recorder initialized");
    }

    @Override
    public ProxyResponseReceivedAction handleResponseReceived(InterceptedResponse interceptedResponse) {
        try {
            if (!recordingState.isAcceptingEvents() || !recordingState.hasActiveSession()) {
                return ProxyResponseReceivedAction.continueWith(interceptedResponse);
            }

            CapturedEvent capturedEvent = capturedEventFactory.fromResponse(
                recordingState.sessionId(),
                recordingState.nextSequence(),
                interceptedResponse
            );
            EventQueue.QueueOfferResult result = eventQueue.offer(capturedEvent);
            if (result.droppedCount() > 0) {
                recordingState.markDropped(result.droppedCount());
                recordingState.setLastResultMessage("Queue reached capacity. Oldest events were dropped to keep Burp responsive.");
            }
            recorderTab.refreshStatus();
        } catch (Exception exception) {
            logError("Failed to capture Burp response: " + exception.getMessage());
        }
        return ProxyResponseReceivedAction.continueWith(interceptedResponse);
    }

    @Override
    public ProxyResponseToBeSentAction handleResponseToBeSent(InterceptedResponse interceptedResponse) {
        return ProxyResponseToBeSentAction.continueWith(interceptedResponse);
    }

    private void shutdown() {
        if (eventSenderWorker != null) {
            eventSenderWorker.shutdown();
        }
        logOutput("BSTG Recorder unloaded");
    }

    private void logOutput(String message) {
        if (api != null) {
            api.logging().logToOutput(message);
        }
    }

    private void logError(String message) {
        if (api != null) {
            api.logging().logToError(message);
        }
    }
}
