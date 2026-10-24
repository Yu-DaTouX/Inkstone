package dev.inkstone.companion.mixin;

import dev.inkstone.companion.core.Companion;
import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MinecraftClient.class)
abstract class ClientTickMixin {
	@Inject(method = "tick", at = @At("HEAD"))
	private void inkstoneTick(CallbackInfo info) {
		if (Companion.active()) {
			Companion.onClientTick();
			dev.inkstone.companion.InputOps.reassertHolds();
		}
	}
}
