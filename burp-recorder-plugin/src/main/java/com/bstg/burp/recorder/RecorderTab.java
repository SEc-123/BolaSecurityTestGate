package com.bstg.burp.recorder;

import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.GridBagConstraints;
import java.awt.GridBagLayout;
import java.awt.Insets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JPasswordField;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.SwingUtilities;
import javax.swing.SwingWorker;
import javax.swing.Timer;

public final class RecorderTab {
    private final SettingsStore settingsStore;
    private final RecordingState recordingState;
    private final EventQueue eventQueue;
    private final BstgApiClient apiClient;
    private final Consumer<String> logSink;

    private final JPanel rootPanel = new JPanel(new BorderLayout(12, 12));
    private final JTextField serverUrlField = new JTextField();
    private final JPasswordField apiKeyField = new JPasswordField();
    private final JComboBox<String> modeCombo = new JComboBox<>(new String[] {"workflow", "api"});
    private final JComboBox<String> intentCombo = new JComboBox<>(new String[] {"account_capture", "api_test_seed", "workflow_seed", "learning_seed"});
    private final JTextField nameField = new JTextField();
    private final JTextField environmentIdField = new JTextField();
    private final JTextField accountIdField = new JTextField();
    private final JTextField roleField = new JTextField();
    private final JTextField accountLabelField = new JTextField();
    private final JTextField requestedFieldsField = new JTextField();
    private final JTextField captureFiltersField = new JTextField();
    private final JTextArea targetFieldsArea = new JTextArea(7, 40);

    private final JLabel sessionValue = new JLabel("-");
    private final JLabel queueValue = new JLabel("0");
    private final JLabel uploadedValue = new JLabel("0");
    private final JLabel failedValue = new JLabel("0");
    private final JLabel retriedValue = new JLabel("0");
    private final JLabel droppedValue = new JLabel("0");
    private final JLabel activeValue = new JLabel("idle");
    private final JTextArea messageArea = new JTextArea(6, 40);

    private final JButton testConnectionButton = new JButton("Test Connection");
    private final JButton startButton = new JButton("Start Recording");
    private final JButton stopButton = new JButton("Stop Recording");
    private final JButton flushButton = new JButton("Flush");
    private final JButton retryButton = new JButton("Retry");
    private final JButton clearButton = new JButton("Clear Cache");

    private EventSenderWorker eventSenderWorker;

    public RecorderTab(
        SettingsStore settingsStore,
        RecordingState recordingState,
        EventQueue eventQueue,
        BstgApiClient apiClient,
        Consumer<String> logSink
    ) {
        this.settingsStore = settingsStore;
        this.recordingState = recordingState;
        this.eventQueue = eventQueue;
        this.apiClient = apiClient;
        this.logSink = logSink;

        buildUi();
        loadSettings();
        bindActions();
        refreshStatus();

        Timer timer = new Timer(500, event -> refreshStatus());
        timer.start();
    }

    public void attachWorker(EventSenderWorker worker) {
        this.eventSenderWorker = worker;
    }

    public Component getComponent() {
        return rootPanel;
    }

    public void refreshStatus() {
        SwingUtilities.invokeLater(() -> {
            RecordingState.Snapshot snapshot = recordingState.snapshot();
            sessionValue.setText(snapshot.sessionId() == null ? "-" : snapshot.sessionId());
            queueValue.setText(String.valueOf(eventQueue.size()));
            uploadedValue.setText(String.valueOf(snapshot.uploadedEvents()));
            failedValue.setText(String.valueOf(snapshot.failedBatches()));
            retriedValue.setText(String.valueOf(snapshot.retriedBatches()));
            droppedValue.setText(String.valueOf(snapshot.droppedEvents()));
            activeValue.setText(snapshot.acceptingEvents() ? "recording" : (snapshot.hasActiveSession() ? "pending-finish" : "idle"));

            StringBuilder message = new StringBuilder();
            if (snapshot.startedAt() != null && snapshot.hasActiveSession()) {
                message.append("Started: ").append(snapshot.startedAt()).append('\n');
            }
            if (snapshot.lastResultMessage() != null && !snapshot.lastResultMessage().isBlank()) {
                message.append(snapshot.lastResultMessage()).append('\n');
            }
            if (snapshot.lastError() != null && !snapshot.lastError().isBlank()) {
                message.append("Last error: ").append(snapshot.lastError());
            }
            messageArea.setText(message.toString().trim());
        });
    }

    private void buildUi() {
        rootPanel.setBorder(BorderFactory.createEmptyBorder(12, 12, 12, 12));

        JPanel formPanel = new JPanel(new GridBagLayout());
        formPanel.setBorder(BorderFactory.createTitledBorder("BSTG Recorder"));
        GridBagConstraints constraints = baseConstraints();

        addField(formPanel, constraints, 0, "Server URL", serverUrlField);
        addField(formPanel, constraints, 1, "API Key", apiKeyField);
        addField(formPanel, constraints, 2, "Recording Intent", intentCombo);
        addField(formPanel, constraints, 3, "Mode", modeCombo);
        addField(formPanel, constraints, 4, "Session Name", nameField);
        addField(formPanel, constraints, 5, "Environment Hint (optional)", environmentIdField);
        addField(formPanel, constraints, 6, "Account Hint (optional)", accountIdField);
        addField(formPanel, constraints, 7, "Role Hint (optional)", roleField);
        addField(formPanel, constraints, 8, "Account Label (optional)", accountLabelField);
        addField(formPanel, constraints, 9, "Requested Field Names (optional)", requestedFieldsField);
        addField(formPanel, constraints, 10, "Capture Filters (optional)", captureFiltersField);

        targetFieldsArea.setLineWrap(true);
        targetFieldsArea.setWrapStyleWord(true);
        JScrollPane targetScroll = new JScrollPane(targetFieldsArea);
        targetScroll.setPreferredSize(new Dimension(420, 120));
        addField(formPanel, constraints, 12, "Target Fields", targetScroll);

        JLabel helpLabel = new JLabel("Target fields are optional. Format: name|alias1,alias2|request.header,response.body|bind_to_account_field|category");
        constraints.gridx = 1;
        constraints.gridy = 11;
        constraints.gridwidth = 2;
        constraints.weightx = 1.0;
        constraints.fill = GridBagConstraints.HORIZONTAL;
        formPanel.add(helpLabel, constraints);

        JPanel actionPanel = new JPanel(new GridBagLayout());
        actionPanel.setBorder(BorderFactory.createTitledBorder("Actions"));
        GridBagConstraints actionConstraints = baseConstraints();
        addButton(actionPanel, actionConstraints, 0, testConnectionButton);
        addButton(actionPanel, actionConstraints, 1, startButton);
        addButton(actionPanel, actionConstraints, 2, stopButton);
        addButton(actionPanel, actionConstraints, 3, flushButton);
        addButton(actionPanel, actionConstraints, 4, retryButton);
        addButton(actionPanel, actionConstraints, 5, clearButton);

        JPanel statusPanel = new JPanel(new GridBagLayout());
        statusPanel.setBorder(BorderFactory.createTitledBorder("Status"));
        GridBagConstraints statusConstraints = baseConstraints();
        addField(statusPanel, statusConstraints, 0, "Session", sessionValue);
        addField(statusPanel, statusConstraints, 1, "State", activeValue);
        addField(statusPanel, statusConstraints, 2, "Queue", queueValue);
        addField(statusPanel, statusConstraints, 3, "Uploaded", uploadedValue);
        addField(statusPanel, statusConstraints, 4, "Failed Batches", failedValue);
        addField(statusPanel, statusConstraints, 5, "Retried", retriedValue);
        addField(statusPanel, statusConstraints, 6, "Dropped", droppedValue);

        messageArea.setEditable(false);
        messageArea.setLineWrap(true);
        messageArea.setWrapStyleWord(true);
        JScrollPane messageScroll = new JScrollPane(messageArea);
        messageScroll.setBorder(BorderFactory.createTitledBorder("Messages"));

        JPanel centerPanel = new JPanel(new BorderLayout(12, 12));
        centerPanel.add(formPanel, BorderLayout.NORTH);
        centerPanel.add(statusPanel, BorderLayout.CENTER);
        centerPanel.add(actionPanel, BorderLayout.SOUTH);

        rootPanel.add(centerPanel, BorderLayout.NORTH);
        rootPanel.add(messageScroll, BorderLayout.CENTER);
    }

    private void bindActions() {
        testConnectionButton.addActionListener(event -> handleTestConnection());
        startButton.addActionListener(event -> handleStartRecording());
        stopButton.addActionListener(event -> handleStopRecording());
        flushButton.addActionListener(event -> handleFlush(false));
        retryButton.addActionListener(event -> handleFlush(true));
        clearButton.addActionListener(event -> handleClearCache());
    }

    private void handleTestConnection() {
        SettingsStore.RecorderSettings settings = collectSettings();
        settingsStore.save(settings);
        runAsync(
            () -> apiClient.testConnection(settings),
            result -> {
                recordingState.setLastResultMessage("Connection OK: " + result.status());
                refreshStatus();
            },
            "Connection test failed"
        );
    }

    private void handleStartRecording() {
        if (recordingState.hasActiveSession()) {
            showWarning("A recording session is already active or waiting to finish.");
            return;
        }
        if (!eventQueue.isEmpty()) {
            showWarning("Local queue still has unsent events. Flush or clear cache before starting a new session.");
            return;
        }

        SettingsStore.RecorderSettings settings = collectSettings();
        if (settings.serverUrl().isBlank() || settings.name().isBlank()) {
            showWarning("Server URL and Session Name are required. Environment and Account are optional hints.");
            return;
        }

        settingsStore.save(settings);
        BstgApiClient.CreateSessionInput input = new BstgApiClient.CreateSessionInput(
            settings.name(),
            settings.mode(),
            "proxy",
            settings.intent(),
            settings.environmentId(),
            settings.accountId(),
            settings.role(),
            settings.accountLabel(),
            settings.requestedFieldNames(),
            settings.captureFilters(),
            parseTargetFields(settings.targetFields())
        );

        runAsync(
            () -> apiClient.createSession(settings, input),
            result -> {
                recordingState.start(result.sessionId(), result.sessionName(), result.mode());
                recordingState.setLastResultMessage("Recording started for session " + result.sessionId());
                refreshStatus();
            },
            "Failed to create recording session"
        );
    }

    private void handleStopRecording() {
        if (!recordingState.hasActiveSession()) {
            showWarning("No active recording session to stop.");
            return;
        }
        if (eventSenderWorker == null) {
            showWarning("Background sender is not ready yet.");
            return;
        }

        recordingState.stopAcceptingEvents();
        refreshStatus();

        String sessionId = recordingState.sessionId();
        SettingsStore.RecorderSettings settings = collectSettings();
        settingsStore.save(settings);

        runAsync(
            () -> {
                boolean flushed = eventSenderWorker.flushBlocking(Duration.ofSeconds(12));
                if (!flushed) {
                    throw new IllegalStateException("Some events are still queued. Use Retry or Flush again before finishing.");
                }
                return apiClient.finishSession(settings, sessionId);
            },
            result -> {
                recordingState.finish("Recording finished: " + result.status() + " (" + result.sessionId() + ")");
                refreshStatus();
            },
            "Failed to finish recording session"
        );
    }

    private void handleFlush(boolean retryMode) {
        if (eventSenderWorker == null) {
            showWarning("Background sender is not ready yet.");
            return;
        }

        if (retryMode) {
            eventSenderWorker.retryNow();
        } else {
            eventSenderWorker.flushNow();
        }
        recordingState.setLastResultMessage(retryMode ? "Manual retry requested" : "Manual flush requested");
        refreshStatus();
    }

    private void handleClearCache() {
        if (recordingState.hasActiveSession() && recordingState.isAcceptingEvents()) {
            showWarning("Stop recording before clearing the local queue.");
            return;
        }

        eventQueue.clear();
        recordingState.resetAfterClear();
        refreshStatus();
    }

    private SettingsStore.RecorderSettings collectSettings() {
        SettingsStore.RecorderSettings current = settingsStore.load();
        return new SettingsStore.RecorderSettings(
            serverUrlField.getText(),
            new String(apiKeyField.getPassword()),
            String.valueOf(modeCombo.getSelectedItem()),
            String.valueOf(intentCombo.getSelectedItem()),
            nameField.getText(),
            environmentIdField.getText(),
            accountIdField.getText(),
            roleField.getText(),
            accountLabelField.getText(),
            requestedFieldsField.getText(),
            captureFiltersField.getText(),
            targetFieldsArea.getText(),
            current.queueCapacity(),
            current.batchSize()
        );
    }

    private void loadSettings() {
        SettingsStore.RecorderSettings settings = settingsStore.load();
        serverUrlField.setText(settings.serverUrl());
        apiKeyField.setText(settings.apiKey());
        modeCombo.setSelectedItem(settings.mode());
        intentCombo.setSelectedItem(settings.intent());
        nameField.setText(settings.name());
        environmentIdField.setText(settings.environmentId());
        accountIdField.setText(settings.accountId());
        roleField.setText(settings.role());
        accountLabelField.setText(settings.accountLabel());
        requestedFieldsField.setText(settings.requestedFieldNames());
        captureFiltersField.setText(settings.captureFilters());
        targetFieldsArea.setText(settings.targetFields());
    }

    private List<Map<String, Object>> parseTargetFields(String rawText) {
        List<Map<String, Object>> items = new ArrayList<>();
        for (String rawLine : rawText.split("\\R")) {
            String line = rawLine.trim();
            if (line.isBlank()) {
                continue;
            }

            String[] parts = line.split("\\|", -1);
            Map<String, Object> target = new LinkedHashMap<>();
            target.put("name", parts[0].trim());

            if (parts.length > 1 && !parts[1].isBlank()) {
                target.put("aliases", splitCsv(parts[1]));
            }
            if (parts.length > 2 && !parts[2].isBlank()) {
                target.put("from_sources", splitCsv(parts[2]));
            }
            if (parts.length > 3 && !parts[3].isBlank()) {
                target.put("bind_to_account_field", parts[3].trim());
            }
            if (parts.length > 4 && !parts[4].isBlank()) {
                target.put("category", parts[4].trim());
            }

            items.add(target);
        }
        return items;
    }

    private List<String> splitCsv(String value) {
        List<String> items = new ArrayList<>();
        for (String item : value.split(",")) {
            String trimmed = item.trim();
            if (!trimmed.isBlank()) {
                items.add(trimmed);
            }
        }
        return items;
    }

    private void showWarning(String message) {
        JOptionPane.showMessageDialog(rootPanel, message, "BSTG Recorder", JOptionPane.WARNING_MESSAGE);
    }

    private <T> void runAsync(ThrowingSupplier<T> supplier, Consumer<T> onSuccess, String errorPrefix) {
        new SwingWorker<T, Void>() {
            @Override
            protected T doInBackground() throws Exception {
                return supplier.get();
            }

            @Override
            protected void done() {
                try {
                    T result = get();
                    onSuccess.accept(result);
                } catch (Exception exception) {
                    Throwable cause = exception.getCause() == null ? exception : exception.getCause();
                    recordingState.setLastError(cause.getMessage());
                    logSink.accept(errorPrefix + ": " + cause.getMessage());
                    refreshStatus();
                    JOptionPane.showMessageDialog(rootPanel, errorPrefix + ": " + cause.getMessage(), "BSTG Recorder", JOptionPane.ERROR_MESSAGE);
                }
            }
        }.execute();
    }

    private GridBagConstraints baseConstraints() {
        GridBagConstraints constraints = new GridBagConstraints();
        constraints.insets = new Insets(4, 4, 4, 4);
        constraints.anchor = GridBagConstraints.WEST;
        constraints.fill = GridBagConstraints.HORIZONTAL;
        return constraints;
    }

    private void addField(JPanel panel, GridBagConstraints base, int row, String label, Component component) {
        GridBagConstraints left = (GridBagConstraints) base.clone();
        left.gridx = 0;
        left.gridy = row;
        left.weightx = 0;
        left.gridwidth = 1;
        panel.add(new JLabel(label), left);

        GridBagConstraints right = (GridBagConstraints) base.clone();
        right.gridx = 1;
        right.gridy = row;
        right.weightx = 1.0;
        right.gridwidth = 2;
        panel.add(wrapComponent(component), right);
    }

    private void addButton(JPanel panel, GridBagConstraints base, int index, JButton button) {
        GridBagConstraints constraints = (GridBagConstraints) base.clone();
        constraints.gridx = index % 3;
        constraints.gridy = index / 3;
        constraints.weightx = 1.0;
        constraints.fill = GridBagConstraints.HORIZONTAL;
        panel.add(button, constraints);
    }

    private JComponent wrapComponent(Component component) {
        if (component instanceof JComponent jComponent) {
            return jComponent;
        }
        JPanel wrapper = new JPanel(new BorderLayout());
        wrapper.add(component, BorderLayout.CENTER);
        return wrapper;
    }

    @FunctionalInterface
    private interface ThrowingSupplier<T> {
        T get() throws Exception;
    }
}
