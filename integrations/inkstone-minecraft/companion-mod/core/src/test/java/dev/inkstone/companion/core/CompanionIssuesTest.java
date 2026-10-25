package dev.inkstone.companion.core;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

public final class CompanionIssuesTest {
	private static int passed;

	private static void check(boolean value, String name) {
		if (!value) throw new AssertionError(name);
		passed++;
	}

	private static JsonObject json(String value) {
		return JsonParser.parseString(value).getAsJsonObject();
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> call(Router router, String path, String body) throws Exception {
		return (Map<String, Object>) router.call(path, json(body)).json();
	}

	private static Map<String, Object> script(Router router, String body, AtomicInteger ticks) throws Exception {
		CompletableFuture<Map<String, Object>> result = new CompletableFuture<>();
		Thread worker = new Thread(() -> {
			try { result.complete(Scripts.run(json(body), router)); }
			catch (Throwable error) { result.completeExceptionally(error); }
		});
		worker.start();
		long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
		while (!result.isDone() && System.nanoTime() < deadline) {
			ticks.incrementAndGet();
			Scripts.tick(router);
			Thread.sleep(5);
		}
		return result.get(1, TimeUnit.SECONDS);
	}

	public static void main(String[] args) throws Exception {
		var field = Companion.class.getDeclaredField("TICKS");
		field.setAccessible(true);
		AtomicInteger ticks = (AtomicInteger) field.get(null);
		AtomicBoolean owner = new AtomicBoolean(true);
		AtomicBoolean frozen = new AtomicBoolean(true);
		AtomicBoolean stepping = new AtomicBoolean(false);
		AtomicBoolean entity = new AtomicBoolean(true);
		AtomicBoolean actionOk = new AtomicBoolean(true);
		AtomicLong worldTick = new AtomicLong(100);
		AtomicInteger commands = new AtomicInteger();
		AtomicInteger acts = new AtomicInteger();
		AtomicInteger acknowledgements = new AtomicInteger();
		AtomicInteger resets = new AtomicInteger();
		AtomicInteger released = new AtomicInteger();
		ScheduledExecutorService timer = Executors.newScheduledThreadPool(2);
		try {
			GameBridge bridge = (GameBridge) Proxy.newProxyInstance(GameBridge.class.getClassLoader(), new Class<?>[] {GameBridge.class}, (proxy, method, values) -> switch (method.getName()) {
				case "look" -> new GameBridge.PlayerLook(0, 0, 0, 1.62, 90, 0, 70);
				case "setLook" -> null;
				case "serverLook" -> acknowledgements.incrementAndGet() >= 3;
				case "select" -> entity.get() ? List.of(new GameBridge.EntityRef("chosen-uuid", "minecraft:fireball", "Fireball", 1, 1, 1, 1)) : List.of();
				case "screenClass", "screenTitle" -> null;
				case "normalizeTickState" -> null;
				case "releaseHold" -> { released.incrementAndGet(); yield null; }
				case "resetInput" -> { resets.incrementAndGet(); yield null; }
				case "runOnClient" -> CompletableFuture.completedFuture(((java.util.concurrent.Callable<?>) values[0]).call());
				case "playing", "inWorld" -> true;
				case "tickProgress" -> new GameBridge.TickProgress(worldTick.get(), frozen.get(), stepping.get(), 20);
				case "act" -> {
					acts.incrementAndGet();
					check("chosen-uuid".equals(values[1]), "target UUID is retained after aim settles");
					yield Json.map("ok", actionOk.get(), "reason", actionOk.get() ? null : "out of reach", "hit", null);
				}
				case "command" -> {
					commands.incrementAndGet();
					String command = (String) values[0];
					if (command.startsWith("tick step")) {
						stepping.set(true);
						timer.schedule(() -> stepping.set(false), 20, TimeUnit.MILLISECONDS);
						timer.schedule(() -> worldTick.addAndGet(Long.parseLong(command.substring(10))), 70, TimeUnit.MILLISECONDS);
					}
					yield new GameBridge.CommandResult(command, List.of(command.equals("fail") ? "assertion failed" : "done"), !command.equals("fail"), command.equals("fail") ? 0 : 1);
				}
				default -> throw new UnsupportedOperationException(method.getName());
			});
			Control control = Control.fromProperties();
			Router router = new Router(bridge, control);
			timer.scheduleAtFixedRate(ticks::incrementAndGet, 1, 10, TimeUnit.MILLISECONDS);
			Map<String, Object> attack = call(router, "/input", "{\"action\":\"attack\",\"target\":{\"entity\":\"@e[limit=1]\"}}");
			check(Boolean.TRUE.equals(attack.get("ok")) && acts.get() == 1 && acknowledgements.get() >= 3, "attack waits for server look acknowledgement");
			actionOk.set(false);
			check(Boolean.FALSE.equals(call(router, "/input", "{\"action\":\"attack\",\"target\":{\"entity\":\"@e[limit=1]\"}}").get("ok")), "adapter rejection propagates to input result");
			long started = System.nanoTime();
			Map<String, Object> step = call(router, "/tick-step", "{\"ticks\":3}");
			check(Boolean.TRUE.equals(step.get("ok")) && Long.valueOf(103).equals(step.get("after")), "step returns completed world tick");
			check(System.nanoTime() - started >= TimeUnit.MILLISECONDS.toNanos(60), "step does not return when stepping flag clears before tick completion");
			frozen.set(false);
			int before = commands.get();
			check(Boolean.FALSE.equals(call(router, "/tick-step", "{\"ticks\":3}").get("ok")) && commands.get() == before, "unfrozen step is rejected without command");
			Map<String, Object> failed = script(router, "{\"steps\":[{\"op\":\"command\",\"command\":\"fail\"},{\"op\":\"command\",\"command\":\"must-not-run\"}]}", ticks);
			check(Boolean.FALSE.equals(failed.get("ok")) && Json.tree(failed.get("results")).getAsJsonArray().size() == 1, "failed command stops the script immediately");
			Map<String, Object> allowed = script(router, "{\"steps\":[{\"op\":\"command\",\"command\":\"fail\",\"expect\":\"any\"},{\"op\":\"command\",\"command\":\"ok\"}]}", ticks);
			check(Boolean.TRUE.equals(allowed.get("ok")) && Json.tree(allowed.get("results")).getAsJsonArray().size() == 2, "explicit expect any permits optional command failure");
			Map<String, Object> rejected = script(router, "{\"steps\":[{\"op\":\"input\",\"action\":\"attack\",\"target\":{\"entity\":\"@e[limit=1]\"}},{\"op\":\"command\",\"command\":\"must-not-run\"}]}", ticks);
			check(Boolean.FALSE.equals(rejected.get("ok")) && Json.tree(rejected.get("results")).getAsJsonArray().size() == 1, "asynchronous script input rejection stops subsequent steps");
			entity.set(false);
			timer.schedule(() -> entity.set(true), 50, TimeUnit.MILLISECONDS);
			started = System.nanoTime();
			Map<String, Object> waited = script(router, "{\"steps\":[{\"op\":\"wait\",\"until\":\"entity\",\"selector\":\"@e[limit=1]\",\"timeoutMs\":500},{\"op\":\"command\",\"command\":\"ok\"}]}", ticks);
			check(Boolean.TRUE.equals(waited.get("ok")) && System.nanoTime() - started >= TimeUnit.MILLISECONDS.toNanos(40), "script condition wait observes entity arrival");
			entity.set(false);
			Map<String, Object> timeout = script(router, "{\"steps\":[{\"op\":\"wait\",\"until\":\"entity\",\"selector\":\"@e\",\"timeoutMs\":30},{\"op\":\"command\",\"command\":\"must-not-run\"}]}", ticks);
			check(Boolean.FALSE.equals(timeout.get("ok")) && Json.tree(timeout.get("results")).getAsJsonArray().size() == 1, "condition wait timeout fails and stops script");
			var server = Executors.newSingleThreadExecutor();
			try {
				AtomicBoolean nextTask = new AtomicBoolean();
				Map<String, Object> lease = SnapshotLease.begin(server, () -> Json.map("tick", 123), owner::get);
				server.execute(() -> nextTask.set(true));
				Thread.sleep(30);
				check(!nextTask.get(), "snapshot blocks subsequent server writes during copy");
				check(Boolean.TRUE.equals(SnapshotLease.finish((String) lease.get("lease")).get("ok")), "snapshot release confirms a valid lease");
				server.submit(() -> {}).get(1, TimeUnit.SECONDS);
				check(nextTask.get(), "snapshot release resumes server execution");
				Map<String, Object> cancelled = SnapshotLease.begin(server, () -> Json.map("tick", 124), owner::get);
				owner.set(false);
				Thread.sleep(150);
				check(Boolean.FALSE.equals(SnapshotLease.finish((String) cancelled.get("lease")).get("ok")), "user takeover expires snapshot lease");
				owner.set(true);
				Map<String, Object> expired = SnapshotLease.begin(server, () -> Json.map("tick", 125), owner::get);
				var activeField = SnapshotLease.class.getDeclaredField("active");
				activeField.setAccessible(true);
				Object active = activeField.get(null);
				var deadlineField = active.getClass().getDeclaredField("deadline");
				deadlineField.setAccessible(true);
				deadlineField.setLong(active, System.nanoTime() - 1);
				Thread.sleep(150);
				check(Boolean.FALSE.equals(SnapshotLease.finish((String) expired.get("lease")).get("ok")), "expired snapshot lease releases server and cannot publish");
			} finally { server.shutdownNow(); }
			Object first = new Object();
			ServerTicks.complete(first, 12);
			check(ServerTicks.completedTime(first, 13) == 12 && ServerTicks.completedTime(new Object(), 1) == 1, "completed tick state belongs to the active server instance");
			Control handover = Control.fromProperties();
			handover.onChanged(() -> Companion.controlChanged(bridge, handover));
			Holds.start("held-before-takeover", 400);
			handover.change(Control.USER, Control.USER);
			check(released.get() == 1 && resets.get() == 1, "user takeover releases active holds and resets physical game bindings");
			handover.change(Control.AGENT, Control.USER);
			Holds.tick(bridge);
			check(released.get() == 1 && resets.get() == 2, "returning control does not resume old held input");
			control.onChanged(() -> Companion.controlChanged(bridge, control));
			entity.set(false);
			int commandsBeforeTakeover = commands.get();
			CompletableFuture<Throwable> cancelledScript = new CompletableFuture<>();
			Thread cancelledWorker = new Thread(() -> {
				try {
					Scripts.run(json("{\"steps\":[{\"op\":\"wait\",\"until\":\"entity\",\"selector\":\"@e\",\"timeoutMs\":5000},{\"op\":\"command\",\"command\":\"must-not-resume\"}]}"), router);
					cancelledScript.complete(null);
				} catch (Throwable error) { cancelledScript.complete(error); }
			});
			cancelledWorker.setDaemon(true);
			cancelledWorker.start();
			var currentScript = Scripts.class.getDeclaredField("current");
			currentScript.setAccessible(true);
			long readyDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
			boolean scriptReady;
			do {
				synchronized (Scripts.class) { scriptReady = currentScript.get(null) != null; }
				if (!scriptReady) Thread.sleep(1);
			} while (!scriptReady && System.nanoTime() < readyDeadline);
			check(scriptReady, "takeover fixture starts a pending script");
			Scripts.tick(router);
			control.change(Control.USER, Control.USER);
			check(cancelledScript.get(1, TimeUnit.SECONDS) instanceof Router.Denied, "takeover immediately cancels and wakes a pending script");
			control.change(Control.AGENT, Control.USER);
			entity.set(true);
			Scripts.tick(router);
			check(commands.get() == commandsBeforeTakeover, "returning control never resumes commands from the cancelled script");
			passed += NativeTitleBarTest.run();
			System.out.println("Companion issue regressions: " + passed + " passed");
		} finally { timer.shutdownNow(); }
	}
}
