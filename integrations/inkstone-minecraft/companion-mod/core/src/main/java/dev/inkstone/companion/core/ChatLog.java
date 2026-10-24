package dev.inkstone.companion.core;

import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;

public final class ChatLog {
	private static final int LIMIT = 500;
	private static final Deque<Map<String, Object>> ENTRIES = new ArrayDeque<>();
	private static volatile String nextKind;
	private static volatile long nextKindAt;
	private static int sequence;

	private ChatLog() {
	}

	public static void markNext(String kind) {
		nextKind = kind;
		nextKindAt = System.currentTimeMillis();
	}

	public static synchronized void add(String kind, String text) {
		if (text == null || text.isBlank()) return;
		String override = nextKind;
		if (override != null && System.currentTimeMillis() - nextKindAt < 1000) {
			kind = override;
		}
		nextKind = null;
		sequence++;
		ENTRIES.addLast(Json.map("seq", sequence, "time", System.currentTimeMillis(), "kind", kind, "text", text));
		while (ENTRIES.size() > LIMIT) ENTRIES.removeFirst();
	}

	public static synchronized int latest() {
		return sequence;
	}

	public static synchronized Map<String, Object> read(int since, int limit) {
		int max = Math.max(1, Math.min(LIMIT, limit));
		List<Map<String, Object>> matched = new ArrayList<>();
		for (Map<String, Object> entry : ENTRIES) {
			int seq = (Integer) entry.get("seq");
			if (since > 0 && seq <= since) continue;
			matched.add(entry);
		}
		if (matched.size() > max) matched = new ArrayList<>(matched.subList(matched.size() - max, matched.size()));
		return Json.map("ok", true, "latest", sequence, "messages", matched);
	}

	public static synchronized boolean contains(int since, String match) {
		String needle = match == null ? "" : match.toLowerCase();
		for (Map<String, Object> entry : ENTRIES) {
			int seq = (Integer) entry.get("seq");
			if (since > 0 && seq <= since) continue;
			if (String.valueOf(entry.get("text")).toLowerCase().contains(needle)) return true;
		}
		return false;
	}
}
