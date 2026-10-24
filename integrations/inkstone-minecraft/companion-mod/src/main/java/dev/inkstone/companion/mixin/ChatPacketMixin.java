package dev.inkstone.companion.mixin;

import dev.inkstone.companion.core.ChatLog;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.network.packet.s2c.play.ChatMessageS2CPacket;
import net.minecraft.network.packet.s2c.play.GameMessageS2CPacket;
import net.minecraft.network.packet.s2c.play.ProfilelessChatMessageS2CPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ClientPlayNetworkHandler.class)
abstract class ChatPacketMixin {
	@Inject(method = "onGameMessage", at = @At("HEAD"))
	private void inkstoneGameMessage(GameMessageS2CPacket packet, CallbackInfo info) {
		ChatLog.markNext(packet.overlay() ? "actionbar" : "system");
	}

	@Inject(method = "onChatMessage", at = @At("HEAD"))
	private void inkstoneChatMessage(ChatMessageS2CPacket packet, CallbackInfo info) {
		ChatLog.markNext("chat");
	}

	@Inject(method = "onProfilelessChatMessage", at = @At("HEAD"))
	private void inkstoneProfilelessMessage(ProfilelessChatMessageS2CPacket packet, CallbackInfo info) {
		ChatLog.markNext("chat");
	}
}
