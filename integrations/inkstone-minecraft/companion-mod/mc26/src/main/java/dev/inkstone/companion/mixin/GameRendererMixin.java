package dev.inkstone.companion.mixin;

import dev.inkstone.companion.BannerOverlay;
import dev.inkstone.companion.HudState;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.renderer.GameRenderer;
import net.minecraft.client.renderer.state.GameRenderState;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
abstract class GameRendererMixin {
	@Shadow
	@Final
	private GameRenderState gameRenderState;

	@Inject(method = "extractGui", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/gui/Gui;extractRenderState(Lnet/minecraft/client/gui/GuiGraphicsExtractor;Lnet/minecraft/client/DeltaTracker;)V", shift = At.Shift.AFTER))
	private void inkstoneBanner(DeltaTracker delta, boolean hudHidden, boolean debug, CallbackInfo info) {
		Minecraft client = Minecraft.getInstance();
		if (client.player == null || client.gui == null) return;
		HudState state = (HudState) client.gui;
		GuiGraphicsExtractor graphics = new GuiGraphicsExtractor(client, this.gameRenderState.guiRenderState, 0, 0);
		BannerOverlay.draw(graphics, state.inkstoneBossBarCount(), state.inkstoneTitleShown());
	}
}
