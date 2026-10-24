package dev.inkstone.companion.core;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class Highlights {
	private static final int MAX_SECONDS = 600;
	private static final int EDGE_SAMPLES = 24;
	private static final Map<String, Long> ENTITIES = new ConcurrentHashMap<>();
	private static final Map<String, Block> BLOCKS = new ConcurrentHashMap<>();
	private static int ids;

	private Highlights() {
	}

	public static Map<String, Object> apply(JsonObject body, GameBridge bridge) throws Exception {
		String action = Json.string(body, "action", "");
		if ("clear".equals(action)) {
			int cleared = ENTITIES.size() + BLOCKS.size();
			List<String> uuids = new ArrayList<>(ENTITIES.keySet());
			ENTITIES.clear();
			BLOCKS.clear();
			for (String uuid : uuids) {
				try {
					bridge.glow(uuid, false);
				} catch (Exception error) {
					Companion.log("clear highlight failed for " + uuid + ": " + error);
				}
			}
			return Json.map("ok", true, "id", null, "until", null, "cleared", cleared);
		}
		int seconds = Math.max(1, Math.min(MAX_SECONDS, Json.integer(body, "seconds", 30)));
		long until = System.currentTimeMillis() + seconds * 1000L;
		if ("entity".equals(action)) {
			String raw = Json.string(body, "selector", "");
			if (raw.isBlank()) raw = Json.string(body, "uuid", "");
			if (raw.isBlank()) throw new IllegalArgumentException("entity highlight needs selector or uuid");
			List<GameBridge.EntityRef> refs = bridge.select(Selector.parse(raw));
			if (refs.isEmpty()) return Json.map("ok", false, "error", "no entity matches " + raw);
			List<Object> listed = new ArrayList<>();
			for (GameBridge.EntityRef ref : refs) {
				bridge.glow(ref.uuid(), true);
				ENTITIES.put(ref.uuid(), until);
				listed.add(ref.uuid());
			}
			return Json.map("ok", true, "id", "entity-" + (++ids), "until", until, "entities", listed);
		}
		if ("block".equals(action)) {
			double[] pos = Json.triple(body, "pos");
			if (pos == null) throw new IllegalArgumentException("block highlight needs pos [x,y,z]");
			String id = "block-" + (++ids);
			BLOCKS.put(id, new Block((int) Math.floor(pos[0]), (int) Math.floor(pos[1]), (int) Math.floor(pos[2]), color(Json.string(body, "color", "#ffffff")), until));
			return Json.map("ok", true, "id", id, "until", until);
		}
		throw new IllegalArgumentException("action must be entity, block or clear");
	}

	static void tick(GameBridge bridge) {
		long now = System.currentTimeMillis();
		List<String> expired = new ArrayList<>();
		Iterator<Map.Entry<String, Long>> entities = ENTITIES.entrySet().iterator();
		while (entities.hasNext()) {
			Map.Entry<String, Long> entry = entities.next();
			if (entry.getValue() <= now) {
				expired.add(entry.getKey());
				entities.remove();
			}
		}
		BLOCKS.values().removeIf(block -> block.until() <= now);
		for (String uuid : expired) {
			try {
				bridge.glow(uuid, false);
			} catch (Exception error) {
				Companion.log("expire highlight failed for " + uuid + ": " + error);
			}
		}
	}

	public static int count() {
		return ENTITIES.size() + BLOCKS.size();
	}

	public static List<int[]> points(double[] eye, float yaw, float pitch, float fov, int width, int height) {
		List<int[]> points = new ArrayList<>();
		if (BLOCKS.isEmpty() || width <= 0 || height <= 0) return points;
		double[] out = new double[3];
		for (Block block : BLOCKS.values()) {
			for (double[][] edge : edges(block)) {
				for (int step = 0; step <= EDGE_SAMPLES; step++) {
					double ratio = (double) step / EDGE_SAMPLES;
					double[] point = {
						edge[0][0] + (edge[1][0] - edge[0][0]) * ratio,
						edge[0][1] + (edge[1][1] - edge[0][1]) * ratio,
						edge[0][2] + (edge[1][2] - edge[0][2]) * ratio
					};
					if (!Aim.project(eye, yaw, pitch, fov, point, width, height, out)) continue;
					int x = (int) Math.round(out[0]);
					int y = (int) Math.round(out[1]);
					if (x < 0 || y < 0 || x >= width || y >= height) continue;
					points.add(new int[] {x, y, block.color()});
				}
			}
		}
		return points;
	}

	private static List<double[][]> edges(Block block) {
		double minX = block.x();
		double minY = block.y();
		double minZ = block.z();
		double maxX = minX + 1;
		double maxY = minY + 1;
		double maxZ = minZ + 1;
		double[][] corners = {
			{minX, minY, minZ}, {maxX, minY, minZ}, {maxX, minY, maxZ}, {minX, minY, maxZ},
			{minX, maxY, minZ}, {maxX, maxY, minZ}, {maxX, maxY, maxZ}, {minX, maxY, maxZ}
		};
		int[][] pairs = {{0, 1}, {1, 2}, {2, 3}, {3, 0}, {4, 5}, {5, 6}, {6, 7}, {7, 4}, {0, 4}, {1, 5}, {2, 6}, {3, 7}};
		List<double[][]> edges = new ArrayList<>();
		for (int[] pair : pairs) edges.add(new double[][] {corners[pair[0]], corners[pair[1]]});
		return edges;
	}

	private static int color(String text) {
		String value = text == null ? "" : text.trim();
		if (value.startsWith("#")) value = value.substring(1);
		if (value.length() != 6) return 0xFFFFFFFF;
		try {
			return 0xFF000000 | Integer.parseInt(value, 16);
		} catch (NumberFormatException error) {
			return 0xFFFFFFFF;
		}
	}

	public record Block(int x, int y, int z, int color, long until) {
	}
}
