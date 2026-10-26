package dev.inkstone.companion.core;

import java.util.concurrent.atomic.AtomicInteger;
import org.lwjgl.glfw.GLFW;
import org.lwjgl.glfw.GLFWCharCallback;
import org.lwjgl.glfw.GLFWCursorPosCallback;
import org.lwjgl.glfw.GLFWKeyCallback;
import org.lwjgl.glfw.GLFWMouseButtonCallback;
import org.lwjgl.glfw.GLFWScrollCallback;

public final class AgentWindow {
	private static final String PLACEMENT = System.getProperty("inkstone.window.placement", "corner").trim().toLowerCase();
	private static final String INPUT = System.getProperty("inkstone.input", "background").trim().toLowerCase();
	private static final String BASE_TITLE = System.getProperty("inkstone.window.title", "Inkstone Agent");
	private static final String AGENT_SUFFIX = " — Agent 操作中（F8 接管）";
	private static final String USER_SUFFIX = " — 你在操作（F8 交还）";
	private static final int MARGIN = 16;
	private static final int ENFORCE_TICKS = 40;

	private static final AtomicInteger TICKS = new AtomicInteger();
	private static volatile Control control;
	private static volatile GameBridge bridge;
	private static volatile String appliedTitle = "";

	private static GLFWKeyCallback keyHook;
	private static GLFWCharCallback charHook;
	private static GLFWMouseButtonCallback mouseHook;
	private static GLFWCursorPosCallback cursorHook;
	private static GLFWScrollCallback scrollHook;
	private static GLFWKeyCallback previousKey;
	private static GLFWCharCallback previousChar;
	private static GLFWMouseButtonCallback previousMouse;
	private static GLFWCursorPosCallback previousCursor;
	private static GLFWScrollCallback previousScroll;

	private AgentWindow() {
	}

	public static void attach(Control owner, GameBridge gameBridge) {
		control = owner;
		bridge = gameBridge;
		owner.onChanged(() -> appliedTitle = "");
	}

	public static String title() {
		Control current = control;
		boolean agent = current == null ? !Control.USER.equalsIgnoreCase(System.getProperty("inkstone.control", "")) : current.agent();
		return BASE_TITLE + (agent ? AGENT_SUFFIX : USER_SUFFIX);
	}

	public static boolean corner() {
		return PLACEMENT.equals("corner");
	}

	public static boolean background() {
		return INPUT.equals("background");
	}

	public static void prepareHints() {
		if (!Companion.enabled()) return;
		if (corner()) GLFW.glfwWindowHint(GLFW.GLFW_VISIBLE, GLFW.GLFW_FALSE);
		GLFW.glfwWindowHint(GLFW.GLFW_FOCUS_ON_SHOW, GLFW.GLFW_FALSE);
	}

	public static void afterCreate(long handle) {
		if (!Companion.enabled() || handle == 0L) return;
		try {
			GLFW.glfwSetWindowAttrib(handle, GLFW.GLFW_FOCUS_ON_SHOW, GLFW.GLFW_FALSE);
			if (corner()) place(handle);
			appliedTitle = "";
			applyTitle(handle);
			if (corner() && GLFW.glfwGetWindowAttrib(handle, GLFW.GLFW_VISIBLE) == GLFW.GLFW_FALSE) GLFW.glfwShowWindow(handle);
		} catch (RuntimeException error) {
			Companion.log("window setup failed: " + error);
			GLFW.glfwShowWindow(handle);
		}
	}

	public static boolean interceptTitle(long handle) {
		if (!Companion.enabled()) return false;
		applyTitle(handle);
		return true;
	}

	public static void applyTitle(long handle) {
		String desired = title();
		if (desired.equals(appliedTitle)) return;
		GLFW.glfwSetWindowTitle(handle, desired);
		appliedTitle = desired;
	}

	public static void tick(long handle) {
		if (!Companion.enabled() || handle == 0L) return;
		Control current = control;
		if (current == null) return;
		try {
			install(handle);
			NativeTitleBar.tick(handle, current);
			applyTitle(handle);
			if (current.agent() && background()) GLFW.glfwSetInputMode(handle, GLFW.GLFW_CURSOR, GLFW.GLFW_CURSOR_NORMAL);
			int count = TICKS.incrementAndGet();
			if (GLFW.glfwGetWindowAttrib(handle, GLFW.GLFW_VISIBLE) == GLFW.GLFW_FALSE) GLFW.glfwShowWindow(handle);
			if (corner() && count <= ENFORCE_TICKS && count % 5 == 0) place(handle);
		} catch (RuntimeException error) {
			Companion.log("window tick failed: " + error);
		}
	}

	private static void place(long handle) {
		long monitor = GLFW.glfwGetPrimaryMonitor();
		if (monitor == 0L) return;
		int[] areaX = new int[1];
		int[] areaY = new int[1];
		int[] areaWidth = new int[1];
		int[] areaHeight = new int[1];
		GLFW.glfwGetMonitorWorkarea(monitor, areaX, areaY, areaWidth, areaHeight);
		int[] windowWidth = new int[1];
		int[] windowHeight = new int[1];
		GLFW.glfwGetWindowSize(handle, windowWidth, windowHeight);
		int x = areaX[0] + Math.max(0, areaWidth[0] - windowWidth[0] - MARGIN);
		int y = areaY[0] + Math.max(0, areaHeight[0] - windowHeight[0] - MARGIN);
		GLFW.glfwSetWindowPos(handle, x, y);
	}

	private static synchronized void install(long handle) {
		if (keyHook == null) {
			keyHook = GLFWKeyCallback.create(AgentWindow::onKey);
			charHook = GLFWCharCallback.create(AgentWindow::onChar);
			mouseHook = GLFWMouseButtonCallback.create(AgentWindow::onMouseButton);
			cursorHook = GLFWCursorPosCallback.create(AgentWindow::onCursorPos);
			scrollHook = GLFWScrollCallback.create(AgentWindow::onScroll);
		}
		GLFWKeyCallback key = GLFW.glfwSetKeyCallback(handle, keyHook);
		if (replaced(key, keyHook, previousKey)) previousKey = key;
		GLFWCharCallback character = GLFW.glfwSetCharCallback(handle, charHook);
		if (replaced(character, charHook, previousChar)) previousChar = character;
		GLFWMouseButtonCallback mouse = GLFW.glfwSetMouseButtonCallback(handle, mouseHook);
		if (replaced(mouse, mouseHook, previousMouse)) previousMouse = mouse;
		GLFWCursorPosCallback cursor = GLFW.glfwSetCursorPosCallback(handle, cursorHook);
		if (replaced(cursor, cursorHook, previousCursor)) previousCursor = cursor;
		GLFWScrollCallback scroll = GLFW.glfwSetScrollCallback(handle, scrollHook);
		if (replaced(scroll, scrollHook, previousScroll)) previousScroll = scroll;
	}

	private static boolean replaced(GLFWKeyCallback current, GLFWKeyCallback hook, GLFWKeyCallback previous) {
		return current != null && current.address() != hook.address() && (previous == null || current.address() != previous.address());
	}

	private static boolean replaced(GLFWCharCallback current, GLFWCharCallback hook, GLFWCharCallback previous) {
		return current != null && current.address() != hook.address() && (previous == null || current.address() != previous.address());
	}

	private static boolean replaced(GLFWMouseButtonCallback current, GLFWMouseButtonCallback hook, GLFWMouseButtonCallback previous) {
		return current != null && current.address() != hook.address() && (previous == null || current.address() != previous.address());
	}

	private static boolean replaced(GLFWCursorPosCallback current, GLFWCursorPosCallback hook, GLFWCursorPosCallback previous) {
		return current != null && current.address() != hook.address() && (previous == null || current.address() != previous.address());
	}

	private static boolean replaced(GLFWScrollCallback current, GLFWScrollCallback hook, GLFWScrollCallback previous) {
		return current != null && current.address() != hook.address() && (previous == null || current.address() != previous.address());
	}

	private static boolean locked() {
		Control current = control;
		return current != null && current.agent();
	}

	private static void onKey(long window, int key, int scancode, int action, int modifiers) {
		try {
			if (key == GLFW.GLFW_KEY_F8 && action == GLFW.GLFW_PRESS) {
				Control current = control;
				if (current != null) current.toggle(Control.USER);
				applyTitle(window);
				return;
			}
			if (locked() && action != GLFW.GLFW_RELEASE) return;
			GLFWKeyCallback previous = previousKey;
			if (previous != null) previous.invoke(window, key, scancode, action, modifiers);
		} catch (RuntimeException error) {
			Companion.log("key callback failed: " + error);
		}
	}

	private static void onChar(long window, int codepoint) {
		try {
			if (locked()) return;
			GLFWCharCallback previous = previousChar;
			if (previous != null) previous.invoke(window, codepoint);
		} catch (RuntimeException error) {
			Companion.log("char callback failed: " + error);
		}
	}

	private static void onMouseButton(long window, int button, int action, int modifiers) {
		try {
			if (locked() && action != GLFW.GLFW_RELEASE) return;
			GLFWMouseButtonCallback previous = previousMouse;
			if (previous != null) previous.invoke(window, button, action, modifiers);
		} catch (RuntimeException error) {
			Companion.log("mouse callback failed: " + error);
		}
	}

	private static void onCursorPos(long window, double x, double y) {
		try {
			if (locked()) return;
			GLFWCursorPosCallback previous = previousCursor;
			if (previous != null) previous.invoke(window, x, y);
		} catch (RuntimeException error) {
			Companion.log("cursor callback failed: " + error);
		}
	}

	private static void onScroll(long window, double x, double y) {
		try {
			if (locked()) return;
			GLFWScrollCallback previous = previousScroll;
			if (previous != null) previous.invoke(window, x, y);
		} catch (RuntimeException error) {
			Companion.log("scroll callback failed: " + error);
		}
	}
}
