package dev.inkstone.companion.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import javax.imageio.ImageIO;

public final class Shots {
	private static final int DEFAULT_STEP = 50;
	private static final int MIN_STEP = 4;
	private static final int MAX_STEP = 400;

	private Shots() {
	}

	public static byte[] decorate(JsonObject body, byte[] png, int guiWidth) throws IOException {
		int step = gridStep(body);
		int[] crop = cropBounds(body);
		if (step <= 0 && crop == null) return png;
		BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
		if (image == null) return png;
		int offsetX = 0;
		int offsetY = 0;
		if (crop != null) {
			int x = Math.max(0, Math.min(image.getWidth() - 1, crop[0]));
			int y = Math.max(0, Math.min(image.getHeight() - 1, crop[1]));
			int width = Math.max(1, Math.min(image.getWidth() - x, crop[2]));
			int height = Math.max(1, Math.min(image.getHeight() - y, crop[3]));
			image = image.getSubimage(x, y, width, height);
			offsetX = x;
			offsetY = y;
		}
		BufferedImage result = new BufferedImage(image.getWidth(), image.getHeight(), BufferedImage.TYPE_INT_ARGB);
		Graphics2D graphics = result.createGraphics();
		graphics.drawImage(image, 0, 0, null);
		if (step > 0) drawGrid(graphics, result.getWidth(), result.getHeight(), guiWidth, step, offsetX, offsetY);
		graphics.dispose();
		ByteArrayOutputStream output = new ByteArrayOutputStream();
		ImageIO.write(result, "png", output);
		return output.toByteArray();
	}

	public static int gridStep(JsonObject body) {
		if (!body.has("grid") || body.get("grid").isJsonNull()) return 0;
		JsonElement grid = body.get("grid");
		if (grid.isJsonPrimitive() && grid.getAsJsonPrimitive().isBoolean()) return grid.getAsBoolean() ? DEFAULT_STEP : 0;
		if (grid.isJsonPrimitive() && grid.getAsJsonPrimitive().isNumber()) return clampStep(grid.getAsInt());
		if (grid.isJsonObject()) return clampStep(Json.integer(grid.getAsJsonObject(), "step", DEFAULT_STEP));
		return 0;
	}

	public static int[] cropBounds(JsonObject body) {
		JsonElement crop = body.get("crop");
		if (crop == null || !crop.isJsonArray()) return null;
		JsonArray array = crop.getAsJsonArray();
		if (array.size() != 4) return null;
		int[] bounds = new int[4];
		for (int index = 0; index < 4; index++) bounds[index] = array.get(index).getAsInt();
		return bounds;
	}

	private static int clampStep(int step) {
		return Math.max(MIN_STEP, Math.min(MAX_STEP, step));
	}

	private static void drawGrid(Graphics2D graphics, int width, int height, int guiWidth, int step, int offsetX, int offsetY) {
		graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_OFF);
		double scale = guiWidth > 0 ? width / (double) guiWidth : 1.0;
		int unit = Math.max(2, (int) Math.round(step * scale));
		graphics.setColor(new Color(255, 0, 255, 36));
		for (int x = -offsetX % unit; x < width; x += unit) if (x >= 0) graphics.drawLine(x, 0, x, height);
		for (int y = -offsetY % unit; y < height; y += unit) if (y >= 0) graphics.drawLine(0, y, width, y);
		graphics.setColor(new Color(255, 0, 255, 160));
		graphics.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 11));
		for (int x = -offsetX % unit; x < width; x += unit) {
			if (x < 0) continue;
			graphics.drawLine(x, 0, x, 5);
			graphics.drawString(String.valueOf(Math.round((x + offsetX) / scale)), x + 2, 12);
		}
		for (int y = -offsetY % unit; y < height; y += unit) {
			if (y < 0) continue;
			graphics.drawLine(0, y, 5, y);
			graphics.drawString(String.valueOf(Math.round((y + offsetY) / scale)), 7, y + 11);
		}
	}
}
