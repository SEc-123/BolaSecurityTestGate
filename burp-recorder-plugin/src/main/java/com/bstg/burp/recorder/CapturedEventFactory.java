package com.bstg.burp.recorder;

import burp.api.montoya.http.message.HttpHeader;
import burp.api.montoya.http.message.requests.HttpRequest;
import burp.api.montoya.proxy.http.InterceptedResponse;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class CapturedEventFactory {
    private static final int MAX_BODY_CHARS = 200_000;

    public CapturedEvent fromResponse(String sessionId, long sequence, InterceptedResponse response) {
        HttpRequest request = response.initiatingRequest();
        return new CapturedEvent(
            sessionId,
            sequence,
            "proxy",
            safeMethod(request),
            safeUrl(request),
            toHeaderMap(request.headers()),
            truncateBody(request.bodyToString()),
            response.statusCode(),
            toHeaderMap(response.headers()),
            truncateBody(response.bodyToString())
        );
    }

    private String safeMethod(HttpRequest request) {
        try {
            return request.method();
        } catch (Exception ignored) {
            return "GET";
        }
    }

    private String safeUrl(HttpRequest request) {
        try {
            return request.url();
        } catch (Exception ignored) {
            try {
                return request.httpService().toString() + request.path();
            } catch (Exception ignoredAgain) {
                return "";
            }
        }
    }

    private Map<String, String> toHeaderMap(List<HttpHeader> headers) {
        Map<String, String> result = new LinkedHashMap<>();
        for (HttpHeader header : headers) {
            String name = header.name();
            String current = result.get(name);
            if (current == null || current.isBlank()) {
                result.put(name, header.value());
            } else {
                result.put(name, current + ", " + header.value());
            }
        }
        return result;
    }

    private String truncateBody(String body) {
        if (body == null) {
            return "";
        }
        if (body.length() <= MAX_BODY_CHARS) {
            return body;
        }
        return body.substring(0, MAX_BODY_CHARS) + "\n[TRUNCATED]";
    }
}
