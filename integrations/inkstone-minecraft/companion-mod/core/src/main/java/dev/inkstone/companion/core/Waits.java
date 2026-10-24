package dev.inkstone.companion.core;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;

public final class Waits {
	private Waits() {
	}

	public static State state(JsonObject body) {
		int timeoutMs = Math.max(1, Json.integer(body, "timeoutMs", 30_000));
		int pollTicks = Math.max(1, Json.integer(body, "pollTicks", 2));
		int baseline = body.has("since") ? Json.integer(body, "since", 0) : ChatLog.latest();
		return new State(timeoutMs, pollTicks, baseline, System.currentTimeMillis(), Companion.tickCount());
	}

	public static Outcome step(JsonObject body, State state, GameBridge bridge) throws Exception {
		String until = Json.string(body, "until", "");
		if (until.isBlank()) until = body.has("ticks") ? "ticks" : "";
		switch (until) {
			case "in_world": {
				boolean ready = bridge.playing();
				return new Outcome(ready, "screen=" + describe(bridge.screenClass()), null);
			}
			case "screen": {
				String wanted = Json.string(body, "screen", "");
				String screen = bridge.screenClass();
				String title = bridge.screenTitle();
				boolean done = screen != null && (wanted.isBlank() || matches(screen, wanted) || matches(title, wanted));
				return new Outcome(done, "screen=" + describe(screen), null);
			}
			case "no_screen": {
				String screen = bridge.screenClass();
				return new Outcome(screen == null, "screen=" + describe(screen), null);
			}
			case "chat": {
				String match = Json.string(body, "match", "");
				if (match.isBlank()) throw new IllegalArgumentException("chat wait needs match");
				boolean done = ChatLog.contains(state.baseline, match);
				return new Outcome(done, done ? "chat contains " + match : "waiting for chat " + match, null);
			}
			case "ticks": {
				int ticks = Math.max(1, Json.integer(body, "ticks", 1));
				int passed = Companion.tickCount() - state.startTick();
				return new Outcome(passed >= ticks, "tick=" + Companion.tickCount() + " (" + passed + "/" + ticks + ")", null);
			}
			case "entity": {
				String selector = Json.string(body, "selector", "");
				if (selector.isBlank()) throw new IllegalArgumentException("entity wait needs selector");
				List<GameBridge.EntityRef> refs = bridge.select(Selector.parse(selector));
				return new Outcome(!refs.isEmpty(), refs.isEmpty() ? "no match for " + selector : refs.size() + " match(es), first " + refs.get(0).uuid(), null);
			}
			case "player": {
				String field = Json.string(body, "field", "");
				if (field.isBlank()) throw new IllegalArgumentException("player wait needs field");
				Map<String, Object> player = bridge.player();
				Object value = resolve(player, field);
				if (value == null) return new Outcome(false, "field " + field + " not found", null);
				Boolean equals = body.has("equals") ? equal(value, Json.plain(body.get("equals"))) : null;
				boolean done;
				if (equals != null) done = equals;
				else if (body.has("lt")) done = compare(value, Json.number(body, "lt", 0)) < 0;
				else if (body.has("gt")) done = compare(value, Json.number(body, "gt", 0)) > 0;
				else throw new IllegalArgumentException("player wait needs equals, lt or gt");
				return new Outcome(done, field + "=" + value, null);
			}
			default:
				throw new IllegalArgumentException("until must be in_world, screen, no_screen, chat, ticks, entity or player");
		}
	}

	static Object resolve(Map<String, Object> player, String field) {
		String path = switch (field) {
			case "xp_level" -> "xp.level";
			case "xp_progress" -> "xp.progress";
			case "max_health" -> "maxHealth";
			default -> field;
		};
		Object current = player;
		for (String part : path.split("\\.")) {
			if (!(current instanceof Map<?, ?> map)) return null;
			current = map.get(part);
			if (current == null) return null;
		}
		return current;
	}

	private static Boolean equal(Object value, Object expected) {
		if (value instanceof Number number && expected instanceof Number other) return Math.abs(number.doubleValue() - other.doubleValue()) < 1e-6;
		if (value instanceof Boolean flag) return String.valueOf(flag).equalsIgnoreCase(String.valueOf(expected));
		if (value instanceof Number number && expected instanceof String text) {
			try {
				return Math.abs(number.doubleValue() - Double.parseDouble(text)) < 1e-6;
			} catch (NumberFormatException error) {
				return false;
			}
		}
		return String.valueOf(value).equals(String.valueOf(expected));
	}

	private static double compare(Object value, double expected) {
		if (value instanceof Number number) return Double.compare(number.doubleValue(), expected);
		if (value instanceof Boolean flag) return Double.compare(flag ? 1 : 0, expected);
		try {
			return Double.compare(Double.parseDouble(String.valueOf(value)), expected);
		} catch (NumberFormatException error) {
			return Double.NaN;
		}
	}

	private static boolean matches(String value, String wanted) {
		return value != null && value.toLowerCase().contains(wanted.toLowerCase());
	}

	private static String describe(String screen) {
		return screen == null ? "null" : screen;
	}

	public record State(int timeoutMs, int pollTicks, int baseline, long startedAt, int startTick) {
	}

	public record Outcome(boolean done, String detail, String error) {
	}
}
