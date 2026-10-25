package dev.inkstone.companion.mixin;

import dev.inkstone.companion.core.ServerTicks;
import java.util.function.BooleanSupplier;
import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MinecraftServer.class)
abstract class ServerTickMixin {
	@Inject(method = "tick", at = @At("TAIL"))
	private void inkstone$completedTick(BooleanSupplier hasTimeLeft, CallbackInfo ci) {
		MinecraftServer server = (MinecraftServer) (Object) this;
		if (server.getOverworld() != null) ServerTicks.complete(server, server.getOverworld().getTime());
	}
}
