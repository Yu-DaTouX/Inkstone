package dev.inkstone.companion.core;

public record TitleBarBounds(int x, int y, int width, int height) {
	public static TitleBarBounds beside(int windowX, int windowY, int windowWidth, int captionLeft, int captionTop, int captionRight, int captionBottom, int dpi) {
		if (windowWidth <= 0 || captionLeft <= 0 || captionRight <= captionLeft || captionRight > windowWidth || captionTop < 0 || captionBottom <= captionTop) return null;
		double scale = Math.max(48, Math.min(768, dpi)) / 96.0;
		int gap = Math.max(2, (int) Math.round(5 * scale));
		int width = (int) Math.round(96 * scale);
		int height = captionBottom - captionTop - gap;
		int left = captionLeft - gap - width;
		if (left < Math.round(36 * scale) || height < Math.round(16 * scale)) return null;
		return new TitleBarBounds(windowX + left, windowY + captionTop + gap / 2, width, height);
	}
}
