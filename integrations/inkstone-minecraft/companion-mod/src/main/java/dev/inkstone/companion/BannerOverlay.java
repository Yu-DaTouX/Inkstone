package dev.inkstone.companion;

import dev.inkstone.companion.core.Banner;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;

public final class BannerOverlay {
	private BannerOverlay() {
	}

	public static void draw(DrawContext context, int bossBars, boolean titleShown) {
		if (!Banner.visible()) return;
		TextRenderer font = MinecraftClient.getInstance().textRenderer;
		if (font == null) return;
		String text = Banner.text();
		int bossBottom = Banner.bossBarBottom(bossBars);
		int titleBottom = Banner.titleBottom(context.getScaledWindowHeight(), titleShown);
		Banner.Box box = Banner.box(context.getScaledWindowWidth(), font.getWidth(text), font.fontHeight, bossBottom, titleBottom);
		context.fill(box.x(), box.y(), box.x() + box.width(), box.y() + box.height(), Banner.background());
		context.drawTextWithShadow(font, text, Banner.textX(box), Banner.textY(box), Banner.foreground());
	}
}
