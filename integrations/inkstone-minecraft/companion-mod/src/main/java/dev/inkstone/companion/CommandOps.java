package dev.inkstone.companion;

import dev.inkstone.companion.core.GameBridge;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.suggestion.Suggestion;
import com.mojang.brigadier.suggestion.Suggestions;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.ServerTickManager;
import net.minecraft.text.Text;

final class CommandOps {
	private CommandOps() {
	}

	static GameBridge.CheckResult check(String raw) throws Exception {
		return Ops.onServer(server -> {
			String command = raw.startsWith("/") ? raw.substring(1) : raw;
			CommandDispatcher<ServerCommandSource> dispatcher = server.getCommandManager().getDispatcher();
			ParseResults<ServerCommandSource> parsed = dispatcher.parse(command, server.getCommandSource());
			boolean valid = !parsed.getReader().canRead();
			List<String> suggestions = new ArrayList<>();
			try {
				CompletableFuture<Suggestions> future = dispatcher.getCompletionSuggestions(parsed);
				for (Suggestion suggestion : future.get(2, TimeUnit.SECONDS).getList()) suggestions.add(suggestion.getText());
			} catch (Exception ignored) {
			}
			String error = valid ? null : "unexpected trailing input at " + parsed.getReader().getCursor() + ": " + parsed.getReader().getRemaining();
			return new GameBridge.CheckResult(valid, error, parsed.getReader().getCursor(), suggestions);
		});
	}

	static String normalizeTickState() throws Exception {
		return Ops.onServer(server -> {
			ServerTickManager manager = server.getTickManager();
			boolean frozen = manager.isFrozen();
			float rate = manager.getTickRate();
			if (!frozen && Math.abs(rate - 20f) < 0.01f) return null;
			List<String> fixes = new ArrayList<>();
			if (frozen) {
				ServerOps.command(server, "tick unfreeze");
				fixes.add("tick unfreeze");
			}
			if (Math.abs(rate - 20f) >= 0.01f) {
				ServerOps.command(server, "tick rate 20");
				fixes.add("tick rate 20");
			}
			return "已恢复游戏 tick：" + String.join("、", fixes) + "（接管前 frozen=" + frozen + "、rate=" + rate + "）";
		});
	}

	static void notice(String text) throws Exception {
		Ops.onClient(() -> {
			MinecraftClient client = MinecraftClient.getInstance();
			if (client.inGameHud != null) client.inGameHud.getChatHud().addMessage(Text.literal("[Inkstone] " + text));
			return true;
		});
	}

	static boolean viaChat(String raw) throws Exception {
		return Boolean.TRUE.equals(Ops.onClient(() -> {
			MinecraftClient client = MinecraftClient.getInstance();
			ClientPlayNetworkHandler handler = client.getNetworkHandler();
			if (handler == null) throw new IllegalStateException("not in a world");
			String command = raw.startsWith("/") ? raw.substring(1) : raw;
			handler.sendChatCommand(command);
			return true;
		}));
	}
}
