package dev.inkstone.companion.core;

public record Selector(String base, String type, String name, double distance, int limit, String sort) {
	public static final String ALL_ENTITIES = "e";
	public static final String ALL_PLAYERS = "a";
	public static final String NEAREST_PLAYER = "p";
	public static final String SELF = "s";
	public static final String UUID = "uuid";
	public static final String NAME = "name";

	public static Selector parse(String raw) {
		String text = raw == null ? "" : raw.trim();
		if (text.isEmpty()) throw new IllegalArgumentException("entity selector is empty");
		if (!text.startsWith("@")) {
			if (text.length() == 36 && text.indexOf('-') > 0) return new Selector(UUID, "", text, 0, 1, "nearest");
			return new Selector(NAME, "", text, 0, 1, "nearest");
		}
		char base = text.length() > 1 ? Character.toLowerCase(text.charAt(1)) : 'e';
		String kind = switch (base) {
			case 'a' -> ALL_PLAYERS;
			case 'p' -> NEAREST_PLAYER;
			case 's' -> SELF;
			default -> ALL_ENTITIES;
		};
		String type = "";
		String name = "";
		double distance = 0;
		int limit = 1;
		String sort = "nearest";
		int open = text.indexOf('[');
		if (open < 0) return new Selector(kind, type, name, distance, limit, sort);
		int close = text.lastIndexOf(']');
		String body = text.substring(open + 1, close < open ? text.length() : close);
		for (String part : body.split(",")) {
			String entry = part.trim();
			if (entry.isEmpty()) continue;
			int equals = entry.indexOf('=');
			if (equals <= 0) continue;
			String key = entry.substring(0, equals).trim().toLowerCase();
			String value = entry.substring(equals + 1).trim();
			if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) value = value.substring(1, value.length() - 1);
			switch (key) {
				case "type" -> type = value;
				case "name" -> { if (!value.startsWith("!")) name = value; }
				case "distance" -> distance = distanceValue(value);
				case "limit" -> limit = Math.max(1, Integer.parseInt(value));
				case "sort" -> sort = value.toLowerCase();
				default -> {
				}
			}
		}
		return new Selector(kind, type, name, distance, Math.min(256, limit), sort);
	}

	private static double distanceValue(String value) {
		double nearest = 0;
		for (String part : value.split("\\.\\.")) {
			String item = part.trim();
			if (item.isEmpty()) continue;
			try {
				nearest = Math.max(nearest, Double.parseDouble(item));
			} catch (NumberFormatException ignored) {
			}
		}
		return nearest;
	}
}
