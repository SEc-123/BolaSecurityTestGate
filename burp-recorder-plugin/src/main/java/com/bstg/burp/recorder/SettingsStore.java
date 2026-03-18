package com.bstg.burp.recorder;

import java.util.prefs.Preferences;

public final class SettingsStore {
    private static final String NODE = "com.bstg.burp.recorder";

    private static final String SERVER_URL = "serverUrl";
    private static final String API_KEY = "apiKey";
    private static final String MODE = "mode";
    private static final String INTENT = "intent";
    private static final String NAME = "name";
    private static final String ENVIRONMENT_ID = "environmentId";
    private static final String ACCOUNT_ID = "accountId";
    private static final String ROLE = "role";
    private static final String ACCOUNT_LABEL = "accountLabel";
    private static final String REQUESTED_FIELD_NAMES = "requestedFieldNames";
    private static final String CAPTURE_FILTERS = "captureFilters";
    private static final String TARGET_FIELDS = "targetFields";
    private static final String QUEUE_CAPACITY = "queueCapacity";
    private static final String BATCH_SIZE = "batchSize";

    private final Preferences preferences = Preferences.userRoot().node(NODE);

    public RecorderSettings load() {
        return new RecorderSettings(
            preferences.get(SERVER_URL, "http://127.0.0.1:3001"),
            preferences.get(API_KEY, ""),
            preferences.get(MODE, "workflow"),
            preferences.get(INTENT, "workflow_seed"),
            preferences.get(NAME, ""),
            preferences.get(ENVIRONMENT_ID, ""),
            preferences.get(ACCOUNT_ID, ""),
            preferences.get(ROLE, ""),
            preferences.get(ACCOUNT_LABEL, ""),
            preferences.get(REQUESTED_FIELD_NAMES, ""),
            preferences.get(CAPTURE_FILTERS, "prefer_json_api_responses,ignore_static_assets"),
            preferences.get(TARGET_FIELDS, ""),
            preferences.getInt(QUEUE_CAPACITY, 500),
            preferences.getInt(BATCH_SIZE, 10)
        );
    }

    public void save(RecorderSettings settings) {
        preferences.put(SERVER_URL, settings.serverUrl());
        preferences.put(API_KEY, settings.apiKey());
        preferences.put(MODE, settings.mode());
        preferences.put(INTENT, settings.intent());
        preferences.put(NAME, settings.name());
        preferences.put(ENVIRONMENT_ID, settings.environmentId());
        preferences.put(ACCOUNT_ID, settings.accountId());
        preferences.put(ROLE, settings.role());
        preferences.put(ACCOUNT_LABEL, settings.accountLabel());
        preferences.put(REQUESTED_FIELD_NAMES, settings.requestedFieldNames());
        preferences.put(CAPTURE_FILTERS, settings.captureFilters());
        preferences.put(TARGET_FIELDS, settings.targetFields());
        preferences.putInt(QUEUE_CAPACITY, Math.max(50, settings.queueCapacity()));
        preferences.putInt(BATCH_SIZE, Math.max(1, settings.batchSize()));
    }

    public record RecorderSettings(
        String serverUrl,
        String apiKey,
        String mode,
        String intent,
        String name,
        String environmentId,
        String accountId,
        String role,
        String accountLabel,
        String requestedFieldNames,
        String captureFilters,
        String targetFields,
        int queueCapacity,
        int batchSize
    ) {
        public RecorderSettings {
            serverUrl = serverUrl == null ? "" : serverUrl.trim();
            apiKey = apiKey == null ? "" : apiKey.trim();
            mode = mode == null || mode.isBlank() ? "workflow" : mode.trim();
            intent = intent == null || intent.isBlank() ? ("api".equals(mode) ? "api_test_seed" : "workflow_seed") : intent.trim();
            name = name == null ? "" : name.trim();
            environmentId = environmentId == null ? "" : environmentId.trim();
            accountId = accountId == null ? "" : accountId.trim();
            role = role == null ? "" : role.trim();
            accountLabel = accountLabel == null ? "" : accountLabel.trim();
            requestedFieldNames = requestedFieldNames == null ? "" : requestedFieldNames.trim();
            captureFilters = captureFilters == null ? "" : captureFilters.trim();
            targetFields = targetFields == null ? "" : targetFields;
            queueCapacity = Math.max(50, queueCapacity);
            batchSize = Math.max(1, batchSize);
        }
    }
}
