package dev.inkstone.companion.core;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import net.fabricmc.loader.api.FabricLoader;

public final class Companion {
	private static final Control DEFAULT_CONTROL = Control.fromProperties();
	private static final AtomicInteger TICKS = new AtomicInteger();
	private static volatile Companion instance;
	private static volatile boolean active;
	private static volatile Consumer<String> sink = System.out::println;
	private static volatile Boolean enabled;

	private final GameBridge bridge;
	private final Control control;
	private final Router router;

	private Companion(GameBridge bridge, Control control, Router router) {
		this.bridge = bridge;
		this.control = control;
		this.router = router;
	}

	public static boolean enabled() {
		Boolean cached = enabled;
		if (cached == null) {
			cached = computeEnabled();
			enabled = cached;
		}
		return cached;
	}

	private static boolean computeEnabled() {
		boolean development;
		try {
			development = FabricLoader.getInstance().isDevelopmentEnvironment();
		} catch (Throwable error) {
			return false;
		}
		if (!development) return false;
		return System.getProperty("inkstone.companion.token", "").length() >= 16 && !System.getProperty("inkstone.companion.port", "").isEmpty();
	}

	public static void init(GameBridge bridge, Consumer<String> log) {
		sink = log;
		if (!enabled()) {
			log.accept("disabled: not a development environment or missing inkstone.companion.token / inkstone.companion.port");
			return;
		}
		Control control = Control.fromProperties();
		AgentWindow.attach(control, bridge);
		control.onChanged(() -> controlChanged(bridge, control));
		long handle = bridge.windowHandle();
		if (handle != 0L) AgentWindow.afterCreate(handle);
		Router router = new Router(bridge, control);
		CompanionServer server;
		try {
			server = new CompanionServer(Integer.parseInt(System.getProperty("inkstone.companion.port")), System.getProperty("inkstone.companion.token"), router);
			server.start();
		} catch (Exception error) {
			log.accept("failed to start: " + error);
			return;
		}
		instance = new Companion(bridge, control, router);
		active = true;
		try {
			log.accept("loaded companion " + FabricLoader.getInstance().getModContainer("inkstone_companion").map(container -> container.getMetadata().getVersion().getFriendlyString()).orElse("unknown") + " from " + Companion.class.getProtectionDomain().getCodeSource().getLocation());
		} catch (RuntimeException error) {
			log.accept("companion source unavailable: " + error);
		}
		log.accept("listening on 127.0.0.1:" + server.port() + " (control " + control.owner() + ", input " + System.getProperty("inkstone.input", "background") + ")");
		String world = System.getProperty("inkstone.companion.world", "");
		if (!world.isBlank()) WorldBootstrap.start(bridge, world);
	}

	public static boolean active() {
		return active;
	}

	public static Control control() {
		Companion current = instance;
		return current == null ? DEFAULT_CONTROL : current.control;
	}

	public static GameBridge bridge() {
		Companion current = instance;
		return current == null ? null : current.bridge;
	}

	public static int tickCount() {
		return TICKS.get();
	}

	public static void onClientTick() {
		Banner.tick();
		TICKS.incrementAndGet();
		Companion current = instance;
		if (current == null) return;
		Holds.tick(current.bridge);
		Highlights.tick(current.bridge);
		Scripts.tick(current.router);
		AgentWindow.tick(current.bridge.windowHandle());
	}

	private static void restoreTicks(GameBridge bridge) {
		Thread worker = new Thread(() -> {
			try {
				String notice = bridge.normalizeTickState();
				if (notice != null) bridge.notice(notice);
			} catch (Exception error) {
				log("tick restore failed: " + error);
			}
		}, "inkstone-companion-ticks");
		worker.setDaemon(true);
		worker.start();
	}

	static void controlChanged(GameBridge bridge, Control control) {
		if (!control.agent()) {
			Scripts.cancelForUser();
			restoreTicks(bridge);
		}
		bridge.runOnClient(() -> {
			Holds.clear(bridge);
			bridge.resetInput();
			return true;
		}).exceptionally(error -> {
			log("control input reset failed: " + error);
			return false;
		});
	}

	public static void log(String message) {
		sink.accept(message);
	}
}
