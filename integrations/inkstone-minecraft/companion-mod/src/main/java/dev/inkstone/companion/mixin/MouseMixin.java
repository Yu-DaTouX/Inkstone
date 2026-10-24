package dev.inkstone.companion.mixin;

import dev.inkstone.companion.core.Hover;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.Mouse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(Mouse.class)
abstract class MouseMixin {
	@Inject(method = "getX", at = @At("HEAD"), cancellable = true)
	private void inkstoneHoverX(CallbackInfoReturnable<Double> info) {
		MinecraftClient client = MinecraftClient.getInstance();
		double[] point = Hover.point(client.currentScreen);
		if (point != null) info.setReturnValue(point[0] * client.getWindow().getWidth() / client.getWindow().getScaledWidth());
	}

	@Inject(method = "getY", at = @At("HEAD"), cancellable = true)
	private void inkstoneHoverY(CallbackInfoReturnable<Double> info) {
		MinecraftClient client = MinecraftClient.getInstance();
		double[] point = Hover.point(client.currentScreen);
		if (point != null) info.setReturnValue(point[1] * client.getWindow().getHeight() / client.getWindow().getScaledHeight());
	}

	@Inject(method = "onCursorPos", at = @At("HEAD"))
	private void inkstoneHoverRelease(long window, double x, double y, CallbackInfo info) {
		Hover.clear();
	}
}
