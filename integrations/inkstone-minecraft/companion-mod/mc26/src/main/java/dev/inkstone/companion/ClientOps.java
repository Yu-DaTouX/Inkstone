package dev.inkstone.companion;

import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.platform.NativeImage;
import dev.inkstone.companion.core.Json;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import net.minecraft.SharedConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.GenericMessageScreen;
import net.minecraft.client.gui.screens.LevelLoadingScreen;
import net.minecraft.client.gui.screens.ProgressScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.server.IntegratedServer;

final class ClientOps {
	private static final long CAPTURE_TIMEOUT_S = 15;

	private ClientOps() {
	}

	static Map<String, Object> status() {
		Minecraft client = Minecraft.getInstance();
		Screen screen = client.screen;
		IntegratedServer server = client.getSingleplayerServer();
		Object player = null;
		if (client.player != null) {
			player = Json.map(
				"name", client.player.getName().getString(),
				"x", client.player.getX(),
				"y", client.player.getY(),
				"z", client.player.getZ(),
				"yaw", client.player.getYRot(),
				"pitch", client.player.getXRot(),
				"dimension", client.player.level().dimension().identifier().toString()
			);
		}
		RenderTarget target = client.getMainRenderTarget();
		return Json.map(
			"ok", true,
			"minecraft", SharedConstants.getCurrentVersion().name(),
			"screen", screen == null ? null : screen.getClass().getSimpleName(),
			"titleScreen", screen instanceof TitleScreen,
			"loading", client.getOverlay() != null,
			"inWorld", client.level != null,
			"playing", playing(client, screen),
			"world", server == null ? null : server.getWorldData().getLevelName(),
			"player", player,
			"fps", client.getFps(),
			"window", Json.map("width", target.width, "height", target.height, "guiScale", client.getWindow().getGuiScale())
		);
	}

	static boolean playingNow() {
		Minecraft client = Minecraft.getInstance();
		return playing(client, client.screen);
	}

	static String screenClass() {
		Screen screen = Minecraft.getInstance().screen;
		return screen == null ? null : screen.getClass().getSimpleName();
	}

	static String screenTitle() {
		Screen screen = Minecraft.getInstance().screen;
		return screen == null || screen.getTitle() == null ? null : screen.getTitle().getString();
	}

	static boolean playing(Minecraft client, Screen screen) {
		if (client.level == null || client.player == null || client.getOverlay() != null) return false;
		return !(screen instanceof LevelLoadingScreen || screen instanceof GenericMessageScreen || screen instanceof ProgressScreen);
	}

	static Map<String, Object> reloadResources() throws Exception {
		Minecraft client = Minecraft.getInstance();
		long started = System.nanoTime();
		Supplier<CompletableFuture<Void>> start = client::reloadResourcePacks;
		CompletableFuture<Void> reload = Ops.unwrap(client.submit(start), 30);
		reload.get(180, TimeUnit.SECONDS);
		long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
		while (System.nanoTime() < deadline && Boolean.TRUE.equals(Ops.onClient(() -> client.getOverlay() != null))) Thread.sleep(100);
		return Json.map("ok", true, "ms", (System.nanoTime() - started) / 1_000_000);
	}

	static NativeImage capture() throws Exception {
		CompletableFuture<NativeImage> result = new CompletableFuture<>();
		Ops.onClient(() -> {
			Screenshot.takeScreenshot(Minecraft.getInstance().getMainRenderTarget(), result::complete);
			return null;
		});
		return result.get(CAPTURE_TIMEOUT_S, TimeUnit.SECONDS);
	}

	static byte[] screenshot() throws Exception {
		try (NativeImage image = capture()) {
			return png(image);
		}
	}

	static byte[] png(NativeImage image) throws IOException {
		Path file = Files.createTempFile("inkstone-companion-", ".png");
		try {
			image.writeToFile(file);
			return Files.readAllBytes(file);
		} finally {
			Files.deleteIfExists(file);
		}
	}
}
