package dev.inkstone.companion.core;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class WorldBootstrap {
	private WorldBootstrap() {
	}

	public static void start(GameBridge bridge, String world) {
		ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(runnable -> {
			Thread thread = new Thread(runnable, "inkstone-companion-world");
			thread.setDaemon(true);
			return thread;
		});
		AtomicBoolean opened = new AtomicBoolean();
		timer.scheduleWithFixedDelay(() -> {
			try {
				boolean done = bridge.runOnClient(() -> attempt(bridge, world, opened)).get(30, TimeUnit.SECONDS);
				if (done) timer.shutdown();
			} catch (Exception error) {
				Companion.log("world bootstrap failed: " + error);
			}
		}, 1, 1, TimeUnit.SECONDS);
	}

	private static boolean attempt(GameBridge bridge, String world, AtomicBoolean opened) throws Exception {
		if (!opened.get()) {
			if (!bridge.titleReady()) return false;
			opened.set(true);
			if (!bridge.inWorld()) {
				GameBridge.WorldOpen open = bridge.openWorld(world, true);
				Companion.log(open.ok() ? "world " + open.world() + (open.created() ? " created" : " opened") : "world open failed: " + open.error());
			}
			return false;
		}
		return bridge.worldTick();
	}
}
