package com.bstg.burp.recorder;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

public final class EventQueue {
    private final PendingQueueStore pendingQueueStore;
    private final Deque<CapturedEvent> queue = new ArrayDeque<>();
    private final int maxSize;

    public EventQueue(int maxSize) {
        this(maxSize, List.of(), null);
    }

    public EventQueue(int maxSize, List<CapturedEvent> initialEvents, PendingQueueStore pendingQueueStore) {
        this.maxSize = Math.max(50, maxSize);
        this.pendingQueueStore = pendingQueueStore;
        if (initialEvents != null) {
            for (CapturedEvent event : initialEvents) {
                if (event != null) {
                    queue.offerLast(event);
                }
            }
        }
        trimToCapacity();
        persist();
    }

    public synchronized QueueOfferResult offer(CapturedEvent event) {
        int dropped = trimForIncoming(queue.size() + 1);
        queue.offerLast(event);
        persist();
        return new QueueOfferResult(queue.size(), dropped);
    }

    public synchronized List<CapturedEvent> pollBatch(int batchSize) {
        List<CapturedEvent> batch = new ArrayList<>(Math.max(1, batchSize));
        while (!queue.isEmpty() && batch.size() < batchSize) {
            batch.add(queue.pollFirst());
        }
        persist();
        return batch;
    }

    public synchronized void requeueFront(List<CapturedEvent> batch) {
        for (int i = batch.size() - 1; i >= 0; i--) {
            queue.offerFirst(batch.get(i));
        }
        trimToCapacity();
        persist();
    }

    public synchronized void clear() {
        queue.clear();
        persist();
    }

    public synchronized int size() {
        return queue.size();
    }

    public synchronized boolean isEmpty() {
        return queue.isEmpty();
    }

    private void trimToCapacity() {
        while (queue.size() > maxSize) {
            queue.pollFirst();
        }
    }

    private int trimForIncoming(int expectedSize) {
        int dropped = 0;
        while (!queue.isEmpty() && expectedSize > maxSize) {
            queue.pollFirst();
            expectedSize--;
            dropped++;
        }
        return dropped;
    }

    private void persist() {
        if (pendingQueueStore == null) {
            return;
        }
        pendingQueueStore.save(new ArrayList<>(queue));
    }

    public record QueueOfferResult(int sizeAfterOffer, int droppedCount) {
    }
}
