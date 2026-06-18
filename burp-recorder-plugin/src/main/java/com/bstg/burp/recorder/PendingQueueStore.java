package com.bstg.burp.recorder;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.List;
import java.util.prefs.Preferences;

public final class PendingQueueStore {
    private static final String NODE = "com.bstg.burp.recorder";
    private static final String PENDING_QUEUE = "pendingQueue";
    private static final Type EVENT_LIST_TYPE = new TypeToken<List<CapturedEvent>>() { }.getType();

    private final Preferences preferences = Preferences.userRoot().node(NODE);
    private final Gson gson = new Gson();

    public synchronized List<CapturedEvent> load() {
        String raw = preferences.get(PENDING_QUEUE, "[]");
        try {
            List<CapturedEvent> items = gson.fromJson(raw, EVENT_LIST_TYPE);
            return items == null ? List.of() : new ArrayList<>(items);
        } catch (Exception ignored) {
            return List.of();
        }
    }

    public synchronized void save(List<CapturedEvent> events) {
        preferences.put(PENDING_QUEUE, gson.toJson(events == null ? List.of() : events));
    }

    public synchronized void clear() {
        preferences.remove(PENDING_QUEUE);
    }
}
