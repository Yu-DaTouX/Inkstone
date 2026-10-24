package dev.inkstone.companion.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Base64;
import java.util.Map;

public final class Scripts {
	private static final int DEFAULT_TIMEOUT_TICKS = 400;
	private static final ThreadLocal<Boolean> IN_TICK = ThreadLocal.withInitial(() -> Boolean.FALSE);
	private static Job current;

	private Scripts() {
	}

	public static Map<String, Object> run(JsonObject body, Router router) throws Exception {
		JsonArray steps = Json.array(body, "steps");
		if (steps == null || steps.isEmpty()) throw new IllegalArgumentException("steps must be a non-empty array");
		Job job = new Job(steps, Companion.tickCount(), Math.max(1, Json.integer(body, "timeoutTicks", DEFAULT_TIMEOUT_TICKS)));
		synchronized (Scripts.class) {
			if (current != null) throw new IllegalStateException("another script is already running");
			current = job;
		}
		try {
			long deadline = System.currentTimeMillis() + 30_000L + job.timeoutTicks * 100L;
			synchronized (job) {
				while (!job.finished) {
					long left = deadline - System.currentTimeMillis();
					if (left <= 0) {
						finish(job, "script did not finish in time");
						break;
					}
					job.wait(Math.min(200, left));
				}
			}
		} finally {
			synchronized (Scripts.class) {
				if (current == job) current = null;
			}
		}
		if (job.denied) throw new Router.Denied();
		return Json.map("ok", job.error == null, "results", job.results, "error", job.error);
	}

	static boolean inTick() {
		return IN_TICK.get();
	}

	static void tick(Router router) {
		Job job;
		synchronized (Scripts.class) {
			job = current;
		}
		if (job == null) return;
		synchronized (job) {
			if (job.finished) return;
			try {
				IN_TICK.set(Boolean.TRUE);
				advance(job, router);
				if (job.error == null && Companion.tickCount() - job.startedTick > job.timeoutTicks) finish(job, "script timed out after " + job.timeoutTicks + " ticks");
			} catch (Router.Denied denied) {
				job.denied = true;
				finish(job, "user_control");
			} catch (Throwable error) {
				finish(job, String.valueOf(error.getMessage() == null ? error : error.getMessage()));
			} finally {
				IN_TICK.set(Boolean.FALSE);
			}
			job.notifyAll();
		}
	}

	private static void advance(Job job, Router router) throws Exception {
		if (job.screenshotPending) return;
		if (job.waitSpec != null) {
			Waits.Outcome outcome = Waits.step(job.waitSpec, job.waitState, router.bridge());
			if (outcome.error() != null) {
				record(job, false, null, outcome.error(), null);
				job.waitSpec = null;
			} else if (outcome.done()) {
				completeWait(job, router, outcome, job.waitSpec);
			}
			return;
		}
		if (job.index >= job.steps.size()) {
			finish(job, null);
			return;
		}
		JsonElement element = job.steps.get(job.index);
		if (!element.isJsonObject()) throw new IllegalArgumentException("step " + job.index + " is not an object");
		JsonObject step = element.getAsJsonObject();
		String op = Json.string(step, "op", "");
		job.stepStartedAt = System.currentTimeMillis();
		job.stepIndex = job.index;
		job.stepOp = op;
		job.stepTick = Companion.tickCount();
		job.index++;
		if ("screenshot".equals(op)) {
			startScreenshot(job, router, step);
			return;
		}
		if ("wait".equals(op)) {
			job.waitSpec = step;
			job.waitState = Waits.state(step);
			Waits.Outcome outcome = Waits.step(step, job.waitState, router.bridge());
			if (outcome.error() != null) {
				record(job, false, null, outcome.error(), null);
				job.waitSpec = null;
			} else if (outcome.done()) {
				completeWait(job, router, outcome, job.waitSpec);
			}
			return;
		}
		Router.Result result;
		switch (op) {
			case "command" -> result = router.call("/command", step);
			case "input" -> result = router.call("/input", step);
			case "ui" -> result = router.call("/ui", step);
			case "screenshot" -> result = router.call("/screenshot", step);
			case "player" -> result = router.call("/player", step);
			case "chat" -> result = router.call("/chat", step);
			case "perf" -> result = router.call("/perf", step);
			default -> throw new IllegalArgumentException("unknown op " + op);
		}
		record(job, true, result.json(), null, result.png());
	}

	private static void completeWait(Job job, Router router, Waits.Outcome outcome, JsonObject spec) {
		Map<String, Object> payload = Json.map("ok", true, "waitedMs", System.currentTimeMillis() - job.stepStartedAt, "tick", Companion.tickCount(), "detail", outcome.detail());
		job.waitSpec = null;
		if (!Router.wantsThenImage(spec)) {
			record(job, true, payload, null, null);
			return;
		}
		job.screenshotPending = true;
		Thread worker = new Thread(() -> {
			try {
				byte[] image = router.thenImage(spec);
				synchronized (job) {
					record(job, true, payload, null, image);
				}
			} catch (Throwable error) {
				synchronized (job) {
					record(job, false, null, String.valueOf(error.getMessage() == null ? error : error.getMessage()), null);
				}
			} finally {
				synchronized (job) {
					job.screenshotPending = false;
					job.notifyAll();
				}
			}
		}, "inkstone-companion-wait-shot");
		worker.setDaemon(true);
		worker.start();
	}

	private static void startScreenshot(Job job, Router router, JsonObject step) {
		job.screenshotPending = true;
		Thread worker = new Thread(() -> {
			try {
				Router.Result result = router.call("/screenshot", step);
				synchronized (job) {
					record(job, true, null, null, result.png());
				}
			} catch (Throwable error) {
				synchronized (job) {
					record(job, false, null, String.valueOf(error.getMessage() == null ? error : error.getMessage()), null);
				}
			} finally {
				synchronized (job) {
					job.screenshotPending = false;
					job.notifyAll();
				}
			}
		}, "inkstone-companion-shot");
		worker.setDaemon(true);
		worker.start();
	}

	private static void record(Job job, boolean ok, Object result, String error, byte[] png) {
		JsonObject entry = new JsonObject();
		entry.addProperty("index", job.stepIndex);
		entry.addProperty("op", job.stepOp);
		entry.addProperty("tick", job.stepTick);
		entry.addProperty("timeMs", System.currentTimeMillis() - job.stepStartedAt);
		entry.addProperty("ok", ok);
		if (result != null) entry.add("result", Json.tree(result));
		if (error != null) entry.addProperty("error", error);
		if (png != null) entry.addProperty("image", Base64.getEncoder().encodeToString(png));
		job.results.add(entry);
		if (!ok) finish(job, error);
	}

	private static void finish(Job job, String error) {
		if (job.finished) return;
		job.error = error;
		job.finished = true;
		job.notifyAll();
	}

	private static final class Job {
		final JsonArray steps;
		final int startedTick;
		final int timeoutTicks;
		final JsonArray results = new JsonArray();
		int index;
		boolean finished;
		boolean denied;
		String error;
		JsonObject waitSpec;
		boolean screenshotPending;
		Waits.State waitState;
		long stepStartedAt;
		int stepIndex;
		String stepOp = "";
		int stepTick;

		Job(JsonArray steps, int startedTick, int timeoutTicks) {
			this.steps = steps;
			this.startedTick = startedTick;
			this.timeoutTicks = timeoutTicks;
		}
	}
}
