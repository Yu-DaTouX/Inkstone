package dev.inkstone.companion.core;

public final class IconAlpha {
	private IconAlpha() {
	}

	public static int size(int requested) {
		return Math.max(16, Math.min(1024, requested));
	}

	public static int combine(int blackRed, int blackGreen, int blackBlue, int whiteRed, int whiteGreen, int whiteBlue) {
		int diff = ((whiteRed - blackRed) + (whiteGreen - blackGreen) + (whiteBlue - blackBlue)) / 3;
		int alpha = Math.max(0, Math.min(255, 255 - diff));
		if (alpha == 0) return 0;
		int red = Math.min(255, blackRed * 255 / alpha);
		int green = Math.min(255, blackGreen * 255 / alpha);
		int blue = Math.min(255, blackBlue * 255 / alpha);
		return (alpha << 24) | (red << 16) | (green << 8) | blue;
	}
}
