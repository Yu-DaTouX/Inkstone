package dev.inkstone.companion;

import dev.inkstone.companion.core.GameBridge;
import dev.inkstone.companion.core.Companion;
import dev.inkstone.companion.core.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.GameOptions;
import net.minecraft.client.option.GraphicsMode;
import net.minecraft.client.util.Window;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.effect.StatusEffectInstance;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.server.integrated.IntegratedServer;
import net.minecraft.sound.SoundCategory;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;

final class StateOps {
	private StateOps() {
	}

	static Map<String, Object> env() throws Exception {
		return Ops.onClient(StateOps::envNow);
	}

	private static Map<String, Object> envNow() {
		MinecraftClient client = MinecraftClient.getInstance();
		IntegratedServer server = client.getServer();
		ClientPlayerEntity player = client.player;
		Map<String, Object> env = new LinkedHashMap<>();
		env.put("world", server == null ? null : server.getSaveProperties().getLevelName());
		env.put("version", net.minecraft.SharedConstants.getGameVersion().getName());
		env.put("difficulty", client.world == null ? "" : client.world.getDifficulty().getName());
		env.put("gamemode", client.interactionManager == null || client.interactionManager.getCurrentGameMode() == null ? "" : client.interactionManager.getCurrentGameMode().getName());
		env.put("lang", client.options.language);
		env.put("pos", player == null ? null : List.of(player.getX(), player.getY(), player.getZ()));
		env.put("dimension", player == null ? "" : player.getWorld().getRegistryKey().getValue().toString());
		env.put("paused", client.isPaused());
		return env;
	}

	static Map<String, Object> player() throws Exception {
		return Ops.onClient(StateOps::playerNow);
	}

	private static Map<String, Object> playerNow() {
		MinecraftClient client = MinecraftClient.getInstance();
		ClientPlayerEntity player = client.player;
		if (player == null) throw new IllegalStateException("not in a world");
		List<Object> effects = new ArrayList<>();
		for (StatusEffectInstance effect : player.getStatusEffects()) {
			effects.add(Json.map(
				"id", Registries.STATUS_EFFECT.getId(effect.getEffectType().value()).toString(),
				"amplifier", effect.getAmplifier(),
				"duration", effect.getDuration()
			));
		}
		List<Object> inventory = new ArrayList<>();
		for (int slot = 0; slot < 36; slot++) inventory.add(Json.map("slot", slot, "item", UiOps.item(player.getInventory().getStack(slot))));
		List<Object> armor = new ArrayList<>();
		for (int slot = 0; slot < 4; slot++) armor.add(UiOps.item(player.getInventory().getArmorStack(slot)));
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("ok", true);
		result.put("name", player.getName().getString());
		result.put("uuid", player.getUuidAsString());
		result.put("pos", List.of(player.getX(), player.getY(), player.getZ()));
		result.put("rot", List.of(player.getYaw(), player.getPitch()));
		result.put("dimension", player.getWorld().getRegistryKey().getValue().toString());
		result.put("health", player.getHealth());
		result.put("maxHealth", player.getMaxHealth());
		result.put("absorption", player.getAbsorptionAmount());
		result.put("food", player.getHungerManager().getFoodLevel());
		result.put("saturation", player.getHungerManager().getSaturationLevel());
		result.put("xp", Json.map("level", player.experienceLevel, "progress", player.experienceProgress));
		result.put("gamemode", client.interactionManager == null || client.interactionManager.getCurrentGameMode() == null ? "" : client.interactionManager.getCurrentGameMode().getName());
		result.put("invulnerable", player.isInvulnerable());
		result.put("onGround", player.isOnGround());
		result.put("effects", effects);
		result.put("selectedSlot", player.getInventory().selectedSlot);
		result.put("inventory", inventory);
		result.put("armor", armor);
		result.put("offhand", UiOps.item(player.getInventory().getStack(40)));
		result.put("lookingAt", lookingAt(client));
		result.put("eye", player.getEyePos().y);
		return result;
	}

	private static Map<String, Object> lookingAt(MinecraftClient client) {
		HitResult current = client.crosshairTarget;
		if (current instanceof BlockHitResult block) {
			return Json.map("type", "block", "pos", List.of(block.getBlockPos().getX(), block.getBlockPos().getY(), block.getBlockPos().getZ()), "face", block.getSide().getName());
		}
		if (current instanceof EntityHitResult entity) {
			return Json.map("type", "entity", "uuid", entity.getEntity().getUuidAsString(), "name", entity.getEntity().getName().getString());
		}
		return Json.map("type", "miss");
	}

	static Map<String, Object> perf() throws Exception {
		return Ops.onClient(StateOps::perfNow);
	}

	private static Map<String, Object> perfNow() {
		MinecraftClient client = MinecraftClient.getInstance();
		IntegratedServer server = client.getServer();
		double mspt = server == null ? 0 : server.getAverageNanosPerTick() / 1_000_000.0;
		Runtime runtime = Runtime.getRuntime();
		long used = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024);
		long max = runtime.maxMemory() / (1024 * 1024);
		return Json.map(
			"ok", true,
			"fps", client.getCurrentFps(),
			"mspt", mspt,
			"tps", mspt <= 0 ? 0 : Math.min(20.0, 1000.0 / mspt),
			"memory", Json.map("used", used, "max", max),
			"entities", client.world == null ? 0 : client.world.getRegularEntityCount(),
			"chunks", client.world == null ? 0 : client.world.getChunkManager().getLoadedChunkCount()
		);
	}

	static GameBridge.Frame frame(boolean hideHud) throws Exception {
		MinecraftClient client = MinecraftClient.getInstance();
		boolean previous = Boolean.TRUE.equals(Ops.onClient(() -> client.options.hudHidden));
		if (hideHud && !previous) {
			Ops.onClient(() -> {
				client.options.hudHidden = true;
				return true;
			});
			Thread.sleep(180);
		}
		try {
			byte[] png = Ops.onClient(ClientOps::screenshot);
			int[] size = Ops.onClient(() -> {
				Window window = client.getWindow();
				return new int[] {window.getScaledWidth(), window.getScaledHeight()};
			});
			return new GameBridge.Frame(png, size[0], size[1]);
		} finally {
			if (hideHud && !previous) {
				Ops.onClient(() -> {
					client.options.hudHidden = false;
					return true;
				});
			}
		}
	}

	static GameBridge.OptionsResult options(List<String> get, Map<String, Object> set) throws Exception {
		return Ops.onClient(() -> optionsNow(get, set));
	}

	private static GameBridge.OptionsResult optionsNow(List<String> get, Map<String, Object> set) {
		MinecraftClient client = MinecraftClient.getInstance();
		GameOptions options = client.options;
		Map<String, Object> values = new LinkedHashMap<>();
		List<String> applied = new ArrayList<>();
		List<String> needsRestart = new ArrayList<>();
		List<String> keys = get.isEmpty() ? new ArrayList<>(set.keySet()) : get;
		for (String key : keys) values.put(key, read(client, options, key));
		for (Map.Entry<String, Object> entry : set.entrySet()) {
			String key = entry.getKey();
			String value = String.valueOf(entry.getValue());
			try {
				if (write(client, options, key, value)) applied.add(key);
			} catch (RuntimeException error) {
				Companion.log("option " + key + " failed: " + error);
			}
			Object read = read(client, options, key);
			if (read != null) values.put(key, read);
		}
		return new GameBridge.OptionsResult(values, applied, needsRestart);
	}

	private static Object read(MinecraftClient client, GameOptions options, String key) {
		return switch (key) {
			case "lang" -> options.language;
			case "guiScale" -> options.getGuiScale().getValue();
			case "renderDistance" -> options.getViewDistance().getValue();
			case "fov" -> options.getFov().getValue();
			case "gamma" -> options.getGamma().getValue();
			case "hideGui" -> options.hudHidden;
			case "maxFps" -> options.getMaxFps().getValue();
			case "pauseOnLostFocus" -> options.pauseOnLostFocus;
			case "fancyGraphics" -> options.getGraphicsMode().getValue() == GraphicsMode.FANCY;
			case "soundCategory_master" -> options.getSoundVolume(SoundCategory.MASTER);
			default -> null;
		};
	}

	private static boolean write(MinecraftClient client, GameOptions options, String key, String value) {
		switch (key) {
			case "lang" -> {
				String code = value.toLowerCase(Locale.ROOT);
				options.language = code;
				client.getLanguageManager().setLanguage(code);
				client.reloadResources();
				return true;
			}
			case "guiScale" -> {
				options.getGuiScale().setValue(Integer.parseInt(value.trim()));
				client.onResolutionChanged();
				return true;
			}
			case "renderDistance" -> {
				options.getViewDistance().setValue(Integer.parseInt(value.trim()));
				return true;
			}
			case "fov" -> {
				options.getFov().setValue(Integer.parseInt(value.trim()));
				return true;
			}
			case "gamma" -> {
				options.getGamma().setValue(Double.parseDouble(value.trim()));
				return true;
			}
			case "hideGui" -> {
				options.hudHidden = Boolean.parseBoolean(value.trim());
				return true;
			}
			case "maxFps" -> {
				options.getMaxFps().setValue(Integer.parseInt(value.trim()));
				return true;
			}
			case "pauseOnLostFocus" -> {
				options.pauseOnLostFocus = Boolean.parseBoolean(value.trim());
				return true;
			}
			case "fancyGraphics" -> {
				options.getGraphicsMode().setValue(Boolean.parseBoolean(value.trim()) ? GraphicsMode.FANCY : GraphicsMode.FAST);
				return true;
			}
			case "soundCategory_master" -> {
				options.getSoundVolumeOption(SoundCategory.MASTER).setValue(Math.max(0.0, Math.min(1.0, Double.parseDouble(value.trim()))));
				return true;
			}
			default -> {
				return false;
			}
		}
	}
}
