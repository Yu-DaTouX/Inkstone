package dev.inkstone.companion.mixin;

import com.mojang.blaze3d.platform.Window;
import com.mojang.blaze3d.systems.GpuBackend;
import dev.inkstone.companion.core.AgentWindow;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(Window.class)
abstract class WindowMixin {
	@Shadow
	private long handle;

	@Inject(method = "createGlfwWindow", at = @At(value = "INVOKE", target = "Lorg/lwjgl/glfw/GLFW;glfwCreateWindow(IILjava/lang/CharSequence;JJ)J", shift = At.Shift.BEFORE))
	private static void inkstoneBeforeCreate(int width, int height, String title, long monitor, GpuBackend backend, CallbackInfoReturnable<Long> info) {
		AgentWindow.prepareHints();
	}

	@Inject(method = "<init>", at = @At("TAIL"))
	private void inkstoneAfterCreate(CallbackInfo info) {
		AgentWindow.afterCreate(this.handle);
	}

	@Inject(method = "setTitle", at = @At("HEAD"), cancellable = true)
	private void inkstoneTitle(String title, CallbackInfo info) {
		if (AgentWindow.interceptTitle(this.handle)) info.cancel();
	}
}
