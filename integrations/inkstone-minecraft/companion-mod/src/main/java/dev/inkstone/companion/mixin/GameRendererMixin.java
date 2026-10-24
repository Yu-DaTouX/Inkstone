package dev.inkstone.companion.mixin;

import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.systems.VertexSorter;
import dev.inkstone.companion.BannerOverlay;
import dev.inkstone.companion.HudState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.render.GameRenderer;
import net.minecraft.client.render.RenderTickCounter;
import net.minecraft.client.util.Window;
import net.minecraft.client.util.math.MatrixStack;
import org.joml.Matrix4f;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
abstract class GameRendererMixin {
	@Inject(method = "render", at = @At("TAIL"))
	private void inkstoneBanner(RenderTickCounter tickCounter, boolean tick, CallbackInfo info) {
		MinecraftClient client = MinecraftClient.getInstance();
		if (client.player == null || client.inGameHud == null) return;
		Window window = client.getWindow();
		Matrix4f projection = new Matrix4f().setOrtho(0f, (float)window.getScaledWidth(), (float)window.getScaledHeight(), 0f, 1000f, 21000f);
		RenderSystem.setProjectionMatrix(projection, VertexSorter.BY_Z);
		MatrixStack matrices = new MatrixStack();
		matrices.translate(0f, 0f, -11000f);
		RenderSystem.getModelViewStack().pushMatrix();
		RenderSystem.getModelViewStack().mul(matrices.peek().getPositionMatrix());
		RenderSystem.applyModelViewMatrix();
		try {
			HudState state = (HudState) client.inGameHud;
			DrawContext context = new DrawContext(client, client.getBufferBuilders().getEntityVertexConsumers());
			BannerOverlay.draw(context, state.inkstoneBossBarCount(), state.inkstoneTitleShown());
			context.draw();
		} finally {
			RenderSystem.getModelViewStack().popMatrix();
			RenderSystem.applyModelViewMatrix();
		}
	}
}
