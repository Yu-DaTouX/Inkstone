package dev.inkstone.companion;

import dev.inkstone.companion.core.Json;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Function;
import java.util.function.Supplier;
import net.minecraft.client.MinecraftClient;
import net.minecraft.server.integrated.IntegratedServer;

final class Ops {
	private static final long TIMEOUT_S = 30;

	private Ops() {
	}

	static <T> T onClient(Supplier<T> task) throws Exception {
		MinecraftClient client = MinecraftClient.getInstance();
		if (client.isOnThread()) return task.get();
		return unwrap(client.submit(task), TIMEOUT_S);
	}

	static <T> T onServer(Function<IntegratedServer, T> task) throws Exception {
		IntegratedServer server = MinecraftClient.getInstance().getServer();
		if (server == null) throw new IllegalStateException("not in a singleplayer world");
		return unwrap(server.submit(() -> task.apply(server)), TIMEOUT_S);
	}

	static <T> T unwrap(CompletableFuture<T> future, long seconds) throws Exception {
		try {
			return future.get(seconds, TimeUnit.SECONDS);
		} catch (TimeoutException error) {
			if (future.cancel(false)) throw new TimeoutException("game thread busy for " + seconds + "s; the action was cancelled and did not run");
			throw new TimeoutException("game thread busy for " + seconds + "s; the action already started and may still finish");
		} catch (ExecutionException error) {
			Throwable cause = error.getCause();
			if (cause instanceof Exception exception) throw exception;
			if (cause instanceof Error fatal) throw fatal;
			throw error;
		}
	}

	static Map<String, Object> shutdownNow() {
		MinecraftClient.getInstance().scheduleStop();
		return Json.map("ok", true);
	}
}
