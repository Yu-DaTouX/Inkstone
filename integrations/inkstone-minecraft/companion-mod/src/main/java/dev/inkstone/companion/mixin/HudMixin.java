package dev.inkstone.companion.mixin;

import dev.inkstone.companion.BossBarCount;
import dev.inkstone.companion.HudState;
import dev.inkstone.companion.core.ChatLog;
import dev.inkstone.companion.core.Highlights;
import java.util.List;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.hud.BossBarHud;
import net.minecraft.client.gui.hud.InGameHud;
import net.minecraft.client.render.RenderTickCounter;
import net.minecraft.text.Text;
import net.minecraft.util.math.Vec3d;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(InGameHud.class)
abstract class HudMixin implements HudState {
	@Shadow
	@Final
	private BossBarHud bossBarHud;
	@Shadow
	private Text title;
	@Shadow
	private int titleRemainTicks;

	@Override
	public int inkstoneBossBarCount() {
		return ((BossBarCount) this.bossBarHud).inkstoneBossBarCount();
	}

	@Override
	public boolean inkstoneTitleShown() {
		return this.title != null && this.titleRemainTicks > 0;
	}

	@Inject(method = "render", at = @At("TAIL"))
	private void inkstoneHud(DrawContext context, RenderTickCounter tickCounter, CallbackInfo info) {
		inkstoneHighlights(context);
	}

	private static void inkstoneHighlights(DrawContext context) {
		MinecraftClient client = MinecraftClient.getInstance();
		if (client.player == null || Highlights.count() == 0) return;
		Vec3d eye = client.player.getEyePos();
		List<int[]> points = Highlights.points(
			new double[] {eye.x, eye.y, eye.z},
			client.player.getYaw(),
			client.player.getPitch(),
			client.gameRenderer == null ? 70f : client.options.getFov().getValue(),
			context.getScaledWindowWidth(),
			context.getScaledWindowHeight()
		);
		for (int[] point : points) context.fill(point[0], point[1], point[0] + 2, point[1] + 2, point[2]);
	}

	@Inject(method = "setTitle", at = @At("HEAD"))
	private void inkstoneTitle(Text message, CallbackInfo info) {
		if (message != null) ChatLog.add("title", message.getString());
	}

	@Inject(method = "setSubtitle", at = @At("HEAD"))
	private void inkstoneSubtitle(Text message, CallbackInfo info) {
		if (message != null) ChatLog.add("subtitle", message.getString());
	}

	@Inject(method = "setOverlayMessage", at = @At("HEAD"))
	private void inkstoneOverlay(Text message, boolean tinted, CallbackInfo info) {
		if (message != null) ChatLog.add("actionbar", message.getString());
	}
}
