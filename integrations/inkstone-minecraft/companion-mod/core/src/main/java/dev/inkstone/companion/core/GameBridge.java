package dev.inkstone.companion.core;

import com.google.gson.JsonObject;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;

public interface GameBridge {
	boolean clientReady();

	long windowHandle();

	CompletableFuture<Boolean> runOnClient(Callable<Boolean> task);

	boolean inWorld();

	boolean titleReady();

	boolean playing();

	String screenClass();

	String screenTitle();

	Map<String, Object> status() throws Exception;

	Map<String, Object> env() throws Exception;

	Map<String, Object> reloadResources() throws Exception;

	Frame frame(boolean hideHud) throws Exception;

	byte[] renderItem(String id, String kind, int size) throws Exception;

	CommandResult command(String command) throws Exception;

	CheckResult commandCheck(String command) throws Exception;

	boolean commandViaChat(String command) throws Exception;

	List<String> registryNames() throws Exception;

	RegistryData registry(String name) throws Exception;

	BlockInfo block(int x, int y, int z, String dimension) throws Exception;

	EntityQuery entities(JsonObject body, int limit) throws Exception;

	WorldOpen openWorld(String name, boolean create) throws Exception;

	boolean worldTick();

	Map<String, Object> shutdown() throws Exception;

	PlayerLook look() throws Exception;

	void setLook(float yaw, float pitch) throws Exception;

	boolean serverLook(float yaw, float pitch) throws Exception;

	TickProgress tickProgress() throws Exception;

	Map<String, Object> beginSnapshot() throws Exception;

	Map<String, Object> act(JsonObject body, String entityUuid) throws Exception;

	String hold(JsonObject body) throws Exception;

	void releaseHold(String id) throws Exception;

	void resetInput() throws Exception;

	void pressKey(String key) throws Exception;

	void hotbar(int slot) throws Exception;

	Map<String, Object> uiRead() throws Exception;

	Map<String, Object> uiAction(JsonObject body) throws Exception;

	List<String> suggestions(String text) throws Exception;

	Map<String, Object> player() throws Exception;

	Map<String, Object> perf() throws Exception;

	OptionsResult options(List<String> get, Map<String, Object> set) throws Exception;

	List<EntityRef> select(Selector selector) throws Exception;

	String normalizeTickState() throws Exception;

	void notice(String text) throws Exception;

	void glow(String uuid, boolean glowing) throws Exception;

	record CommandResult(String command, List<String> output, Boolean success, int result) {
	}

	record CheckResult(boolean valid, String error, int cursor, List<String> suggestions) {
	}

	record RegistryData(String id, boolean dynamic, Collection<String> ids) {
	}

	record BlockInfo(String dimension, int x, int y, int z, String block, String state, String blockEntity, int lightBlock, int lightSky) {
	}

	record EntityInfo(String uuid, String type, String name, double x, double y, double z, String nbt) {
	}

	record EntityQuery(String dimension, int count, List<EntityInfo> entities) {
	}

	record WorldOpen(boolean ok, String world, boolean created, String error) {
	}

	record EntityRef(String uuid, String type, String name, double x, double y, double z, double height) {
	}

	record PlayerLook(double x, double y, double z, double eyeY, float yaw, float pitch, float fov) {
	}

	record TickProgress(long tick, boolean frozen, boolean stepping, float rate) {
	}

	record Frame(byte[] png, int guiWidth, int guiHeight) {
	}

	record OptionsResult(Map<String, Object> values, List<String> applied, List<String> needsRestart) {
	}
}
