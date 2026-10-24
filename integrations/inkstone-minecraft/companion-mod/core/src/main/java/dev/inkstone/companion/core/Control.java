package dev.inkstone.companion.core;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

public final class Control {
	public static final String AGENT = "agent";
	public static final String USER = "user";

	private volatile String owner;
	private volatile long changedAt;
	private volatile String changedBy;
	private final List<Runnable> listeners = new CopyOnWriteArrayList<>();

	private Control(String owner, long changedAt, String changedBy) {
		this.owner = owner;
		this.changedAt = changedAt;
		this.changedBy = changedBy;
	}

	public static Control fromProperties() {
		String owner = USER.equalsIgnoreCase(System.getProperty("inkstone.control", "")) ? USER : AGENT;
		return new Control(owner, System.currentTimeMillis(), owner);
	}

	public String owner() {
		return owner;
	}

	public boolean agent() {
		return AGENT.equals(owner);
	}

	public Map<String, Object> json() {
		return Json.map("owner", owner, "changedAt", changedAt, "changedBy", changedBy);
	}

	public void onChanged(Runnable action) {
		listeners.add(action);
	}

	public synchronized Map<String, Object> change(String next, String by) {
		if (!AGENT.equals(next) && !USER.equals(next)) throw new IllegalArgumentException("owner must be agent or user");
		owner = next;
		changedAt = System.currentTimeMillis();
		changedBy = by;
		for (Runnable action : listeners) {
			try {
				action.run();
			} catch (RuntimeException error) {
				Companion.log("control listener failed: " + error);
			}
		}
		return json();
	}

	public synchronized Map<String, Object> toggle(String by) {
		return change(agent() ? USER : AGENT, by);
	}
}
