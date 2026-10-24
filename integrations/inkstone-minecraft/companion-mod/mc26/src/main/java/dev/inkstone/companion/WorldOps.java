package dev.inkstone.companion;

import dev.inkstone.companion.core.Companion;
import dev.inkstone.companion.core.GameBridge;
import java.util.concurrent.atomic.AtomicBoolean;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.gamerules.GameRules;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPresets;

final class WorldOps {
	private static final AtomicBoolean RULES_PENDING = new AtomicBoolean(false);

	private WorldOps() {
	}

	static GameBridge.WorldOpen open(String name, boolean create) throws Exception {
		return Ops.onClient(() -> openNow(name, create));
	}

	private static GameBridge.WorldOpen openNow(String name, boolean create) {
		Minecraft client = Minecraft.getInstance();
		if (client.level != null) return new GameBridge.WorldOpen(false, null, false, "already in a world");
		if (client.getLevelSource().levelExists(name)) {
			client.createWorldOpenFlows().openWorld(name, () -> client.setScreen(new TitleScreen()));
			Companion.log("opening world " + name);
			return new GameBridge.WorldOpen(true, name, false, null);
		}
		if (!create) return new GameBridge.WorldOpen(false, null, false, "world not found: " + name);
		LevelSettings settings = new LevelSettings(name, GameType.CREATIVE, new LevelSettings.DifficultySettings(Difficulty.PEACEFUL, false, false), true, WorldDataConfiguration.DEFAULT);
		RULES_PENDING.set(true);
		client.createWorldOpenFlows().createFreshLevel(
			name,
			settings,
			new WorldOptions(20261024L, false, false),
			registries -> registries.lookupOrThrow(Registries.WORLD_PRESET).getOrThrow(WorldPresets.FLAT).value().createWorldDimensions(),
			new TitleScreen()
		);
		Companion.log("creating flat test world " + name);
		return new GameBridge.WorldOpen(true, name, true, null);
	}

	static boolean worldTick() {
		if (!RULES_PENDING.get()) return true;
		Minecraft client = Minecraft.getInstance();
		IntegratedServer server = client.getSingleplayerServer();
		if (server == null || client.player == null) return false;
		RULES_PENDING.set(false);
		server.execute(() -> {
			GameRules rules = server.getGameRules();
			rules.set(GameRules.ADVANCE_TIME, false, server);
			rules.set(GameRules.ADVANCE_WEATHER, false, server);
			rules.set(GameRules.SPAWN_MOBS, false, server);
			rules.set(GameRules.SPAWN_WANDERING_TRADERS, false, server);
		});
		return true;
	}
}
