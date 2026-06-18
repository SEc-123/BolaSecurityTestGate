package com.bstg.burp.recorder;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

public record CapturedEvent(
    String sessionId,
    long sequence,
    String sourceTool,
    String method,
    String url,
    Map<String, String> requestHeaders,
    String requestBodyText,
    int responseStatus,
    Map<String, String> responseHeaders,
    String responseBodyText
) {
    public CapturedEvent {
        requestHeaders = Collections.unmodifiableMap(new LinkedHashMap<>(requestHeaders == null ? Map.of() : requestHeaders));
        responseHeaders = Collections.unmodifiableMap(new LinkedHashMap<>(responseHeaders == null ? Map.of() : responseHeaders));
        requestBodyText = requestBodyText == null ? "" : requestBodyText;
        responseBodyText = responseBodyText == null ? "" : responseBodyText;
        sourceTool = sourceTool == null || sourceTool.isBlank() ? "proxy" : sourceTool;
        method = method == null || method.isBlank() ? "GET" : method;
        url = url == null ? "" : url;
    }

    public Map<String, Object> toApiMap() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("sequence", sequence);
        payload.put("sourceTool", sourceTool);
        payload.put("method", method);
        payload.put("url", url);
        payload.put("requestHeaders", requestHeaders);
        payload.put("requestBodyText", requestBodyText);
        payload.put("responseStatus", responseStatus);
        payload.put("responseHeaders", responseHeaders);
        payload.put("responseBodyText", responseBodyText);
        return payload;
    }
}
