package dev.inkstone.companion.core;

import com.google.gson.JsonObject;
import dev.inkstone.companion.core.CompanionServer.Response;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;

public final class Router {
	private static final String DEFAULT_WORLD = "inkstone-test";

	private final GameBridge bridge;
	private final Control control;

	public Router(GameBridge bridge, Control control) {
		this.bridge = bridge;
		this.control = control;
	}

	public GameBridge bridge() {
		return bridge;
	}

	Response dispatch(String path, JsonObject body) {
		try {
			Result result = call(path, body);
			if (result.status() != 200) return new Response(result.status(), result.json(), null);
			return result.png() != null ? Response.image(result.png()) : Response.ok(result.json());
		} catch (Denied error) {
			return new Response(423, Json.map("ok", false, "error", "user_control"), null);
		} catch (IllegalArgumentException error) {
			return Response.error(400, error.getMessage());
		} catch (Throwable error) {
			Companion.log("request failed: " + error);
			return Response.error(500, String.valueOf(error.getMessage() == null ? error : error.getMessage()));
		}
	}

	public Result call(String path, JsonObject body) throws Exception {
		return switch (path) {
			case "/status" -> Result.ok(status());
			case "/control" -> control(body);
			case "/reload-resources" -> Result.ok(bridge.reloadResources());
			case "/screenshot" -> Result.image(screenshot(body));
			case "/render" -> Result.image(captured(() -> bridge.renderItem(Json.string(body, "id", ""), Json.string(body, "kind", "auto"), Json.integer(body, "size", 128))));
			case "/command" -> command(body);
			case "/registry" -> Result.ok(registry(Json.string(body, "registry", ""), Json.string(body, "filter", ""), Json.integer(body, "limit", 500)));
			case "/block" -> Result.ok(blockInfo(bridge.block(Json.integer(body, "x", 0), Json.integer(body, "y", 0), Json.integer(body, "z", 0), Json.string(body, "dimension", ""))));
			case "/entities" -> Result.ok(entityList(bridge.entities(body, Math.max(1, Json.integer(body, "limit", 10)))));
			case "/world" -> Result.ok(worldOpen(bridge.openWorld(Json.string(body, "name", DEFAULT_WORLD), Json.bool(body, "create", false))));
			case "/snapshot-begin" -> {
				requireAgent();
				yield Result.ok(bridge.beginSnapshot());
			}
			case "/snapshot-end" -> Result.ok(SnapshotLease.finish(Json.string(body, "lease", "")));
			case "/tick-step" -> Result.ok(tickStep(body));
			case "/shutdown" -> Result.ok(bridge.shutdown());
			case "/input" -> Result.ok(input(body));
			case "/ui" -> Result.ok(ui(body));
			case "/player" -> Result.ok(bridge.player());
			case "/chat" -> Result.ok(ChatLog.read(Json.integer(body, "since", 0), Json.integer(body, "limit", 50)));
			case "/perf" -> Result.ok(bridge.perf());
			case "/options" -> options(body);
			case "/script" -> script(body);
			case "/wait" -> wait(body);
			case "/highlight" -> Result.ok(Highlights.apply(body, bridge));
			default -> throw new IllegalArgumentException("unknown endpoint " + path);
		};
	}

	void requireAgent() throws Denied {
		if (Scripts.cancelled()) throw new IllegalStateException("script has already finished");
		if (!control.agent()) throw new Denied();
	}

	private Map<String, Object> status() throws Exception {
		Map<String, Object> status = bridge.status();
		status.put("control", control.json());
		status.put("env", bridge.env());
		status.put("highlight", Highlights.count());
		status.put("takeover", NativeTitleBar.status());
		return status;
	}

	private Result control(JsonObject body) {
		String owner = Json.string(body, "owner", "");
		if (owner.isBlank()) return Result.ok(control.json());
		try {
			return Result.ok(control.change(owner, Control.AGENT));
		} catch (IllegalArgumentException error) {
			return new Result(Json.map("ok", false, "error", error.getMessage()), null, 400);
		}
	}

	private byte[] screenshot(JsonObject body) throws Exception {
		GameBridge.Frame frame = captured(() -> bridge.frame(Json.bool(body, "hideHud", false)));
		return Shots.decorate(body, frame.png(), frame.guiWidth());
	}

	private Result command(JsonObject body) throws Exception {
		requireAgent();
		String command = Json.string(body, "command", "");
		if (command.isBlank()) throw new IllegalArgumentException("command is empty");
		if (Json.bool(body, "check", false)) {
			GameBridge.CheckResult check = bridge.commandCheck(command);
			return Result.ok(Json.map("ok", true, "valid", check.valid(), "error", check.error(), "cursor", check.cursor(), "suggestions", check.suggestions()));
		}
		if ("chat".equalsIgnoreCase(Json.string(body, "via", "server"))) {
			boolean sent = bridge.commandViaChat(command);
			return Result.ok(Json.map("ok", sent, "sent", sent));
		}
		return Result.ok(commandResult(bridge.command(command)));
	}

	private Map<String, Object> input(JsonObject body) throws Exception {
		requireAgent();
		String action = Json.string(body, "action", "");
		return switch (action) {
			case "attack", "use" -> attackOrUse(body);
			case "look" -> look(body);
			case "move" -> hold(body, Json.integer(body, "ticks", 1));
			case "hotbar" -> hotbar(Json.integer(body, "slot", 0));
			case "key" -> {
				String key = Json.string(body, "key", "");
				if (key.isBlank()) throw new IllegalArgumentException("key is empty");
				int holdTicks = Json.integer(body, "holdTicks", 0);
				if (holdTicks > 1) yield hold(body, holdTicks);
				bridge.pressKey(key);
				yield Json.map("ok", true, "screen", bridge.screenClass(), "key", key);
			}
			default -> throw new IllegalArgumentException("unknown action " + action);
		};
	}

	private Map<String, Object> look(JsonObject body) throws Exception {
		double[] at = Json.triple(body, "at");
		if (at != null) {
			GameBridge.PlayerLook look = bridge.look();
			float[] angles = Aim.angles(new double[] {look.x(), look.eyeY(), look.z()}, at);
			bridge.setLook(angles[0], angles[1]);
			return Json.map("ok", true, "screen", bridge.screenClass(), "yaw", angles[0], "pitch", angles[1], "hit", null);
		}
		float yaw = (float) Json.number(body, "yaw", 0);
		float pitch = (float) Math.max(-90, Math.min(90, Json.number(body, "pitch", 0)));
		bridge.setLook(yaw, pitch);
		return Json.map("ok", true, "screen", bridge.screenClass(), "yaw", yaw, "pitch", pitch, "hit", null);
	}

	private Map<String, Object> hold(JsonObject body, int ticks) throws Exception {
		int length = Math.max(1, Math.min(1200, ticks));
		String id = bridge.hold(body);
		Holds.start(id, length);
		return Json.map("ok", true, "screen", bridge.screenClass(), "hold", id, "ticks", length);
	}

	private Map<String, Object> hotbar(int slot) throws Exception {
		int index = Math.max(0, Math.min(8, slot));
		bridge.hotbar(index);
		return Json.map("ok", true, "screen", bridge.screenClass(), "slot", index);
	}

	private Map<String, Object> attackOrUse(JsonObject body) throws Exception {
		String action = Json.string(body, "action", "attack");
		String entityUuid = "";
		JsonObject target = Json.object(body, "target");
		if (target != null) {
			double[] block = Json.triple(target, "block");
			if (block != null) {
				double[] aim = blockCenter(block, Json.string(target, "face", "up"));
				aim(new double[] {aim[0], aim[1], aim[2]});
			} else {
				String raw = Json.string(target, "entity", "");
				if (!raw.isBlank()) {
					List<GameBridge.EntityRef> refs = bridge.select(Selector.parse(raw));
					if (refs.isEmpty()) throw new IllegalArgumentException("no entity matches " + raw);
					GameBridge.EntityRef ref = refs.get(0);
					entityUuid = ref.uuid();
					aim(new double[] {ref.x(), ref.y() + Math.max(0.2, ref.height() * 0.5), ref.z()});
				}
			}
		}
		int settledTicks = 0;
		if (target != null) {
			settledTicks = Math.max(1, Math.min(20, Json.integer(body, "settleTicks", 1)));
			int start = Companion.tickCount();
			GameBridge.PlayerLook expected = bridge.look();
			long deadline = System.currentTimeMillis() + 5000;
			while (Companion.tickCount() - start < settledTicks || !bridge.serverLook(expected.yaw(), expected.pitch())) {
				requireAgent();
				if (System.currentTimeMillis() >= deadline) return Json.map("ok", false, "reason", "朝向同步超时，未发送交互", "hit", null, "screen", bridge.screenClass());
				Thread.sleep(10);
			}
		}
		requireAgent();
		Map<String, Object> result = bridge.act(body, entityUuid);
		if (target != null) result.put("settledTicks", settledTicks);
		if (Boolean.FALSE.equals(result.get("ok"))) return result;
		int holdTicks = Json.integer(body, "holdTicks", 0);
		if (holdTicks > 1 && "use".equals(action)) {
			String id = bridge.hold(body);
			Holds.start(id, holdTicks);
			result.put("hold", id);
		}
		return result;
	}

	private Map<String, Object> tickStep(JsonObject body) throws Exception {
		requireAgent();
		int ticks = Math.max(1, Math.min(100000, Json.integer(body, "ticks", 1)));
		GameBridge.TickProgress before = bridge.tickProgress();
		if (!before.frozen() || before.stepping()) return Json.map("ok", false, "error", "step requires a frozen world with no pending step", "before", before.tick(), "after", before.tick());
		GameBridge.CommandResult command = bridge.command("tick step " + ticks);
		if (Boolean.FALSE.equals(command.success())) return commandResult(command);
		long deadline = System.currentTimeMillis() + Math.max(1000, Math.min(600000, Json.integer(body, "timeoutMs", 120000)));
		GameBridge.TickProgress after;
		for (;;) {
			requireAgent();
			after = bridge.tickProgress();
			if (after.tick() - before.tick() >= ticks && !after.stepping()) break;
			if (!after.frozen() || System.currentTimeMillis() >= deadline) return Json.map("ok", false, "error", "step barrier timed out or world was unfrozen; step may still be pending", "before", before.tick(), "after", after.tick(), "output", command.output());
			Thread.sleep(10);
		}
		return Json.map("ok", true, "before", before.tick(), "after", after.tick(), "stepped", after.tick() - before.tick(), "output", command.output());
	}

	private void aim(double[] target) throws Exception {
		GameBridge.PlayerLook look = bridge.look();
		float[] angles = Aim.angles(new double[] {look.x(), look.eyeY(), look.z()}, target);
		bridge.setLook(angles[0], angles[1]);
	}

	private static double[] blockCenter(double[] pos, String face) {
		double x = Math.floor(pos[0]) + 0.5;
		double y = Math.floor(pos[1]) + 0.5;
		double z = Math.floor(pos[2]) + 0.5;
		switch (face == null ? "up" : face.toLowerCase()) {
			case "up" -> y = Math.floor(pos[1]) + 1.0;
			case "down" -> y = Math.floor(pos[1]);
			case "north" -> z = Math.floor(pos[2]);
			case "south" -> z = Math.floor(pos[2]) + 1.0;
			case "west" -> x = Math.floor(pos[0]);
			case "east" -> x = Math.floor(pos[0]) + 1.0;
			default -> {
			}
		}
		return new double[] {x, y, z};
	}

	private Map<String, Object> ui(JsonObject body) throws Exception {
		String action = Json.string(body, "action", "read");
		if ("read".equals(action)) return bridge.uiRead();
		requireAgent();
		return bridge.uiAction(body);
	}

	private Result options(JsonObject body) throws Exception {
		List<String> get = Json.strings(body, "get");
		Map<String, Object> set = Json.stringMap(body, "set");
		if (get.isEmpty() && set.isEmpty()) throw new IllegalArgumentException("options needs get or set");
		if (!set.isEmpty()) requireAgent();
		GameBridge.OptionsResult result = bridge.options(get, set);
		return Result.ok(Json.map("ok", true, "values", result.values(), "applied", result.applied(), "needsRestart", result.needsRestart()));
	}

	private Result wait(JsonObject body) throws Exception {
		Waits.State state = Waits.state(body);
		long deadline = System.currentTimeMillis() + state.timeoutMs();
		while (true) {
			if (!control.agent()) throw new Denied();
			Waits.Outcome outcome = Waits.step(body, state, bridge);
			long waited = System.currentTimeMillis() - state.startedAt();
			if (outcome.done()) {
				Map<String, Object> payload = Json.map("ok", true, "waitedMs", waited, "tick", Companion.tickCount(), "detail", outcome.detail());
				byte[] image = thenImage(body);
				if (image != null) payload.put("image", Base64.getEncoder().encodeToString(image));
				return Result.ok(payload);
			}
			if (System.currentTimeMillis() >= deadline) {
				return Result.ok(Json.map("ok", false, "reason", "timeout", "waitedMs", waited, "tick", Companion.tickCount(), "detail", outcome.detail()));
			}
			Thread.sleep(Math.min(200, Math.max(20, state.pollTicks() * 25L)));
		}
	}

	public static boolean wantsThenImage(JsonObject body) {
		JsonObject then = Json.object(body, "then");
		return then != null && Json.object(then, "screenshot") != null;
	}

	public byte[] thenImage(JsonObject body) throws Exception {
		JsonObject then = Json.object(body, "then");
		if (then == null) return null;
		JsonObject shot = Json.object(then, "screenshot");
		if (shot == null) return null;
		Banner.beginCapture();
		try {
			GameBridge.Frame frame = bridge.frame(Json.bool(shot, "hideHud", false));
			return Shots.decorate(shot, frame.png(), frame.guiWidth());
		} finally {
			Banner.endCapture();
		}
	}

	private Result script(JsonObject body) throws Exception {
		requireAgent();
		return Result.ok(Scripts.run(body, this));
	}

	private static byte[] captured(ImageTask task) throws Exception {
		Banner.beginCapture();
		try {
			if (!Scripts.inTick()) Banner.settle();
			return task.get();
		} finally {
			Banner.endCapture();
		}
	}

	private static GameBridge.Frame captured(FrameTask task) throws Exception {
		Banner.beginCapture();
		try {
			if (!Scripts.inTick()) Banner.settle();
			return task.get();
		} finally {
			Banner.endCapture();
		}
	}

	private static Map<String, Object> commandResult(GameBridge.CommandResult result) {
		return Json.map(
			"ok", result.success() == null || result.success(),
			"command", result.command(),
			"output", result.output(),
			"success", result.success(),
			"result", result.result()
		);
	}

	private Map<String, Object> registry(String name, String filter, int limit) throws Exception {
		if (name == null || name.isBlank()) return Json.map("ok", true, "registries", bridge.registryNames());
		GameBridge.RegistryData data = bridge.registry(name);
		String needle = filter == null ? "" : filter.toLowerCase();
		List<String> ids = new ArrayList<>();
		int total = 0;
		for (String entry : data.ids()) {
			String text = entry.toString();
			if (!needle.isEmpty() && !text.toLowerCase().contains(needle)) continue;
			total++;
			if (ids.size() < Math.max(1, limit)) ids.add(text);
		}
		ids.sort(String::compareTo);
		return Json.map("ok", true, "registry", data.id(), "dynamic", data.dynamic(), "total", total, "ids", ids, "truncated", total > ids.size());
	}

	private static Map<String, Object> blockInfo(GameBridge.BlockInfo info) {
		return Json.map(
			"ok", true,
			"dimension", info.dimension(),
			"pos", List.of(info.x(), info.y(), info.z()),
			"block", info.block(),
			"state", info.state(),
			"blockEntity", info.blockEntity(),
			"light", Json.map("block", info.lightBlock(), "sky", info.lightSky())
		);
	}

	private static Map<String, Object> entityList(GameBridge.EntityQuery query) {
		List<Object> entities = new ArrayList<>();
		for (GameBridge.EntityInfo entity : query.entities()) {
			entities.add(Json.map(
				"uuid", entity.uuid(),
				"type", entity.type(),
				"name", entity.name(),
				"pos", List.of(entity.x(), entity.y(), entity.z()),
				"nbt", entity.nbt()
			));
		}
		return Json.map("ok", true, "dimension", query.dimension(), "count", query.count(), "entities", entities);
	}

	private static Map<String, Object> worldOpen(GameBridge.WorldOpen open) {
		if (!open.ok()) return Json.map("ok", false, "error", open.error());
		return Json.map("ok", true, "world", open.world(), "created", open.created());
	}

	interface ImageTask {
		byte[] get() throws Exception;
	}

	interface FrameTask {
		GameBridge.Frame get() throws Exception;
	}

	public record Result(Object json, byte[] png, int status) {
		public static Result ok(Object json) {
			return new Result(json, null, 200);
		}

		public static Result image(byte[] png) {
			return new Result(null, png, 200);
		}
	}

	public static final class Denied extends RuntimeException {
		public Denied() {
			super("user_control");
		}
	}
}
