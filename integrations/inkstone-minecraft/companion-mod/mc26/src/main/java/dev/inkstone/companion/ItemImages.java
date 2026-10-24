package dev.inkstone.companion;

import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.platform.NativeImage;
import dev.inkstone.companion.core.IconAlpha;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

final class ItemImages {
	private static final int BLACK = 0xFF000000;
	private static final int WHITE = 0xFFFFFFFF;
	private static final int SETTLE_FRAMES = 3;
	private static final long FRAME_TIMEOUT_MS = 5000;

	private ItemImages() {
	}

	static byte[] render(String rawId, String kind, int requestedSize) throws Exception {
		Identifier id = Identifier.parse(rawId);
		boolean hasItem = BuiltInRegistries.ITEM.containsKey(id);
		boolean hasBlock = BuiltInRegistries.BLOCK.containsKey(id);
		boolean asBlock = kind.equals("block") || (kind.equals("auto") && !hasItem && hasBlock);
		if (!asBlock && !hasItem) throw new IllegalArgumentException("unknown item " + rawId);
		if (asBlock && !hasBlock) throw new IllegalArgumentException("unknown block " + rawId);
		Item item = asBlock ? BuiltInRegistries.BLOCK.getValue(id).asItem() : BuiltInRegistries.ITEM.getValue(id);
		if (item == Items.AIR) throw new IllegalArgumentException(rawId + " has no item form to render");
		ItemStack stack = new ItemStack(item);
		Minecraft client = Minecraft.getInstance();
		CaptureScreen screen = Ops.onClient(() -> {
			RenderTarget target = client.getMainRenderTarget();
			int size = Math.max(16, Math.min(IconAlpha.size(requestedSize), Math.min(target.width, target.height)));
			CaptureScreen capture = new CaptureScreen(client.screen, stack, size, client.getWindow().getGuiScale());
			client.setScreen(capture);
			return capture;
		});
		NativeImage black = null;
		NativeImage white = null;
		try {
			black = screen.shoot(BLACK);
			white = screen.shoot(WHITE);
			int size = screen.size;
			try (NativeImage out = new NativeImage(NativeImage.Format.RGBA, size, size, false)) {
				for (int y = 0; y < size; y++) {
					for (int x = 0; x < size; x++) out.setPixel(x, y, combine(black.getPixel(x, y), white.getPixel(x, y)));
				}
				return ClientOps.png(out);
			}
		} finally {
			if (black != null) black.close();
			if (white != null) white.close();
			Ops.onClient(() -> {
				if (client.screen == screen) client.setScreen(screen.previous);
				return null;
			});
		}
	}

	static int combine(int onBlack, int onWhite) {
		return IconAlpha.combine(
			(onBlack >> 16) & 0xFF,
			(onBlack >> 8) & 0xFF,
			onBlack & 0xFF,
			(onWhite >> 16) & 0xFF,
			(onWhite >> 8) & 0xFF,
			onWhite & 0xFF
		);
	}

	static final class CaptureScreen extends Screen {
		final Screen previous;
		final ItemStack stack;
		final int size;
		final int guiScale;
		final AtomicInteger frames = new AtomicInteger();
		volatile int background = BLACK;

		CaptureScreen(Screen previous, ItemStack stack, int size, int guiScale) {
			super(Component.empty());
			this.previous = previous;
			this.stack = stack;
			this.size = size;
			this.guiScale = Math.max(1, guiScale);
		}

		NativeImage shoot(int color) throws Exception {
			background = color;
			int target = frames.get() + SETTLE_FRAMES;
			long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(FRAME_TIMEOUT_MS);
			while (frames.get() < target) {
				if (System.nanoTime() > deadline) throw new IllegalStateException("the game did not render a frame in time (window minimized?)");
				Thread.sleep(16);
			}
			return ClientOps.capture();
		}

		@Override
		public void extractBackground(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float a) {
		}

		@Override
		public void extractRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float a) {
			graphics.fill(0, 0, width, height, background);
			float scale = size / (16f * guiScale);
			graphics.pose().pushMatrix();
			graphics.pose().scale(scale, scale);
			graphics.item(stack, 0, 0);
			graphics.pose().popMatrix();
			frames.incrementAndGet();
		}

		@Override
		public boolean isPauseScreen() {
			return false;
		}

		@Override
		public boolean shouldCloseOnEsc() {
			return false;
		}
	}
}
