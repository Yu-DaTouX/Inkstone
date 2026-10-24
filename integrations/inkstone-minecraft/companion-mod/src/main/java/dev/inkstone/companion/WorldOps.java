package dev.inkstone.companion;

import dev.inkstone.companion.core.Companion;
import dev.inkstone.companion.core.GameBridge;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.resource.DataConfiguration;
import net.minecraft.world.Difficulty;
import net.minecraft.world.GameMode;
import net.minecraft.world.GameRules;
import net.minecraft.world.gen.GeneratorOptions;
import net.minecraft.world.gen.WorldPresets;
import net.minecraft.world.level.LevelInfo;

final class WorldOps {
	private WorldOps() {
	}

	static GameBridge.WorldOpen open(String name, boolean create) throws Exception {
		return Ops.onClient(() -> openNow(name, create));
	}

	private static GameBridge.WorldOpen openNow(String name, boolean create) {
		MinecraftClient client = MinecraftClient.getInstance();
		if (client.world != null) return new GameBridge.WorldOpen(false, null, false, "already in a world");
		boolean exists = client.getLevelStorage().levelExists(name);
		if (exists) {
			client.createIntegratedServerLoader().start(name, () -> client.setScreen(new TitleScreen()));
			Companion.log("opening world " + name);
			return new GameBridge.WorldOpen(true, name, false, null);
		}
		if (!create) return new GameBridge.WorldOpen(false, null, false, "world not found: " + name);
		GameRules rules = new GameRules();
		rules.get(GameRules.DO_DAYLIGHT_CYCLE).set(false, null);
		rules.get(GameRules.DO_WEATHER_CYCLE).set(false, null);
		rules.get(GameRules.DO_MOB_SPAWNING).set(false, null);
		rules.get(GameRules.DO_TRADER_SPAWNING).set(false, null);
		LevelInfo info = new LevelInfo(name, GameMode.CREATIVE, false, Difficulty.PEACEFUL, true, rules, DataConfiguration.SAFE_MODE);
		GeneratorOptions options = new GeneratorOptions(20261024L, false, false);
		client.createIntegratedServerLoader().createAndStart(
			name,
			info,
			options,
			registries -> registries.getWrapperOrThrow(RegistryKeys.WORLD_PRESET).getOrThrow(WorldPresets.FLAT).value().createDimensionsRegistryHolder(),
			new TitleScreen()
		);
		Companion.log("creating flat test world " + name);
		return new GameBridge.WorldOpen(true, name, true, null);
	}
}
