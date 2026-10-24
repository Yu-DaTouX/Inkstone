package dev.inkstone.companion.core;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

public final class Banner {
	public static final String AGENT_TEXT = "Agent 正在操作 · 按 F8 接管";
	public static final String USER_TEXT = "你正在操作 · 按 F8 交还 Agent";
	private static final boolean ENABLED = !"off".equalsIgnoreCase(System.getProperty("inkstone.banner", "on").trim());
	private static final int MARGIN = 3;
	private static final int GAP = 2;
	private static final int PADDING_X = 4;
	private static final int PADDING_Y = 3;

	private static final AtomicInteger CAPTURES = new AtomicInteger();
	private static final AtomicLong TICKS = new AtomicLong();

	private Banner() {
	}

	public static void beginCapture() {
		CAPTURES.incrementAndGet();
	}

	static void tick() {
		TICKS.incrementAndGet();
	}

	public static void settle() throws InterruptedException {
		long reach = TICKS.get() + 2;
		long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(4);
		while (TICKS.get() < reach) {
			if (System.nanoTime() > deadline) throw new IllegalStateException("the game did not tick in time (window minimized?)");
			Thread.sleep(5);
		}
	}

	public static void endCapture() {
		CAPTURES.updateAndGet(value -> Math.max(0, value - 1));
	}

	public static boolean visible() {
		return ENABLED && CAPTURES.get() == 0;
	}

	public static boolean agent() {
		return Companion.control().agent();
	}

	public static String text() {
		return agent() ? AGENT_TEXT : USER_TEXT;
	}

	public static int background() {
		return 0xC0000000;
	}

	public static int foreground() {
		return agent() ? 0xFFFFFFFF : 0xFFD8D8D8;
	}

	public static Box box(int screenWidth, int textWidth, int fontHeight, int bossBarBottom, int titleBottom) {
		int top = MARGIN;
		if (bossBarBottom > 0) top = Math.max(top, bossBarBottom + GAP);
		if (titleBottom > 0) top = Math.max(top, titleBottom + GAP);
		int width = textWidth + PADDING_X * 2;
		int height = fontHeight + PADDING_Y * 2;
		return new Box(Math.max(0, (screenWidth - width) / 2), top, width, height);
	}

	public static int textX(Box box) {
		return box.x() + PADDING_X;
	}

	public static int textY(Box box) {
		return box.y() + PADDING_Y;
	}

	public static int bossBarBottom(int count) {
		return count <= 0 ? 0 : 12 + (count - 1) * 19 + 5;
	}

	public static int titleBottom(int screenHeight, boolean shown) {
		return shown ? screenHeight / 2 + 32 : 0;
	}

	public record Box(int x, int y, int width, int height) {
	}
}
