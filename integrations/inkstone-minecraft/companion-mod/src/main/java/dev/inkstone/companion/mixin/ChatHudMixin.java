package dev.inkstone.companion.mixin;

import dev.inkstone.companion.core.ChatLog;
import net.minecraft.client.gui.hud.ChatHud;
import net.minecraft.client.gui.hud.MessageIndicator;
import net.minecraft.network.message.MessageSignatureData;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ChatHud.class)
abstract class ChatHudMixin {
	@Inject(method = "addMessage(Lnet/minecraft/text/Text;Lnet/minecraft/network/message/MessageSignatureData;Lnet/minecraft/client/gui/hud/MessageIndicator;)V", at = @At("HEAD"))
	private void inkstoneChatMessage(Text message, MessageSignatureData signature, MessageIndicator indicator, CallbackInfo info) {
		if (message != null) ChatLog.add(signature == null ? "system" : "chat", message.getString());
	}
}
