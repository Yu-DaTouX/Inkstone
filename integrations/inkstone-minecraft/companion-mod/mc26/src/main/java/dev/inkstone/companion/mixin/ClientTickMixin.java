package dev.inkstone.companion.mixin;

import dev.inkstone.companion.core.Companion;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Minecraft.class)
abstract class ClientTickMixin {
	@Inject(method = "tick", at = @At("HEAD"))
	private void inkstoneTick(CallbackInfo info) {
		if (Companion.active()) Companion.onClientTick();
	}
}
