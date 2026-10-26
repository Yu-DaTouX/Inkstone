package dev.inkstone.companion;

import dev.inkstone.companion.core.Companion;
import dev.inkstone.companion.core.GameBridge;
import dev.inkstone.companion.core.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Options;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;

final class StateOps {
	private StateOps() {
	}

	static Map<String, Object> env() throws Exception {
		return Ops.onClient(StateOps::envNow);
	}

	private static Map<String, Object> envNow() {
		Minecraft client = Minecraft.getInstance();
		IntegratedServer server = client.getSingleplayerServer();
		LocalPlayer player = client.player;
		Map<String, Object> env = new LinkedHashMap<>();
		env.put("world", server == null ? null : server.getWorldData().getLevelName());
		env.put("version", SharedConstants.getCurrentVersion().name());
		env.put("difficulty", client.level == null ? "" : client.level.getDifficulty().getSerializedName());
		env.put("gamemode", client.gameMode == null || client.gameMode.getPlayerMode() == null ? "" : client.gameMode.getPlayerMode().getSerializedName());
		env.put("lang", client.options.languageCode);
		env.put("pos", player == null ? null : List.of(player.getX(), player.getY(), player.getZ()));
		env.put("dimension", player == null ? "" : player.level().dimension().identifier().toString());
		env.put("paused", client.isPaused());
		return env;
	}

	static Map<String, Object> player() throws Exception {
		return Ops.onClient(StateOps::playerNow);
	}

	private static Map<String, Object> playerNow() {
		Minecraft client = Minecraft.getInstance();
		LocalPlayer player = client.player;
		if (player == null) throw new IllegalStateException("not in a world");
		List<Object> effects = new ArrayList<>();
		for (MobEffectInstance effect : player.getActiveEffects()) {
			effects.add(Json.map(
				"id", BuiltInRegistries.MOB_EFFECT.getKey(effect.getEffect().value()).toString(),
				"amplifier", effect.getAmplifier(),
				"duration", effect.getDuration()
			));
		}
		List<Object> inventory = new ArrayList<>();
		var items = player.getInventory().getNonEquipmentItems();
		for (int slot = 0; slot < Math.min(36, items.size()); slot++) inventory.add(Json.map("slot", slot, "item", UiOps.item(items.get(slot))));
		List<Object> armor = new ArrayList<>();
		for (EquipmentSlot slot : new EquipmentSlot[] {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET}) armor.add(UiOps.item(player.getItemBySlot(slot)));
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("ok", true);
		result.put("name", player.getName().getString());
		result.put("uuid", player.getUUID().toString());
		result.put("pos", List.of(player.getX(), player.getY(), player.getZ()));
		result.put("rot", List.of(player.getYRot(), player.getXRot()));
		result.put("dimension", player.level().dimension().identifier().toString());
		result.put("health", player.getHealth());
		result.put("maxHealth", player.getMaxHealth());
		result.put("absorption", player.getAbsorptionAmount());
		result.put("food", player.getFoodData().getFoodLevel());
		result.put("saturation", player.getFoodData().getSaturationLevel());
		result.put("xp", Json.map("level", player.experienceLevel, "progress", player.experienceProgress));
		result.put("gamemode", client.gameMode == null || client.gameMode.getPlayerMode() == null ? "" : client.gameMode.getPlayerMode().getSerializedName());
		result.put("invulnerable", player.isInvulnerable());
		result.put("onGround", player.onGround());
		result.put("effects", effects);
		result.put("selectedSlot", player.getInventory().getSelectedSlot());
		result.put("inventory", inventory);
		result.put("armor", armor);
		result.put("offhand", UiOps.item(player.getOffhandItem()));
		result.put("lookingAt", lookingAt(client));
		return result;
	}

	private static Map<String, Object> lookingAt(Minecraft client) {
		HitResult current = client.hitResult;
		if (current instanceof BlockHitResult block) {
			return Json.map("type", "block", "pos", List.of(block.getBlockPos().getX(), block.getBlockPos().getY(), block.getBlockPos().getZ()), "face", block.getDirection().getName());
		}
		if (current instanceof EntityHitResult entity) {
			return Json.map("type", "entity", "uuid", entity.getEntity().getUUID().toString(), "name", entity.getEntity().getName().getString());
		}
		return Json.map("type", "miss");
	}

	static Map<String, Object> perf() throws Exception {
		return Ops.onClient(StateOps::perfNow);
	}

	private static Map<String, Object> perfNow() {
		Minecraft client = Minecraft.getInstance();
		IntegratedServer server = client.getSingleplayerServer();
		double mspt = server == null ? 0 : server.getAverageTickTimeNanos() / 1_000_000.0;
		Runtime runtime = Runtime.getRuntime();
		long used = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024);
		long max = runtime.maxMemory() / (1024 * 1024);
		return Json.map(
			"ok", true,
			"fps", client.getFps(),
			"mspt", mspt,
			"tps", mspt <= 0 ? 0 : Math.min(20.0, 1000.0 / mspt),
			"memory", Json.map("used", used, "max", max),
			"entities", client.level == null ? 0 : client.level.getEntityCount(),
			"chunks", client.level == null ? 0 : client.level.getChunkSource().getLoadedChunksCount()
		);
	}

	static GameBridge.Frame frame(boolean hideHud) throws Exception {
		Minecraft client = Minecraft.getInstance();
		boolean previous = Boolean.TRUE.equals(Ops.onClient(() -> client.options.hideGui));
		if (hideHud && !previous) {
			Ops.onClient(() -> {
				client.options.hideGui = true;
				return true;
			});
			Thread.sleep(180);
		}
		try {
			byte[] png = ClientOps.screenshot();
			int[] size = Ops.onClient(() -> new int[] {client.getWindow().getGuiScaledWidth(), client.getWindow().getGuiScaledHeight()});
			return new GameBridge.Frame(png, size[0], size[1]);
		} finally {
			if (hideHud && !previous) {
				Ops.onClient(() -> {
					client.options.hideGui = false;
					return true;
				});
			}
		}
	}

	static synchronized GameBridge.OptionsResult options(List<String> get, Map<String, Object> set) throws Exception {
		GameBridge.OptionsResult result = Ops.onClient(() -> optionsNow(get, set));
		if (result.applied().contains("lang")) ClientOps.reloadResources();
		return result;
	}

	private static GameBridge.OptionsResult optionsNow(List<String> get, Map<String, Object> set) {
		Minecraft client = Minecraft.getInstance();
		Options options = client.options;
		Map<String, Object> values = new LinkedHashMap<>();
		List<String> applied = new ArrayList<>();
		List<String> needsRestart = new ArrayList<>();
		List<String> keys = get.isEmpty() ? new ArrayList<>(set.keySet()) : get;
		for (String key : keys) values.put(key, read(options, key));
		for (Map.Entry<String, Object> entry : set.entrySet()) {
			String key = entry.getKey();
			String value = String.valueOf(entry.getValue());
			try {
				if (write(client, options, key, value)) applied.add(key);
			} catch (RuntimeException error) {
				Companion.log("option " + key + " failed: " + error);
			}
			Object read = read(options, key);
			if (read != null) values.put(key, read);
		}
		return new GameBridge.OptionsResult(values, applied, needsRestart);
	}

	private static Object read(Options options, String key) {
		return switch (key) {
			case "lang" -> options.languageCode;
			case "guiScale" -> options.guiScale().get();
			case "renderDistance" -> options.renderDistance().get();
			case "fov" -> options.fov().get();
			case "gamma" -> options.gamma().get();
			case "hideGui" -> options.hideGui;
			case "maxFps" -> options.framerateLimit().get();
			case "pauseOnLostFocus" -> options.pauseOnLostFocus;
			case "soundCategory_master" -> options.getSoundSourceOptionInstance(SoundSource.MASTER).get();
			default -> null;
		};
	}

	private static boolean write(Minecraft client, Options options, String key, String value) {
		switch (key) {
			case "lang" -> {
				String code = value.toLowerCase(Locale.ROOT);
				options.languageCode = code;
				client.getLanguageManager().setSelected(code);
				return true;
			}
			case "guiScale" -> {
				options.guiScale().set(Integer.parseInt(value.trim()));
				client.resizeGui();
				return true;
			}
			case "renderDistance" -> {
				options.renderDistance().set(Integer.parseInt(value.trim()));
				return true;
			}
			case "fov" -> {
				options.fov().set(Integer.parseInt(value.trim()));
				return true;
			}
			case "gamma" -> {
				options.gamma().set(Double.parseDouble(value.trim()));
				return true;
			}
			case "hideGui" -> {
				options.hideGui = Boolean.parseBoolean(value.trim());
				return true;
			}
			case "maxFps" -> {
				options.framerateLimit().set(Integer.parseInt(value.trim()));
				return true;
			}
			case "pauseOnLostFocus" -> {
				options.pauseOnLostFocus = Boolean.parseBoolean(value.trim());
				return true;
			}
			case "soundCategory_master" -> {
				options.getSoundSourceOptionInstance(SoundSource.MASTER).set(Math.max(0.0, Math.min(1.0, Double.parseDouble(value.trim()))));
				return true;
			}
			default -> {
				return false;
			}
		}
	}
}
