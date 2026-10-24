package dev.inkstone.companion;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.inkstone.companion.core.Companion;
import dev.inkstone.companion.core.GameBridge;
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
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

final class InputOps {
	private static final Map<String, List<Runnable>> HOLDS = new LinkedHashMap<>();
	private static int holdIds;

	private InputOps() {
	}

	static GameBridge.PlayerLook look() {
		Minecraft client = Minecraft.getInstance();
		LocalPlayer player = client.player;
		if (player == null) throw new IllegalStateException("not in a world");
		Vec3 eye = player.getEyePosition();
		return new GameBridge.PlayerLook(player.getX(), player.getY(), player.getZ(), eye.y, player.getYRot(), player.getXRot(), client.options.fov().get());
	}

	static void setLook(float yaw, float pitch) {
		Minecraft client = Minecraft.getInstance();
		LocalPlayer player = client.player;
		if (player == null) throw new IllegalStateException("not in a world");
		player.setYRot(yaw);
		player.setXRot(Math.max(-90f, Math.min(90f, pitch)));
	}

	static synchronized String hold(JsonObject body) {
		Minecraft client = Minecraft.getInstance();
		if (client.player == null) throw new IllegalStateException("not in a world");
		String action = Json.string(body, "action", "");
		String id = "hold-" + (++holdIds);
		List<Runnable> releases = new ArrayList<>();
		switch (action) {
			case "move" -> {
				double forward = Json.number(body, "forward", 0);
				double strafe = Json.number(body, "strafe", 0);
				if (forward > 0) hold(client.options.keyUp, releases);
				if (forward < 0) hold(client.options.keyDown, releases);
				if (strafe > 0) hold(client.options.keyRight, releases);
				if (strafe < 0) hold(client.options.keyLeft, releases);
				if (Json.bool(body, "jump", false)) hold(client.options.keyJump, releases);
				if (Json.bool(body, "sneak", false)) hold(client.options.keyShift, releases);
				if (Json.bool(body, "sprint", false)) hold(client.options.keySprint, releases);
			}
			case "use" -> hold(client.options.keyUse, releases);
			case "key" -> holdKey(Json.string(body, "key", ""), releases);
			default -> throw new IllegalArgumentException("action " + action + " cannot be held");
		}
		HOLDS.put(id, releases);
		return id;
	}

	private static void hold(KeyMapping binding, List<Runnable> releases) {
		binding.setDown(true);
		releases.add(() -> binding.setDown(false));
	}

	private static void holdKey(String name, List<Runnable> releases) {
		InputConstants.Key key = InputConstants.Type.KEYSYM.getOrCreate(Keys.code(name));
		KeyMapping.set(key, true);
		releases.add(() -> KeyMapping.set(key, false));
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
		KeyMapping.click(InputConstants.Type.KEYSYM.getOrCreate(Keys.code(name)));
	}

	static void hotbar(int slot) {
		Minecraft client = Minecraft.getInstance();
		LocalPlayer player = client.player;
		if (player == null) throw new IllegalStateException("not in a world");
		player.getInventory().setSelectedSlot(Math.max(0, Math.min(8, slot)));
	}

	static Map<String, Object> act(JsonObject body, String entityUuid) {
		Minecraft client = Minecraft.getInstance();
		LocalPlayer player = client.player;
		if (player == null) throw new IllegalStateException("not in a world");
		if (client.gameMode == null) throw new IllegalStateException("no game mode");
		String action = Json.string(body, "action", "attack");
		InteractionHand hand = "off".equals(Json.string(body, "hand", "main")) ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
		JsonObject target = Json.object(body, "target");
		BlockPos blockPos = null;
		Direction face = Direction.UP;
		Entity entity = null;
		if (target != null) {
			double[] block = Json.triple(target, "block");
			if (block != null) {
				blockPos = BlockPos.containing(block[0], block[1], block[2]);
				face = direction(Json.string(target, "face", "up"));
			}
		}
		if (!entityUuid.isBlank()) entity = byUuid(client, entityUuid);
		Map<String, Object> hit;
		if ("attack".equals(action)) {
			if (entity != null) {
				player.swing(hand);
				client.gameMode.attack(player, entity);
				hit = hitEntity(entity);
			} else if (blockPos != null) {
				client.gameMode.startDestroyBlock(blockPos, face);
				hit = hitBlock(blockPos);
			} else {
				hit = crosshairAttack(client, player, hand);
			}
		} else if (entity != null) {
			Vec3 point = entity.getEyePosition();
			client.gameMode.interact(player, entity, new EntityHitResult(entity, point), hand);
			player.swing(hand);
			hit = hitEntity(entity);
		} else if (blockPos != null) {
			client.gameMode.useItemOn(player, hand, new BlockHitResult(Vec3.atCenterOf(blockPos), face, blockPos, false));
			player.swing(hand);
			hit = hitBlock(blockPos);
		} else {
			hit = crosshairUse(client, player, hand);
		}
		return Json.map("ok", true, "hit", hit, "screen", client.screen == null ? null : client.screen.getClass().getSimpleName());
	}

	private static Map<String, Object> crosshairAttack(Minecraft client, LocalPlayer player, InteractionHand hand) {
		HitResult current = client.hitResult;
		if (current instanceof EntityHitResult entityHit) {
			player.swing(hand);
			client.gameMode.attack(player, entityHit.getEntity());
			return hitEntity(entityHit.getEntity());
		}
		if (current instanceof BlockHitResult blockHit) {
			client.gameMode.startDestroyBlock(blockHit.getBlockPos(), blockHit.getDirection());
			return hitBlock(blockHit.getBlockPos());
		}
		player.swing(hand);
		return Json.map("type", "miss");
	}

	private static Map<String, Object> crosshairUse(Minecraft client, LocalPlayer player, InteractionHand hand) {
		HitResult current = client.hitResult;
		if (current instanceof EntityHitResult entityHit) {
			client.gameMode.interact(player, entityHit.getEntity(), entityHit, hand);
			player.swing(hand);
			return hitEntity(entityHit.getEntity());
		}
		if (current instanceof BlockHitResult blockHit) {
			client.gameMode.useItemOn(player, hand, blockHit);
			player.swing(hand);
			return hitBlock(blockHit.getBlockPos());
		}
		client.gameMode.useItem(player, hand);
		player.swing(hand);
		return Json.map("type", "miss");
	}

	static List<GameBridge.EntityRef> select(Selector selector) {
		Minecraft client = Minecraft.getInstance();
		List<GameBridge.EntityRef> refs = new ArrayList<>();
		LocalPlayer player = client.player;
		if (client.level == null || player == null) return refs;
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
				for (Entity entity : client.level.entitiesForRendering()) if (entity.getName().getString().equalsIgnoreCase(selector.name())) candidates.add(entity);
			}
			case Selector.ALL_PLAYERS, Selector.NEAREST_PLAYER -> candidates.addAll(client.level.players());
			default -> {
				for (Entity entity : client.level.entitiesForRendering()) candidates.add(entity);
			}
		}
		for (Entity entity : candidates) {
			if (playersOnly && !(entity instanceof Player)) continue;
			if (!type.isEmpty() && !typeId(entity).equals(type)) continue;
			if (!selector.name().isBlank() && !selector.base().equals(Selector.UUID) && !entity.getName().getString().equalsIgnoreCase(selector.name())) continue;
			double distance = Math.sqrt(entity.distanceToSqr(player));
			if (selector.distance() > 0 && distance > selector.distance()) continue;
			refs.add(new GameBridge.EntityRef(entity.getUUID().toString(), typeId(entity), entity.getName().getString(), entity.getX(), entity.getY(), entity.getZ(), entity.getBbHeight()));
		}
		double originX = player.getX();
		double originY = player.getY();
		double originZ = player.getZ();
		Comparator<GameBridge.EntityRef> order = Comparator.comparingDouble(ref -> {
			double dx = ref.x() - originX;
			double dy = ref.y() - originY;
			double dz = ref.z() - originZ;
			return dx * dx + dy * dy + dz * dz;
		});
		refs.sort("furthest".equals(selector.sort()) ? order.reversed() : order);
		if (refs.size() > selector.limit()) return new ArrayList<>(refs.subList(0, selector.limit()));
		return refs;
	}

	static void glow(String uuid, boolean glowing) {
		Minecraft client = Minecraft.getInstance();
		Entity entity = byUuid(client, uuid);
		if (entity != null) entity.setGlowingTag(glowing);
	}

	private static Entity byUuid(Minecraft client, String uuid) {
		if (uuid == null || uuid.isBlank() || client.level == null) return null;
		UUID wanted;
		try {
			wanted = UUID.fromString(uuid.trim());
		} catch (IllegalArgumentException error) {
			return null;
		}
		for (Entity entity : client.level.entitiesForRendering()) if (entity.getUUID().equals(wanted)) return entity;
		return null;
	}

	private static String typeId(Entity entity) {
		return BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
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
		return Json.map("type", "entity", "entity", Json.map("uuid", entity.getUUID().toString(), "type", typeId(entity), "name", entity.getName().getString()));
	}
}
