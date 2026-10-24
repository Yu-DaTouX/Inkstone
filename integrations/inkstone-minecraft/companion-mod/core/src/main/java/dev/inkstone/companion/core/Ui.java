package dev.inkstone.companion.core;

public final class Ui {
	private Ui() {
	}

	public static String kind(String className, boolean hasMenu) {
		String name = className == null ? "" : className;
		if (name.contains("Chat")) return "chat";
		if (name.contains("Sign")) return "sign";
		if (name.contains("Book") || name.contains("Lectern")) return "book";
		if (name.contains("Anvil")) return "anvil";
		if (name.contains("Creative")) return "creative";
		if (hasMenu) return "container";
		return "other";
	}

	public static int button(String name) {
		return switch (name == null ? "left" : name.toLowerCase()) {
			case "right" -> 1;
			case "middle" -> 2;
			default -> 0;
		};
	}
}
