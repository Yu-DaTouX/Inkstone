package dev.inkstone.companion;

import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.systems.VertexSorter;
import dev.inkstone.companion.core.IconAlpha;
import java.io.IOException;
import java.io.UncheckedIOException;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gl.Framebuffer;
import net.minecraft.client.gl.SimpleFramebuffer;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.render.DiffuseLighting;
import net.minecraft.client.render.OverlayTexture;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.RotationAxis;
import org.joml.Matrix4f;
import org.joml.Matrix4fStack;

final class ItemImages {
	private ItemImages() {
	}

	static byte[] render(String rawId, String kind, int requestedSize) {
		int size = IconAlpha.size(requestedSize);
		Identifier id = Identifier.of(rawId);
		boolean hasItem = Registries.ITEM.containsId(id);
		boolean hasBlock = Registries.BLOCK.containsId(id);
		boolean asBlock = kind.equals("block") || (kind.equals("auto") && !hasItem && hasBlock);
		if (!asBlock && !hasItem) throw new IllegalArgumentException("unknown item " + rawId);
		if (asBlock && !hasBlock) throw new IllegalArgumentException("unknown block " + rawId);
		Item item = asBlock ? Registries.BLOCK.get(id).asItem() : Registries.ITEM.get(id);
		Pass pass;
		if (item != Items.AIR) {
			ItemStack stack = new ItemStack(item);
			pass = context -> context.drawItem(stack, 0, 0);
		} else {
			BlockState state = Registries.BLOCK.get(id).getDefaultState();
			pass = context -> drawBlock(context, state);
		}
		NativeImage black = draw(pass, size, 0f);
		NativeImage white = draw(pass, size, 1f);
		try (NativeImage out = new NativeImage(NativeImage.Format.RGBA, size, size, false)) {
			for (int y = 0; y < size; y++) {
				for (int x = 0; x < size; x++) out.setColor(x, y, abgr(combine(black.getColor(x, y), white.getColor(x, y))));
			}
			return out.getBytes();
		} catch (IOException error) {
			throw new UncheckedIOException(error);
		} finally {
			black.close();
			white.close();
		}
	}

	static int combine(int onBlack, int onWhite) {
		return IconAlpha.combine(
			onBlack & 0xFF,
			(onBlack >> 8) & 0xFF,
			(onBlack >> 16) & 0xFF,
			onWhite & 0xFF,
			(onWhite >> 8) & 0xFF,
			(onWhite >> 16) & 0xFF
		);
	}

	static int abgr(int argb) {
		return (argb & 0xFF00FF00) | ((argb & 0xFF) << 16) | ((argb >> 16) & 0xFF);
	}

	interface Pass {
		void draw(DrawContext context);
	}

	private static NativeImage draw(Pass pass, int size, float background) {
		MinecraftClient client = MinecraftClient.getInstance();
		Framebuffer framebuffer = new SimpleFramebuffer(size, size, true, MinecraftClient.IS_SYSTEM_MAC);
		try {
			framebuffer.setClearColor(background, background, background, 1f);
			framebuffer.clear(MinecraftClient.IS_SYSTEM_MAC);
			framebuffer.beginWrite(true);
			RenderSystem.backupProjectionMatrix();
			RenderSystem.setProjectionMatrix(new Matrix4f().setOrtho(0f, 16f, 16f, 0f, 1000f, 21000f), VertexSorter.BY_Z);
			Matrix4fStack modelView = RenderSystem.getModelViewStack();
			modelView.pushMatrix();
			modelView.identity();
			modelView.translate(0f, 0f, -11000f);
			RenderSystem.applyModelViewMatrix();
			DiffuseLighting.enableGuiDepthLighting();
			DrawContext context = new DrawContext(client, client.getBufferBuilders().getEntityVertexConsumers());
			pass.draw(context);
			context.draw();
			modelView.popMatrix();
			RenderSystem.applyModelViewMatrix();
			RenderSystem.restoreProjectionMatrix();
			return ScreenshotRecorder.takeScreenshot(framebuffer);
		} finally {
			framebuffer.delete();
			client.getFramebuffer().beginWrite(true);
		}
	}

	private static void drawBlock(DrawContext context, BlockState state) {
		MinecraftClient client = MinecraftClient.getInstance();
		MatrixStack matrices = context.getMatrices();
		matrices.push();
		matrices.translate(8f, 8f, 150f);
		matrices.scale(10f, -10f, 10f);
		matrices.multiply(RotationAxis.POSITIVE_X.rotationDegrees(30f));
		matrices.multiply(RotationAxis.POSITIVE_Y.rotationDegrees(225f));
		matrices.translate(-0.5f, -0.5f, -0.5f);
		VertexConsumerProvider.Immediate consumers = client.getBufferBuilders().getEntityVertexConsumers();
		client.getBlockRenderManager().renderBlockAsEntity(state, matrices, consumers, 0xF000F0, OverlayTexture.DEFAULT_UV);
		consumers.draw();
		matrices.pop();
	}
}
