package dev.inkstone.companion;

import com.google.gson.JsonObject;
import dev.inkstone.companion.core.GameBridge;
import dev.inkstone.companion.core.Companion;
import dev.inkstone.companion.core.Json;
import dev.inkstone.companion.core.Keys;
import dev.inkstone.companion.core.Selector;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.registry.Registries;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

public final class InputOps {
	private static final Map<String, List<Runnable>> HOLDS = new LinkedHashMap<>();
	private static int holdIds;
	private static final List<KeyBinding> PRESSED = new ArrayList<>();

	private InputOps() {
	}

	static GameBridge.PlayerLook look() {
		MinecraftClient client = MinecraftClient.getInstance();
		ClientPlayerEntity player = client.player;
		if (player == null) throw new IllegalStateException("not in a world");
		Vec3d eye = player.getEyePos();
		return new GameBridge.PlayerLook(player.getX(), player.getY(), player.getZ(), eye.y, player.getYaw(), player.getPitch(), client.options.getFov().getValue());
	}

	static void setLook(float yaw, float pitch) {
		MinecraftClient client = MinecraftClient.getInstance();
		ClientPlayerEntity player = client.player;
		if (player == null) throw new IllegalStateException("not in a world");
		player.setYaw(yaw);
		player.setPitch(Math.max(-90f, Math.min(90f, pitch)));
	}

	static synchronized String hold(JsonObject body) {
		MinecraftClient client = MinecraftClient.getInstance();
		if (client.player == null) throw new IllegalStateException("not in a world");
		String action = Json.string(body, "action", "");
		String id = "hold-" + (++holdIds);
		List<Runnable> releases = new ArrayList<>();
		switch (action) {
			case "move" -> {
				double forward = Json.number(body, "forward", 0);
				double strafe = Json.number(body, "strafe", 0);
				if (forward > 0) hold(client.options.forwardKey, releases);
				if (forward < 0) hold(client.options.backKey, releases);
				if (strafe > 0) hold(client.options.rightKey, releases);
				if (strafe < 0) hold(client.options.leftKey, releases);
				if (Json.bool(body, "jump", false)) hold(client.options.jumpKey, releases);
				if (Json.bool(body, "sneak", false)) hold(client.options.sneakKey, releases);
				if (Json.bool(body, "sprint", false)) hold(client.options.sprintKey, releases);
			}
			case "use" -> hold(client.options.useKey, releases);
			case "key" -> holdKey(Json.string(body, "key", ""), releases);
			default -> throw new IllegalArgumentException("action " + action + " cannot be held");
		}
		HOLDS.put(id, releases);
		return id;
	}

	private static void hold(KeyBinding binding, List<Runnable> releases) {
		binding.setPressed(true);
		PRESSED.add(binding);
		releases.add(() -> {
			PRESSED.remove(binding);
			binding.setPressed(false);
		});
	}

	public static synchronized void reassertHolds() {
		for (KeyBinding binding : PRESSED) binding.setPressed(true);
	}

	private static void holdKey(String name, List<Runnable> releases) {
		InputUtil.Key key = InputUtil.Type.KEYSYM.createFromCode(Keys.code(name));
		KeyBinding.setKeyPressed(key, true);
		releases.add(() -> KeyBinding.setKeyPressed(key, false));
	}

	static synchronized void release(String id) {
		List<Runnable> releases = HOLDS.remove(id);
		if (releases == null) return;
		for (Runnable release : releases) {
			try {
				release.run();
			} catch (RuntimeException error) {
				Companion.log("release hold failed: " + error);
			}
		}
	}

	static void pressKey(String name) {
		InputUtil.Key key = InputUtil.Type.KEYSYM.createFromCode(Keys.code(name));
		KeyBinding.onKeyPressed(key);
	}

	static void hotbar(int slot) {
		MinecraftClient client = MinecraftClient.getInstance();
		ClientPlayerEntity player = client.player;
		if (player == null) throw new IllegalStateException("not in a world");
		player.getInventory().selectedSlot = Math.max(0, Math.min(8, slot));
	}

	static Map<String, Object> act(JsonObject body, String entityUuid) {
		MinecraftClient client = MinecraftClient.getInstance();
		ClientPlayerEntity player = client.player;
		if (player == null) throw new IllegalStateException("not in a world");
		if (client.interactionManager == null) throw new IllegalStateException("no interaction manager");
		String action = Json.string(body, "action", "attack");
		Hand hand = "off".equals(Json.string(body, "hand", "main")) ? Hand.OFF_HAND : Hand.MAIN_HAND;
		JsonObject target = Json.object(body, "target");
		BlockPos blockPos = null;
		Direction face = Direction.UP;
		Entity entity = null;
		if (target != null) {
			double[] block = Json.triple(target, "block");
			if (block != null) {
				blockPos = BlockPos.ofFloored(block[0], block[1], block[2]);
				face = direction(Json.string(target, "face", "up"));
			}
		}
		if (!entityUuid.isBlank()) entity = byUuid(client, entityUuid);
		Map<String, Object> hit;
		if ("attack".equals(action)) {
			if (entity != null) {
				player.swingHand(hand);
				client.interactionManager.attackEntity(player, entity);
				hit = hitEntity(entity);
			} else if (blockPos != null) {
				client.interactionManager.attackBlock(blockPos, face);
				hit = hitBlock(blockPos);
			} else {
				hit = crosshairAttack(client, player, hand);
			}
		} else if (entity != null) {
			client.interactionManager.interactEntity(player, entity, hand);
			player.swingHand(hand);
			hit = hitEntity(entity);
		} else if (blockPos != null) {
			hit = hitBlock(blockPos);
			if (!client.interactionManager.interactBlock(player, hand, new BlockHitResult(Vec3d.ofCenter(blockPos), face, blockPos, false)).isAccepted()) hit = fallbackUse(client, player, hand, hit);
			player.swingHand(hand);
		} else {
			hit = crosshairUse(client, player, hand);
		}
		return Json.map("ok", true, "hit", hit, "screen", client.currentScreen == null ? null : client.currentScreen.getClass().getSimpleName());
	}

	private static Map<String, Object> crosshairAttack(MinecraftClient client, ClientPlayerEntity player, Hand hand) {
		HitResult current = client.crosshairTarget;
		if (current instanceof EntityHitResult entityHit) {
			player.swingHand(hand);
			client.interactionManager.attackEntity(player, entityHit.getEntity());
			return hitEntity(entityHit.getEntity());
		}
		if (current instanceof BlockHitResult blockHit) {
			client.interactionManager.attackBlock(blockHit.getBlockPos(), blockHit.getSide());
			return hitBlock(blockHit.getBlockPos());
		}
		player.swingHand(hand);
		return Json.map("type", "miss");
	}

	private static Map<String, Object> fallbackUse(MinecraftClient client, ClientPlayerEntity player, Hand hand, Map<String, Object> target) {
		boolean used = client.interactionManager.interactItem(player, hand).isAccepted();
		Map<String, Object> hit = new LinkedHashMap<>(target);
		hit.put("fallback", used ? "item" : "none");
		return hit;
	}

	private static Map<String, Object> crosshairUse(MinecraftClient client, ClientPlayerEntity player, Hand hand) {
		HitResult current = client.crosshairTarget;
		if (current instanceof EntityHitResult entityHit) {
			Map<String, Object> hit = hitEntity(entityHit.getEntity());
			if (!client.interactionManager.interactEntity(player, entityHit.getEntity(), hand).isAccepted()) hit = fallbackUse(client, player, hand, hit);
			player.swingHand(hand);
			return hit;
		}
		if (current instanceof BlockHitResult blockHit) {
			Map<String, Object> hit = hitBlock(blockHit.getBlockPos());
			if (!client.interactionManager.interactBlock(player, hand, blockHit).isAccepted()) hit = fallbackUse(client, player, hand, hit);
			player.swingHand(hand);
			return hit;
		}
		client.interactionManager.interactItem(player, hand);
		player.swingHand(hand);
		return Json.map("type", "miss");
	}

	static List<GameBridge.EntityRef> select(Selector selector) {
		MinecraftClient client = MinecraftClient.getInstance();
		List<GameBridge.EntityRef> refs = new ArrayList<>();
		ClientPlayerEntity player = client.player;
		if (client.world == null || player == null) return refs;
		List<Entity> candidates = new ArrayList<>();
		String type = typeId(selector.type());
		boolean playersOnly = Selector.ALL_PLAYERS.equals(selector.base()) || Selector.NEAREST_PLAYER.equals(selector.base());
		switch (selector.base()) {
			case Selector.SELF -> candidates.add(player);
			case Selector.UUID -> {
				Entity found = byUuid(client, selector.name());
				if (found != null) candidates.add(found);
			}
			case Selector.NAME -> {
				for (Entity entity : client.world.getEntities()) if (entity.getName().getString().equalsIgnoreCase(selector.name())) candidates.add(entity);
			}
			case Selector.ALL_PLAYERS, Selector.NEAREST_PLAYER -> candidates.addAll(client.world.getPlayers());
			default -> {
				for (Entity entity : client.world.getEntities()) candidates.add(entity);
			}
		}
		for (Entity entity : candidates) {
			if (playersOnly && !(entity instanceof PlayerEntity)) continue;
			if (!type.isEmpty() && !typeId(entity).equals(type)) continue;
			if (!selector.name().isBlank() && !selector.base().equals(Selector.UUID) && !entity.getName().getString().equalsIgnoreCase(selector.name())) continue;
			double distance = Math.sqrt(entity.squaredDistanceTo(player));
			if (selector.distance() > 0 && distance > selector.distance()) continue;
			refs.add(new GameBridge.EntityRef(entity.getUuidAsString(), typeId(entity), entity.getName().getString(), entity.getX(), entity.getY(), entity.getZ(), entity.getHeight()));
		}
		Vec3d origin = player.getPos();
		Comparator<GameBridge.EntityRef> order = Comparator.comparingDouble(ref -> {
			double dx = ref.x() - origin.x;
			double dy = ref.y() - origin.y;
			double dz = ref.z() - origin.z;
			return dx * dx + dy * dy + dz * dz;
		});
		refs.sort("furthest".equals(selector.sort()) ? order.reversed() : order);
		if (refs.size() > selector.limit()) return new ArrayList<>(refs.subList(0, selector.limit()));
		return refs;
	}

	static void glow(String uuid, boolean glowing) {
		MinecraftClient client = MinecraftClient.getInstance();
		Entity entity = byUuid(client, uuid);
		if (entity != null) ((EntityFlags) entity).inkstoneSetGlowing(glowing);
	}

	private static Entity byUuid(MinecraftClient client, String uuid) {
		if (uuid == null || uuid.isBlank() || client.world == null) return null;
		UUID wanted;
		try {
			wanted = UUID.fromString(uuid.trim());
		} catch (IllegalArgumentException error) {
			return null;
		}
		for (Entity entity : client.world.getEntities()) if (entity.getUuid().equals(wanted)) return entity;
		return null;
	}

	private static String typeId(Entity entity) {
		return Registries.ENTITY_TYPE.getId(entity.getType()).toString();
	}

	private static String typeId(String raw) {
		String value = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
		if (value.isEmpty()) return "";
		return value.indexOf(':') >= 0 ? value : "minecraft:" + value;
	}

	private static Direction direction(String face) {
		return switch (face == null ? "up" : face.toLowerCase(Locale.ROOT)) {
			case "down" -> Direction.DOWN;
			case "north" -> Direction.NORTH;
			case "south" -> Direction.SOUTH;
			case "west" -> Direction.WEST;
			case "east" -> Direction.EAST;
			default -> Direction.UP;
		};
	}

	private static Map<String, Object> hitBlock(BlockPos pos) {
		return Json.map("type", "block", "pos", List.of(pos.getX(), pos.getY(), pos.getZ()));
	}

	private static Map<String, Object> hitEntity(Entity entity) {
		return Json.map("type", "entity", "entity", Json.map("uuid", entity.getUuidAsString(), "type", typeId(entity), "name", entity.getName().getString()));
	}
}
