package dev.inkstone.companion;

import dev.inkstone.companion.core.Banner;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;

public final class BannerOverlay {
	private BannerOverlay() {
	}

	public static void draw(GuiGraphicsExtractor graphics, int bossBars, boolean titleShown) {
		if (!Banner.visible()) return;
		Font font = Minecraft.getInstance().font;
		if (font == null) return;
		String text = Banner.text();
		int bossBottom = Banner.bossBarBottom(bossBars);
		int titleBottom = Banner.titleBottom(graphics.guiHeight(), titleShown);
		Banner.Box box = Banner.box(graphics.guiWidth(), font.width(text), font.lineHeight, bossBottom, titleBottom);
		graphics.fill(box.x(), box.y(), box.x() + box.width(), box.y() + box.height(), Banner.background());
		graphics.text(font, text, Banner.textX(box), Banner.textY(box), Banner.foreground());
	}
}
