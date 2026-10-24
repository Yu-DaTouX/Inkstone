package dev.inkstone.companion;

import com.google.gson.JsonObject;
import dev.inkstone.companion.core.GameBridge;
import dev.inkstone.companion.core.Json;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.LevelBasedPermissionSet;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.TagValueOutput;
import net.minecraft.world.phys.AABB;

final class ServerOps {
	private ServerOps() {
	}

	static final class Capture implements CommandSource {
		final List<String> lines = new CopyOnWriteArrayList<>();

		@Override
		public void sendSystemMessage(Component message) {
			lines.add(message.getString());
		}

		@Override
		public boolean acceptsSuccess() {
			return true;
		}

		@Override
		public boolean acceptsFailure() {
			return true;
		}

		@Override
		public boolean shouldInformAdmins() {
			return false;
		}
	}

	static ServerPlayer player(IntegratedServer server) {
		Minecraft client = Minecraft.getInstance();
		if (client.player == null) return null;
		return server.getPlayerList().getPlayer(client.player.getUUID());
	}

	static GameBridge.CommandResult command(String raw) throws Exception {
		return Ops.onServer(server -> command(server, raw));
	}

	static GameBridge.CommandResult command(IntegratedServer server, String raw) {
		String command = raw.startsWith("/") ? raw.substring(1) : raw;
		if (command.isBlank()) throw new IllegalArgumentException("empty command");
		Capture capture = new Capture();
		ServerPlayer player = player(server);
		AtomicReference<Boolean> success = new AtomicReference<>(null);
		AtomicInteger value = new AtomicInteger(0);
		CommandSourceStack base = player != null ? player.createCommandSourceStack() : server.createCommandSourceStack();
		CommandSourceStack source = base.withSource(capture).withPermission(LevelBasedPermissionSet.OWNER).withCallback((successful, result) -> {
			success.set(successful);
			value.set(result);
		});
		server.getCommands().performPrefixedCommand(source, command);
		return new GameBridge.CommandResult("/" + command, capture.lines, success.get(), value.get());
	}

	static ServerLevel level(IntegratedServer server, String dimension) {
		if (dimension != null && !dimension.isBlank()) {
			ServerLevel level = server.getLevel(ResourceKey.create(Registries.DIMENSION, Identifier.parse(dimension)));
			if (level == null) throw new IllegalArgumentException("unknown dimension " + dimension);
			return level;
		}
		ServerPlayer player = player(server);
		return player != null ? player.level() : server.getLevel(Level.OVERWORLD);
	}

	static List<String> registryNames() throws Exception {
		return Ops.onServer(server -> {
			List<String> names = new ArrayList<>();
			for (Identifier id : BuiltInRegistries.REGISTRY.keySet()) names.add(id.toString());
			server.registryAccess().registries().forEach(entry -> {
				String id = entry.key().identifier().toString();
				if (!names.contains(id)) names.add(id + " (dynamic)");
			});
			names.sort(String::compareTo);
			return names;
		});
	}

	static GameBridge.RegistryData registry(String name) throws Exception {
		return Ops.onServer(server -> {
			Identifier id = Identifier.parse(name);
			Registry<?> registry = BuiltInRegistries.REGISTRY.getValue(id);
			boolean dynamic = false;
			if (registry == null) {
				Optional<? extends Registry<?>> found = server.registryAccess().lookup(ResourceKey.createRegistryKey(id));
				registry = found.orElse(null);
				dynamic = registry != null;
			}
			if (registry == null) throw new IllegalArgumentException("unknown registry " + name);
			List<String> ids = new ArrayList<>();
			for (Identifier entry : registry.keySet()) ids.add(entry.toString());
			return new GameBridge.RegistryData(id.toString(), dynamic, ids);
		});
	}

	static GameBridge.BlockInfo block(int x, int y, int z, String dimension) throws Exception {
		return Ops.onServer(server -> {
			ServerLevel level = level(server, dimension);
			BlockPos pos = new BlockPos(x, y, z);
			BlockState state = level.getBlockState(pos);
			BlockEntity blockEntity = level.getBlockEntity(pos);
			String nbt = blockEntity == null ? null : blockEntity.saveWithFullMetadata(level.registryAccess()).toString();
			return new GameBridge.BlockInfo(
				level.dimension().identifier().toString(),
				x,
				y,
				z,
				BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(),
				BlockStateParser.serialize(state),
				nbt,
				level.getBrightness(LightLayer.BLOCK, pos),
				level.getBrightness(LightLayer.SKY, pos)
			);
		});
	}

	static GameBridge.EntityQuery entities(JsonObject body, int limit) throws Exception {
		return Ops.onServer(server -> {
			ServerLevel level = level(server, Json.string(body, "dimension", ""));
			boolean withNbt = !body.has("nbt") || body.get("nbt").getAsBoolean();
			String type = Json.string(body, "type", "");
			Collection<Entity> found = new ArrayList<>();
			String uuid = Json.string(body, "uuid", "");
			if (!uuid.isBlank()) {
				Entity entity = level.getEntity(UUID.fromString(uuid));
				if (entity != null) found.add(entity);
			} else {
				ServerPlayer player = player(server);
				double cx = Json.number(body, "x", player != null ? player.getX() : 0);
				double cy = Json.number(body, "y", player != null ? player.getY() : 64);
				double cz = Json.number(body, "z", player != null ? player.getZ() : 0);
				double radius = Math.min(256, Json.number(body, "radius", 8));
				AABB box = new AABB(cx - radius, cy - radius, cz - radius, cx + radius, cy + radius, cz + radius);
				found.addAll(level.getEntities((Entity) null, box, entity -> type.isBlank() || EntityType.getKey(entity.getType()).toString().equals(type)));
			}
			List<GameBridge.EntityInfo> result = new ArrayList<>();
			for (Entity entity : found) {
				if (result.size() >= limit) break;
				String nbt = null;
				if (withNbt) {
					TagValueOutput output = TagValueOutput.createWithContext(ProblemReporter.DISCARDING, level.registryAccess());
					entity.saveWithoutId(output);
					nbt = output.buildResult().toString();
				}
				result.add(new GameBridge.EntityInfo(
					entity.getStringUUID(),
					EntityType.getKey(entity.getType()).toString(),
					entity.getName().getString(),
					entity.getX(),
					entity.getY(),
					entity.getZ(),
					nbt
				));
			}
			return new GameBridge.EntityQuery(level.dimension().identifier().toString(), found.size(), result);
		});
	}
}
