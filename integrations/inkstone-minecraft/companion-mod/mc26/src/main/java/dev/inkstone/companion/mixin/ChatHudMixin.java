package dev.inkstone.companion.mixin;

import dev.inkstone.companion.core.ChatLog;
import net.minecraft.client.gui.components.ChatComponent;
import net.minecraft.client.multiplayer.chat.GuiMessageTag;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MessageSignature;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ChatComponent.class)
abstract class ChatHudMixin {
	@Inject(method = "addClientSystemMessage", at = @At("HEAD"))
	private void inkstoneClientSystem(Component message, CallbackInfo info) {
		if (message != null) ChatLog.add("system", message.getString());
	}

	@Inject(method = "addServerSystemMessage", at = @At("HEAD"))
	private void inkstoneServerSystem(Component message, CallbackInfo info) {
		if (message != null) ChatLog.add("system", message.getString());
	}

	@Inject(method = "addPlayerMessage", at = @At("HEAD"))
	private void inkstonePlayerMessage(Component message, MessageSignature signature, GuiMessageTag tag, CallbackInfo info) {
		if (message != null) ChatLog.add("chat", message.getString());
	}
}
