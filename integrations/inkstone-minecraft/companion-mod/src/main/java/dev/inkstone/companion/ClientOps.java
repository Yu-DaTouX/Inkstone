package dev.inkstone.companion;

import dev.inkstone.companion.core.Json;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import net.minecraft.SharedConstants;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DownloadingTerrainScreen;
import net.minecraft.client.gui.screen.MessageScreen;
import net.minecraft.client.gui.screen.ProgressScreen;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.screen.world.LevelLoadingScreen;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.server.integrated.IntegratedServer;

final class ClientOps {
	private ClientOps() {
	}

	static Map<String, Object> status() {
		MinecraftClient client = MinecraftClient.getInstance();
		Screen screen = client.currentScreen;
		IntegratedServer server = client.getServer();
		Object player = null;
		if (client.player != null) {
			player = Json.map(
				"name", client.player.getName().getString(),
				"x", client.player.getX(),
				"y", client.player.getY(),
				"z", client.player.getZ(),
				"yaw", client.player.getYaw(),
				"pitch", client.player.getPitch(),
				"dimension", client.player.getWorld().getRegistryKey().getValue().toString()
			);
		}
		return Json.map(
			"ok", true,
			"minecraft", SharedConstants.getGameVersion().getName(),
			"screen", screen == null ? null : screen.getClass().getSimpleName(),
			"titleScreen", screen instanceof TitleScreen,
			"loading", client.getOverlay() != null,
			"inWorld", client.world != null,
			"playing", playing(client, screen),
			"world", server == null ? null : server.getSaveProperties().getLevelName(),
			"player", player,
			"fps", client.getCurrentFps(),
			"window", Json.map("width", client.getWindow().getFramebufferWidth(), "height", client.getWindow().getFramebufferHeight())
		);
	}

	static boolean playingNow() {
		MinecraftClient client = MinecraftClient.getInstance();
		return playing(client, client.currentScreen);
	}

	static String screenClass() {
		Screen screen = MinecraftClient.getInstance().currentScreen;
		return screen == null ? null : screen.getClass().getSimpleName();
	}

	static String screenTitle() {
		Screen screen = MinecraftClient.getInstance().currentScreen;
		return screen == null || screen.getTitle() == null ? null : screen.getTitle().getString();
	}

	static boolean playing(MinecraftClient client, Screen screen) {
		if (client.world == null || client.player == null || client.getOverlay() != null) return false;
		return !(screen instanceof DownloadingTerrainScreen || screen instanceof LevelLoadingScreen || screen instanceof MessageScreen || screen instanceof ProgressScreen);
	}

	static Map<String, Object> reloadResources() throws Exception {
		MinecraftClient client = MinecraftClient.getInstance();
		long started = System.nanoTime();
		Supplier<CompletableFuture<Void>> start = client::reloadResources;
		CompletableFuture<Void> reload = Ops.unwrap(client.submit(start), 30);
		reload.get(180, TimeUnit.SECONDS);
		long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
		while (System.nanoTime() < deadline && Boolean.TRUE.equals(Ops.onClient(() -> client.getOverlay() != null))) Thread.sleep(100);
		if (Boolean.TRUE.equals(Ops.onClient(() -> client.getOverlay() != null))) throw new IllegalStateException("resource reload finished but loading overlay is still visible");
		return Json.map("ok", true, "ms", (System.nanoTime() - started) / 1_000_000);
	}

	static byte[] screenshot() {
		MinecraftClient client = MinecraftClient.getInstance();
		try (NativeImage image = ScreenshotRecorder.takeScreenshot(client.getFramebuffer())) {
			return image.getBytes();
		} catch (IOException error) {
			throw new UncheckedIOException(error);
		}
	}
}
