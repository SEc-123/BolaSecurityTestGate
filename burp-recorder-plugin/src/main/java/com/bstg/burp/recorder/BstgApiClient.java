package com.bstg.burp.recorder;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class BstgApiClient {
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(20);

    private final HttpClient httpClient;
    private final Gson gson;

    public BstgApiClient() {
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(REQUEST_TIMEOUT)
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();
        this.gson = new Gson();
    }

    public ConnectionResult testConnection(SettingsStore.RecorderSettings settings) throws IOException, InterruptedException {
        JsonObject root = send(
            settings.serverUrl(),
            settings.apiKey(),
            "/api/recordings/health",
            "GET",
            null
        );
        JsonObject data = root.getAsJsonObject("data");
        String status = getString(data, "status", "ok");
        return new ConnectionResult(status, getString(data, "error", ""));
    }

    public CreateSessionResult createSession(SettingsStore.RecorderSettings settings, CreateSessionInput input) throws IOException, InterruptedException {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", input.name());
        payload.put("mode", input.mode());
        payload.put("source_tool", input.sourceTool());
        if (!input.environmentId().isBlank()) {
            payload.put("environment_id", input.environmentId());
        }
        if (!input.accountId().isBlank()) {
            payload.put("account_id", input.accountId());
        }
        if (!input.role().isBlank()) {
            payload.put("role", input.role());
        }
        if (!input.targetFields().isEmpty()) {
            payload.put("target_fields", input.targetFields());
        }

        JsonObject root = send(
            settings.serverUrl(),
            settings.apiKey(),
            "/api/recordings/sessions",
            "POST",
            gson.toJson(payload)
        );
        JsonObject data = root.getAsJsonObject("data");
        return new CreateSessionResult(
            getString(data, "id", ""),
            getString(data, "name", input.name()),
            getString(data, "mode", input.mode())
        );
    }

    public void ingestBatch(SettingsStore.RecorderSettings settings, String sessionId, List<CapturedEvent> batch) throws IOException, InterruptedException {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("events", batch.stream().map(CapturedEvent::toApiMap).toList());
        send(
            settings.serverUrl(),
            settings.apiKey(),
            "/api/recordings/sessions/" + encode(sessionId) + "/events/batch",
            "POST",
            gson.toJson(payload)
        );
    }

    public FinishResult finishSession(SettingsStore.RecorderSettings settings, String sessionId) throws IOException, InterruptedException {
        JsonObject root = send(
            settings.serverUrl(),
            settings.apiKey(),
            "/api/recordings/sessions/" + encode(sessionId) + "/finish",
            "POST",
            "{}"
        );
        JsonObject data = root.getAsJsonObject("data");
        JsonObject session = data != null && data.has("session") ? data.getAsJsonObject("session") : new JsonObject();
        String summary = session.has("summary") ? session.get("summary").toString() : "";
        return new FinishResult(
            getString(session, "id", sessionId),
            getString(session, "status", "finished"),
            summary
        );
    }

    private JsonObject send(String serverUrl, String apiKey, String path, String method, String body)
        throws IOException, InterruptedException {
        String baseUrl = normalizeBaseUrl(serverUrl);
        HttpRequest.Builder builder = HttpRequest.newBuilder()
            .uri(URI.create(baseUrl + path))
            .timeout(REQUEST_TIMEOUT)
            .header("Accept", "application/json")
            .header("X-Client-Info", "bstg-burp-recorder/1.0");

        if (apiKey != null && !apiKey.isBlank()) {
            builder.header("X-API-Key", apiKey);
        }

        if ("POST".equalsIgnoreCase(method)) {
            builder.header("Content-Type", "application/json");
            builder.POST(HttpRequest.BodyPublishers.ofString(body == null ? "{}" : body));
        } else {
            builder.GET();
        }

        HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonObject root = parseRoot(response.body());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IOException(extractError(root, response.statusCode()));
        }

        JsonElement errorElement = root.get("error");
        if (errorElement != null && !errorElement.isJsonNull()) {
            String errorText = errorElement.getAsString();
            if (!errorText.isBlank()) {
                throw new IOException(errorText);
            }
        }
        return root;
    }

    private JsonObject parseRoot(String body) throws IOException {
        try {
            JsonElement parsed = JsonParser.parseString(body == null || body.isBlank() ? "{}" : body);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : new JsonObject();
        } catch (Exception exception) {
            throw new IOException("BSTG server returned invalid JSON: " + exception.getMessage(), exception);
        }
    }

    private String extractError(JsonObject root, int statusCode) {
        if (root.has("error") && !root.get("error").isJsonNull()) {
            String error = root.get("error").getAsString();
            if (!error.isBlank()) {
                return error;
            }
        }
        return "BSTG request failed with HTTP " + statusCode;
    }

    private String normalizeBaseUrl(String serverUrl) {
        String trimmed = serverUrl == null ? "" : serverUrl.trim();
        if (trimmed.isBlank()) {
            throw new IllegalArgumentException("BSTG server URL is required");
        }
        return trimmed.endsWith("/") ? trimmed.substring(0, trimmed.length() - 1) : trimmed;
    }

    private String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private String getString(JsonObject object, String key, String defaultValue) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return defaultValue;
        }
        return object.get(key).getAsString();
    }

    public record ConnectionResult(String status, String message) {
    }

    public record CreateSessionResult(String sessionId, String sessionName, String mode) {
    }

    public record FinishResult(String sessionId, String status, String summary) {
    }

    public record CreateSessionInput(
        String name,
        String mode,
        String sourceTool,
        String environmentId,
        String accountId,
        String role,
        List<Map<String, Object>> targetFields
    ) {
    }
}
