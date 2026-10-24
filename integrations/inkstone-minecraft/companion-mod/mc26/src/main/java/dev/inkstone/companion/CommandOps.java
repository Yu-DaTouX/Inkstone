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
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.server.ServerTickRateManager;

final class CommandOps {
	private CommandOps() {
	}

	static GameBridge.CheckResult check(String raw) throws Exception {
		return Ops.onServer(server -> {
			String command = raw.startsWith("/") ? raw.substring(1) : raw;
			CommandDispatcher<CommandSourceStack> dispatcher = server.getCommands().getDispatcher();
			ParseResults<CommandSourceStack> parsed = dispatcher.parse(command, server.createCommandSourceStack());
			boolean valid = !parsed.getReader().canRead();
			List<String> suggestions = collect(dispatcher, parsed);
			String error = valid ? null : "unexpected trailing input at " + parsed.getReader().getCursor() + ": " + parsed.getReader().getRemaining();
			return new GameBridge.CheckResult(valid, error, parsed.getReader().getCursor(), suggestions);
		});
	}

	static List<String> suggestions(String text) {
		List<String> values = new ArrayList<>();
		Minecraft client = Minecraft.getInstance();
		String raw = text == null ? "" : text;
		if (!raw.startsWith("/")) {
			ClientPacketListener connection = client.getConnection();
			if (connection != null) {
				for (var info : connection.getOnlinePlayers()) {
					String name = info.getProfile().name();
					if (name != null && name.toLowerCase().startsWith(raw.toLowerCase())) values.add(name);
				}
			}
			return values;
		}
		if (client.isLocalServer() && client.getSingleplayerServer() != null) {
			var server = client.getSingleplayerServer();
			CommandDispatcher<CommandSourceStack> dispatcher = server.getCommands().getDispatcher();
			ParseResults<CommandSourceStack> parsed = dispatcher.parse(raw.substring(1), server.createCommandSourceStack());
			return collect(dispatcher, parsed);
		}
		return values;
	}

	private static List<String> collect(CommandDispatcher<CommandSourceStack> dispatcher, ParseResults<CommandSourceStack> parsed) {
		List<String> values = new ArrayList<>();
		try {
			CompletableFuture<Suggestions> future = dispatcher.getCompletionSuggestions(parsed);
			for (Suggestion suggestion : future.get(2, TimeUnit.SECONDS).getList()) values.add(suggestion.getText());
		} catch (Exception ignored) {
		}
		return values;
	}

	static String normalizeTickState() throws Exception {
		return Ops.onServer(server -> {
			ServerTickRateManager manager = server.tickRateManager();
			boolean frozen = manager.isFrozen();
			float rate = manager.tickrate();
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
			Minecraft client = Minecraft.getInstance();
			if (client.gui != null) client.gui.getChat().addClientSystemMessage(Component.literal("[Inkstone] " + text));
			return true;
		});
	}

	static boolean viaChat(String raw) throws Exception {
		return Boolean.TRUE.equals(Ops.onClient(() -> {
			Minecraft client = Minecraft.getInstance();
			ClientPacketListener connection = client.getConnection();
			if (connection == null) throw new IllegalStateException("not in a world");
			String command = raw.startsWith("/") ? raw.substring(1) : raw;
			connection.sendCommand(command);
			return true;
		}));
	}
}
