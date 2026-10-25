package dev.inkstone.companion.core;

import java.lang.ref.WeakReference;

public final class ServerTicks {
	private static volatile Frame completed;

	private ServerTicks() {
	}

	public static void complete(Object server, long tick) {
		Frame frame = completed;
		if (frame == null || frame.server.get() != server) completed = new Frame(server, tick);
		else frame.tick = tick;
	}

	public static long completedTime(Object server, long initial) {
		Frame frame = completed;
		return frame != null && frame.server.get() == server ? frame.tick : initial;
	}

	private static final class Frame {
		final WeakReference<Object> server;
		volatile long tick;

		Frame(Object server, long tick) {
			this.server = new WeakReference<>(server);
			this.tick = tick;
		}
	}
}
