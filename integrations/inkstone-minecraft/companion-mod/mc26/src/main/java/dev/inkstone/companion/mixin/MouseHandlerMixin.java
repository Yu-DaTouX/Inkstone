package dev.inkstone.companion.mixin;

import com.mojang.blaze3d.platform.Window;
import dev.inkstone.companion.core.Hover;
import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(MouseHandler.class)
abstract class MouseHandlerMixin {
	@Inject(method = "getScaledXPos(Lcom/mojang/blaze3d/platform/Window;)D", at = @At("HEAD"), cancellable = true)
	private void inkstoneHoverX(Window window, CallbackInfoReturnable<Double> info) {
		double[] point = Hover.point(net.minecraft.client.Minecraft.getInstance().screen);
		if (point != null) info.setReturnValue(point[0]);
	}

	@Inject(method = "getScaledYPos(Lcom/mojang/blaze3d/platform/Window;)D", at = @At("HEAD"), cancellable = true)
	private void inkstoneHoverY(Window window, CallbackInfoReturnable<Double> info) {
		double[] point = Hover.point(net.minecraft.client.Minecraft.getInstance().screen);
		if (point != null) info.setReturnValue(point[1]);
	}

	@Inject(method = "onMove", at = @At("HEAD"))
	private void inkstoneHoverRelease(long handle, double x, double y, CallbackInfo info) {
		Hover.clear();
	}
}
