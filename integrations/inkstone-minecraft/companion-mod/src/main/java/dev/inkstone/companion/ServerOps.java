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
import net.minecraft.block.BlockState;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.client.MinecraftClient;
import net.minecraft.command.argument.BlockArgumentParser;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityType;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.server.command.CommandOutput;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.integrated.IntegratedServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.world.LightType;
import net.minecraft.world.World;

final class ServerOps {
	private ServerOps() {
	}

	static final class Capture implements CommandOutput {
		final List<String> lines = new CopyOnWriteArrayList<>();

		@Override
		public void sendMessage(Text message) {
			lines.add(message.getString());
		}

		@Override
		public boolean shouldReceiveFeedback() {
			return true;
		}

		@Override
		public boolean shouldTrackOutput() {
			return true;
		}

		@Override
		public boolean shouldBroadcastConsoleToOps() {
			return false;
		}
	}

	static ServerPlayerEntity player(IntegratedServer server) {
		MinecraftClient client = MinecraftClient.getInstance();
		if (client.player == null) return null;
		return server.getPlayerManager().getPlayer(client.player.getUuid());
	}

	static GameBridge.CommandResult command(String raw) throws Exception {
		return Ops.onServer(server -> command(server, raw));
	}

	static GameBridge.CommandResult command(IntegratedServer server, String raw) {
		String command = raw.startsWith("/") ? raw.substring(1) : raw;
		if (command.isBlank()) throw new IllegalArgumentException("empty command");
		Capture capture = new Capture();
		ServerPlayerEntity player = player(server);
		AtomicReference<Boolean> success = new AtomicReference<>(null);
		AtomicInteger value = new AtomicInteger(0);
		ServerCommandSource base = player != null ? player.getCommandSource() : server.getCommandSource();
		ServerCommandSource source = base.withOutput(capture).withLevel(4).withReturnValueConsumer((successful, returnValue) -> {
			success.set(successful);
			value.set(returnValue);
		});
		server.getCommandManager().executeWithPrefix(source, command);
		return new GameBridge.CommandResult("/" + command, capture.lines, success.get(), value.get());
	}

	static ServerWorld world(IntegratedServer server, String dimension) {
		if (dimension != null && !dimension.isBlank()) {
			ServerWorld world = server.getWorld(RegistryKey.of(RegistryKeys.WORLD, Identifier.of(dimension)));
			if (world == null) throw new IllegalArgumentException("unknown dimension " + dimension);
			return world;
		}
		ServerPlayerEntity player = player(server);
		return player != null ? player.getServerWorld() : server.getWorld(World.OVERWORLD);
	}

	static List<String> registryNames() throws Exception {
		return Ops.onServer(server -> {
			List<String> names = new ArrayList<>();
			for (Identifier id : Registries.REGISTRIES.getIds()) names.add(id.toString());
			server.getRegistryManager().streamAllRegistries().forEach(entry -> {
				String id = entry.key().getValue().toString();
				if (!names.contains(id)) names.add(id + " (dynamic)");
			});
			names.sort(String::compareTo);
			return names;
		});
	}

	@SuppressWarnings({"unchecked", "rawtypes"})
	static GameBridge.RegistryData registry(String name) throws Exception {
		return Ops.onServer(server -> {
			Identifier id = Identifier.of(name);
			Registry<?> registry = Registries.REGISTRIES.get(id);
			boolean dynamic = false;
			if (registry == null) {
				Optional<? extends Registry<?>> found = server.getRegistryManager().getOptional((RegistryKey) RegistryKey.ofRegistry(id));
				registry = found.orElse(null);
				dynamic = registry != null;
			}
			if (registry == null) throw new IllegalArgumentException("unknown registry " + name);
			List<String> ids = new ArrayList<>();
			for (Identifier entry : registry.getIds()) ids.add(entry.toString());
			return new GameBridge.RegistryData(id.toString(), dynamic, ids);
		});
	}

	static GameBridge.BlockInfo block(int x, int y, int z, String dimension) throws Exception {
		return Ops.onServer(server -> {
			ServerWorld world = world(server, dimension);
			BlockPos pos = new BlockPos(x, y, z);
			BlockState state = world.getBlockState(pos);
			BlockEntity blockEntity = world.getBlockEntity(pos);
			String nbt = blockEntity == null ? null : blockEntity.createNbtWithIdentifyingData(world.getRegistryManager()).asString();
			return new GameBridge.BlockInfo(
				world.getRegistryKey().getValue().toString(),
				x,
				y,
				z,
				Registries.BLOCK.getId(state.getBlock()).toString(),
				BlockArgumentParser.stringifyBlockState(state),
				nbt,
				world.getLightLevel(LightType.BLOCK, pos),
				world.getLightLevel(LightType.SKY, pos)
			);
		});
	}

	static GameBridge.EntityQuery entities(JsonObject body, int limit) throws Exception {
		return Ops.onServer(server -> {
			ServerWorld world = world(server, Json.string(body, "dimension", ""));
			boolean withNbt = !body.has("nbt") || body.get("nbt").getAsBoolean();
			String type = Json.string(body, "type", "");
			Collection<Entity> found = new ArrayList<>();
			String uuid = Json.string(body, "uuid", "");
			if (!uuid.isBlank()) {
				Entity entity = world.getEntity(UUID.fromString(uuid));
				if (entity != null) found.add(entity);
			} else {
				ServerPlayerEntity player = player(server);
				double cx = Json.number(body, "x", player != null ? player.getX() : 0);
				double cy = Json.number(body, "y", player != null ? player.getY() : 64);
				double cz = Json.number(body, "z", player != null ? player.getZ() : 0);
				double radius = Math.min(256, Json.number(body, "radius", 8));
				Box box = new Box(cx - radius, cy - radius, cz - radius, cx + radius, cy + radius, cz + radius);
				found.addAll(world.getOtherEntities(null, box, entity -> type.isBlank() || EntityType.getId(entity.getType()).toString().equals(type)));
			}
			List<GameBridge.EntityInfo> result = new ArrayList<>();
			for (Entity entity : found) {
				if (result.size() >= limit) break;
				NbtCompound nbt = withNbt ? entity.writeNbt(new NbtCompound()) : null;
				result.add(new GameBridge.EntityInfo(
					entity.getUuidAsString(),
					EntityType.getId(entity.getType()).toString(),
					entity.getName().getString(),
					entity.getX(),
					entity.getY(),
					entity.getZ(),
					nbt == null ? null : nbt.asString()
				));
			}
			return new GameBridge.EntityQuery(world.getRegistryKey().getValue().toString(), found.size(), result);
		});
	}
}
