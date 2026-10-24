package dev.inkstone.companion.mixin;

import dev.inkstone.companion.BossBarCount;
import dev.inkstone.companion.HudState;
import dev.inkstone.companion.core.ChatLog;
import dev.inkstone.companion.core.Highlights;
import java.util.List;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.BossHealthOverlay;
import net.minecraft.network.chat.Component;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Gui.class)
abstract class HudMixin implements HudState {
	@Shadow
	@Final
	private BossHealthOverlay bossOverlay;
	@Shadow
	private Component title;
	@Shadow
	private int titleTime;

	@Override
	public int inkstoneBossBarCount() {
		return ((BossBarCount) this.bossOverlay).inkstoneBossBarCount();
	}

	@Override
	public boolean inkstoneTitleShown() {
		return this.title != null && this.titleTime > 0;
	}

	@Inject(method = "extractRenderState", at = @At("TAIL"))
	private void inkstoneHud(GuiGraphicsExtractor graphics, DeltaTracker delta, CallbackInfo info) {
		inkstoneHighlights(graphics);
	}

	private static void inkstoneHighlights(GuiGraphicsExtractor graphics) {
		Minecraft client = Minecraft.getInstance();
		if (client.player == null || Highlights.count() == 0) return;
		Vec3 eye = client.player.getEyePosition();
		List<int[]> points = Highlights.points(
			new double[] {eye.x, eye.y, eye.z},
			client.player.getYRot(),
			client.player.getXRot(),
			client.options.fov().get(),
			graphics.guiWidth(),
			graphics.guiHeight()
		);
		for (int[] point : points) graphics.fill(point[0], point[1], point[0] + 2, point[1] + 2, point[2]);
	}

	@Inject(method = "setTitle", at = @At("HEAD"))
	private void inkstoneTitle(Component message, CallbackInfo info) {
		if (message != null) ChatLog.add("title", message.getString());
	}

	@Inject(method = "setSubtitle", at = @At("HEAD"))
	private void inkstoneSubtitle(Component message, CallbackInfo info) {
		if (message != null) ChatLog.add("subtitle", message.getString());
	}

	@Inject(method = "setOverlayMessage", at = @At("HEAD"))
	private void inkstoneOverlay(Component message, boolean tinted, CallbackInfo info) {
		if (message != null) ChatLog.add("actionbar", message.getString());
	}
}
