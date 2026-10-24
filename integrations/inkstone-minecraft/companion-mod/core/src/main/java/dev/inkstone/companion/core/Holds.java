package dev.inkstone.companion.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class Holds {
	private static final Map<String, Integer> REMAINING = new LinkedHashMap<>();

	private Holds() {
	}

	static synchronized void start(String id, int ticks) {
		REMAINING.put(id, Math.max(1, ticks));
	}

	static synchronized void release(String id) {
		REMAINING.remove(id);
	}

	static synchronized void tick(GameBridge bridge) {
		if (REMAINING.isEmpty()) return;
		List<String> expired = new ArrayList<>();
		for (Map.Entry<String, Integer> entry : REMAINING.entrySet()) {
			int left = entry.getValue() - 1;
			entry.setValue(left);
			if (left <= 0) expired.add(entry.getKey());
		}
		for (String id : expired) {
			REMAINING.remove(id);
			try {
				bridge.releaseHold(id);
			} catch (Exception error) {
				Companion.log("release hold failed: " + error);
			}
		}
	}
}
