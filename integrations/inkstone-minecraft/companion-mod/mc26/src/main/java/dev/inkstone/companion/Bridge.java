package dev.inkstone.companion;

import dev.inkstone.companion.core.GameBridge;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.TitleScreen;

final class Bridge implements GameBridge {
	@Override
	public boolean clientReady() {
		Minecraft client = Minecraft.getInstance();
		return client != null && client.getWindow() != null;
	}

	@Override
	public long windowHandle() {
		Minecraft client = Minecraft.getInstance();
		return client != null && client.getWindow() != null ? client.getWindow().handle() : 0L;
	}

	@Override
	public CompletableFuture<Boolean> runOnClient(Callable<Boolean> task) {
		Minecraft client = Minecraft.getInstance();
		if (client == null || client.getWindow() == null) return CompletableFuture.completedFuture(false);
		if (client.isSameThread()) return completed(task);
		return client.submit(() -> call(task));
	}

	private static CompletableFuture<Boolean> completed(Callable<Boolean> task) {
		try {
			return CompletableFuture.completedFuture(task.call());
		} catch (Exception error) {
			return CompletableFuture.failedFuture(error);
		}
	}

	private static boolean call(Callable<Boolean> task) {
		try {
			return task.call();
		} catch (Exception error) {
			throw new IllegalStateException(error);
		}
	}

	@Override
	public boolean inWorld() {
		Minecraft client = Minecraft.getInstance();
		return client.level != null || client.getSingleplayerServer() != null;
	}

	@Override
	public boolean titleReady() {
		Minecraft client = Minecraft.getInstance();
		return client.getOverlay() == null && client.screen instanceof TitleScreen;
	}

	@Override
	public boolean playing() {
		return Boolean.TRUE.equals(safely(ClientOps::playingNow));
	}

	@Override
	public String screenClass() {
		return safely(ClientOps::screenClass);
	}

	@Override
	public String screenTitle() {
		return safely(ClientOps::screenTitle);
	}

	private static <T> T safely(java.util.function.Supplier<T> task) {
		try {
			return Ops.onClient(task);
		} catch (Exception error) {
			return null;
		}
	}

	@Override
	public Map<String, Object> status() throws Exception {
		return Ops.onClient(ClientOps::status);
	}

	@Override
	public Map<String, Object> env() throws Exception {
		return StateOps.env();
	}

	@Override
	public Map<String, Object> reloadResources() throws Exception {
		return ClientOps.reloadResources();
	}

	@Override
	public GameBridge.Frame frame(boolean hideHud) throws Exception {
		return StateOps.frame(hideHud);
	}

	@Override
	public byte[] renderItem(String id, String kind, int size) throws Exception {
		return ItemImages.render(id, kind, size);
	}

	@Override
	public GameBridge.CommandResult command(String command) throws Exception {
		return ServerOps.command(command);
	}

	@Override
	public GameBridge.CheckResult commandCheck(String command) throws Exception {
		return CommandOps.check(command);
	}

	@Override
	public boolean commandViaChat(String command) throws Exception {
		return CommandOps.viaChat(command);
	}

	@Override
	public List<String> registryNames() throws Exception {
		return ServerOps.registryNames();
	}

	@Override
	public GameBridge.RegistryData registry(String name) throws Exception {
		return ServerOps.registry(name);
	}

	@Override
	public GameBridge.BlockInfo block(int x, int y, int z, String dimension) throws Exception {
		return ServerOps.block(x, y, z, dimension);
	}

	@Override
	public GameBridge.EntityQuery entities(com.google.gson.JsonObject body, int limit) throws Exception {
		return ServerOps.entities(body, limit);
	}

	@Override
	public GameBridge.WorldOpen openWorld(String name, boolean create) throws Exception {
		return WorldOps.open(name, create);
	}

	@Override
	public boolean worldTick() {
		return true;
	}

	@Override
	public Map<String, Object> shutdown() throws Exception {
		return Ops.onClient(Ops::shutdownNow);
	}

	@Override
	public GameBridge.PlayerLook look() throws Exception {
		return Ops.onClient(InputOps::look);
	}

	@Override
	public void setLook(float yaw, float pitch) throws Exception {
		Ops.onClient(() -> {
			InputOps.setLook(yaw, pitch);
			return true;
		});
	}

	@Override
	public Map<String, Object> act(com.google.gson.JsonObject body, String entityUuid) throws Exception {
		return Ops.onClient(() -> InputOps.act(body, entityUuid));
	}

	@Override
	public String hold(com.google.gson.JsonObject body) throws Exception {
		return Ops.onClient(() -> InputOps.hold(body));
	}

	@Override
	public void releaseHold(String id) {
		InputOps.release(id);
	}

	@Override
	public void pressKey(String key) throws Exception {
		Ops.onClient(() -> {
			InputOps.pressKey(key);
			return true;
		});
	}

	@Override
	public void hotbar(int slot) throws Exception {
		Ops.onClient(() -> {
			InputOps.hotbar(slot);
			return true;
		});
	}

	@Override
	public Map<String, Object> uiRead() throws Exception {
		return Ops.onClient(UiOps::read);
	}

	@Override
	public Map<String, Object> uiAction(com.google.gson.JsonObject body) throws Exception {
		return Ops.onClient(() -> UiOps.action(body));
	}

	@Override
	public List<String> suggestions(String text) throws Exception {
		return UiOps.suggestions(text);
	}

	@Override
	public Map<String, Object> player() throws Exception {
		return StateOps.player();
	}

	@Override
	public Map<String, Object> perf() throws Exception {
		return StateOps.perf();
	}

	@Override
	public GameBridge.OptionsResult options(List<String> get, Map<String, Object> set) throws Exception {
		return StateOps.options(get, set);
	}

	@Override
	public List<GameBridge.EntityRef> select(dev.inkstone.companion.core.Selector selector) throws Exception {
		return Ops.onClient(() -> InputOps.select(selector));
	}

	@Override
	public String normalizeTickState() throws Exception {
		return CommandOps.normalizeTickState();
	}

	@Override
	public void notice(String text) throws Exception {
		CommandOps.notice(text);
	}

	@Override
	public void glow(String uuid, boolean glowing) {
		try {
			Ops.onClient(() -> {
				InputOps.glow(uuid, glowing);
				return true;
			});
		} catch (Exception error) {
			dev.inkstone.companion.core.Companion.log("glow failed: " + error);
		}
	}
}
