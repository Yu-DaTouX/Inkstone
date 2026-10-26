package dev.inkstone.companion.core;

import java.nio.ByteBuffer;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;
import java.util.function.BooleanSupplier;
import org.lwjgl.glfw.GLFWNativeWin32;
import org.lwjgl.system.MemoryStack;
import org.lwjgl.system.Platform;
import org.lwjgl.system.SharedLibrary;
import org.lwjgl.system.windows.GDI32;
import org.lwjgl.system.windows.RECT;
import org.lwjgl.system.windows.User32;
import org.lwjgl.system.windows.WindowProc;
import org.lwjgl.system.windows.WindowsLibrary;
import static org.lwjgl.system.JNI.*;

public final class NativeTitleBar implements AutoCloseable {
	private static final int WINDOW_PROCEDURE = -4;
	private static final int BUTTON_FLAT = 0x8000;
	private static final int BUTTON_CLICK = 0x00F5;
	private static final int PRINT_CLIENT = 0x0318;
	private static final int MOUSE_LEAVE = 0x02A3;
	private static volatile NativeTitleBar current;
	private static volatile boolean failed;
	private static volatile String failure;
	private final long owner;
	private final BooleanSupplier agent;
	private final Runnable toggle;
	private final Api api;
	private final WindowProc procedure;
	private volatile long window;
	private long previous;
	private long font;
	private int dpi = 96;
	private boolean dark = true;
	private boolean hover;
	private boolean pressed;
	private boolean closed;
	private String text = "";
	private TitleBarBounds bounds;
	private volatile String reason = "not-ready";

	NativeTitleBar(long owner, BooleanSupplier agent, Runnable toggle) {
		this.owner = owner;
		this.agent = agent;
		this.toggle = toggle;
		this.api = Api.get();
		this.procedure = WindowProc.create(this::message);
		try {
			try (MemoryStack stack = MemoryStack.stackPush()) {
				window = api.invoke(api.create, User32.WS_EX_NOACTIVATE | User32.WS_EX_TOOLWINDOW, org.lwjgl.system.MemoryUtil.memAddress(stack.UTF16("BUTTON")), org.lwjgl.system.MemoryUtil.memAddress(stack.UTF16(label())), User32.WS_POPUP | BUTTON_FLAT, -32000, -32000, 96, 26, owner, 0L, 0L, 0L);
			}
			if (window == 0) throw new IllegalStateException("cannot create native takeover button");
			previous = api.invoke(api.subclass, window, WINDOW_PROCEDURE, procedure.address());
			if (previous == 0) throw new IllegalStateException("cannot install native takeover button callback");
		} catch (RuntimeException error) {
			close();
			throw error;
		}
	}

	public static void tick(long glfwWindow, Control control) {
		if (Platform.get() != Platform.WINDOWS || failed || "off".equalsIgnoreCase(System.getProperty("inkstone.titlebar.button", "on"))) return;
		try {
			long owner = GLFWNativeWin32.glfwGetWin32Window(glfwWindow);
			if (current == null || current.owner != owner || current.window == 0) {
				if (current != null) current.close();
				current = new NativeTitleBar(owner, control::agent, () -> {
					control.toggle(Control.USER);
					AgentWindow.applyTitle(glfwWindow);
				});
				Companion.log("native titlebar takeover button ready");
			}
			current.update();
		} catch (Throwable error) {
			failed = true;
			failure = String.valueOf(error.getMessage());
			if (current != null) current.hide("unavailable");
			Companion.log("native titlebar takeover button unavailable: " + error);
		}
	}

	public static Map<String, Object> status() {
		boolean supported = Platform.get() == Platform.WINDOWS;
		boolean enabled = !"off".equalsIgnoreCase(System.getProperty("inkstone.titlebar.button", "on"));
		return Json.map("placement", "native-titlebar", "supported", supported, "enabled", enabled, "created", current != null && current.window != 0, "visible", current != null && current.window != 0 && User32.IsWindowVisible(current.window), "reason", !supported ? "unsupported-platform" : !enabled ? "disabled" : failed ? failure : current == null ? "not-ready" : current.reason);
	}

	void update() {
		if (window == 0) return;
		if (!User32.IsWindowVisible(owner) || User32.IsIconic(owner) || callPI(owner, api.enabled) == 0) { hide("hidden-minimized-or-modal"); return; }
		if ((User32.GetWindowLongPtr(owner, User32.GWL_STYLE) & User32.WS_CAPTION) == 0) { hide("fullscreen"); return; }
		try (MemoryStack stack = MemoryStack.stackPush()) {
			RECT frame = RECT.calloc(stack);
			RECT controls = RECT.calloc(stack);
			if (api.invoke(api.windowRect, owner, frame.address()) == 0 || callPPI(owner, 5, controls.address(), RECT.SIZEOF, api.dwmAttribute) != 0) { hide("no-caption-bounds"); return; }
			int nextDpi = Math.max(48, callPI(owner, api.dpi));
			TitleBarBounds next = TitleBarBounds.beside(frame.left(), frame.top(), frame.right() - frame.left(), controls.left(), controls.top(), controls.right(), controls.bottom(), nextDpi);
			if (next == null) { hide("no-caption-room"); return; }
			var mode = stack.callocInt(1);
			if (callPPI(owner, 20, org.lwjgl.system.MemoryUtil.memAddress(mode), 4, api.dwmAttribute) == 0 && dark != (mode.get(0) != 0)) { dark = mode.get(0) != 0; invalidate(); }
			if (nextDpi != dpi) { dpi = nextDpi; deleteFont(); invalidate(); }
			String label = label();
			if (!label.equals(text)) { api.invoke(api.setText, window, org.lwjgl.system.MemoryUtil.memAddress(stack.UTF16(label))); text = label; invalidate(); }
			long aboveOwner = callPP(owner, 3, api.getWindow);
			if (!next.equals(bounds) || !User32.IsWindowVisible(window) || aboveOwner != window) {
				int flags = User32.SWP_NOACTIVATE | User32.SWP_NOOWNERZORDER | User32.SWP_SHOWWINDOW;
				if (aboveOwner == window) flags |= User32.SWP_NOZORDER;
				if (api.invoke(api.position, window, aboveOwner == window ? 0L : aboveOwner, next.x(), next.y(), next.width(), next.height(), flags) == 0) { hide("position-failed"); return; }
				bounds = next;
			}
			reason = "ready";
		}
	}

	String label() {
		return agent.getAsBoolean() ? "接管" : "交还 Agent";
	}

	long handle() {
		return window;
	}

	private long message(long handle, int message, long wParam, long lParam) {
		try {
			if (message == User32.WM_MOUSEACTIVATE) return 3;
			if (message == User32.WM_ERASEBKGND) return 1;
			if (message == User32.WM_PAINT) { paint(handle, 0); callPPI(handle, 0L, api.validate); return 0; }
			if (message == PRINT_CLIENT) { paint(handle, wParam); return 0; }
			if (message == BUTTON_CLICK) { click(); return 0; }
			if (message == User32.WM_LBUTTONDOWN || message == User32.WM_LBUTTONDBLCLK) {
				pressed = true;
				callPP(handle, api.capture);
				invalidate();
				return 0;
			}
			if (message == User32.WM_LBUTTONUP) {
				boolean click = pressed;
				pressed = false;
				releaseCapture();
				try (MemoryStack stack = MemoryStack.stackPush()) {
					RECT rect = RECT.calloc(stack);
					int x = (short) (lParam & 0xffff);
					int y = (short) ((lParam >>> 16) & 0xffff);
					if (click && callPPI(handle, rect.address(), api.clientRect) != 0 && x >= 0 && y >= 0 && x < rect.right() && y < rect.bottom()) click();
				}
				invalidate();
				return 0;
			}
			if (message == User32.WM_MOUSEMOVE) {
				if (!hover) {
					try (MemoryStack stack = MemoryStack.stackPush()) {
						int bytes = org.lwjgl.system.Pointer.POINTER_SIZE == 8 ? 24 : 16;
						ByteBuffer track = stack.calloc(bytes);
						track.putInt(0, bytes).putInt(4, 2);
						org.lwjgl.system.MemoryUtil.memPutAddress(org.lwjgl.system.MemoryUtil.memAddress(track) + 8, handle);
						callPI(org.lwjgl.system.MemoryUtil.memAddress(track), api.trackMouse);
					}
				}
				hover = true;
				invalidate();
			}
			if (message == MOUSE_LEAVE || message == User32.WM_CANCELMODE || message == User32.WM_CAPTURECHANGED) { hover = false; pressed = false; invalidate(); }
			long result = User32.nCallWindowProc(previous, handle, message, wParam, lParam);
			if (message == User32.WM_NCDESTROY) window = 0;
			return result;
		} catch (Throwable error) {
			if (message == User32.WM_PAINT) callPPI(handle, 0L, api.validate);
			Companion.log("native takeover button event failed: " + error);
			return 0;
		}
	}

	private void click() {
		toggle.run();
		String label = label();
		try (MemoryStack stack = MemoryStack.stackPush()) {
			api.invoke(api.setText, window, org.lwjgl.system.MemoryUtil.memAddress(stack.UTF16(label)));
		}
		text = label;
		invalidate();
	}

	void paint(long handle, long suppliedDc) {
		long dc = suppliedDc != 0 ? suppliedDc : User32.GetDC(handle);
		if (dc == 0) return;
		long oldFont = 0;
		try (MemoryStack stack = MemoryStack.stackPush()) {
			RECT rect = RECT.calloc(stack);
			callPPI(handle, rect.address(), api.clientRect);
			int background = dark ? (pressed ? 0x464646 : hover ? 0x3a3a3a : 0x292929) : (pressed ? 0xd3d3d3 : hover ? 0xe3e3e3 : 0xf3f3f3);
			fill(dc, rect, background, api.fillRect);
			fill(dc, rect, dark ? 0x656565 : 0xb9b9b9, api.frameRect);
			if (font == 0) {
				ByteBuffer logfont = stack.calloc(92);
				logfont.putInt(0, -(int) Math.round(12 * dpi / 96.0));
				logfont.putInt(16, 400);
				logfont.put(23, (byte) 1);
				logfont.put(26, (byte) 5);
				logfont.position(28).put(stack.UTF16("Segoe UI"));
				font = callPP(org.lwjgl.system.MemoryUtil.memAddress(logfont.position(0)), api.font);
			}
			if (font != 0) oldFont = callPPP(dc, font, api.select);
			callPI(dc, 1, api.bkMode);
			callPI(dc, dark ? 0xf2f2f2 : 0x202020, api.textColor);
			String label = label();
			callPPPI(dc, org.lwjgl.system.MemoryUtil.memAddress(stack.UTF16(label)), label.length(), rect.address(), 0x0001 | 0x0004 | 0x0020 | 0x0800, api.drawText);
		} finally {
			if (oldFont != 0) callPPP(dc, oldFont, api.select);
			if (suppliedDc == 0) User32.ReleaseDC(handle, dc);
		}
	}

	private void fill(long dc, RECT rect, int color, long function) {
		long brush = callP(color, api.brush);
		try { callPPPI(dc, rect.address(), brush, function); }
		finally { callPI(brush, api.delete); }
	}

	private void invalidate() {
		if (window != 0) callPPI(window, 0L, 0, api.invalidate);
	}

	private void releaseCapture() {
		if (window != 0 && callP(api.getCapture) == window) callI(api.releaseCapture);
	}

	private void hide(String why) {
		reason = why;
		pressed = false;
		hover = false;
		releaseCapture();
		if (window != 0 && User32.IsWindowVisible(window)) User32.ShowWindow(window, User32.SW_HIDE);
	}

	private void deleteFont() {
		if (font != 0) { callPI(font, api.delete); font = 0; }
	}

	@Override
	public void close() {
		if (closed) return;
		closed = true;
		if (window != 0) { releaseCapture(); api.invoke(api.destroy, window); window = 0; }
		deleteFont();
		procedure.free();
	}

	static final class Api {
		private static Api instance;
		final SharedLibrary user = User32.getLibrary();
		final SharedLibrary gdi = GDI32.getLibrary();
		final SharedLibrary dwm = new WindowsLibrary(Path.of(System.getenv().getOrDefault("SystemRoot", "C:\\Windows"), "System32", "dwmapi.dll").toString());
		final Method create = wrapped("nCreateWindowEx", 12);
		final Method subclass = wrapped("nSetWindowLongPtr", 3);
		final Method windowRect = wrapped("nGetWindowRect", 2);
		final Method setText = wrapped("nSetWindowText", 2);
		final Method position = wrapped("nSetWindowPos", 7);
		final Method destroy = wrapped("nDestroyWindow", 1);
		final long send = required(user, "SendMessageW");
		final long foreground = required(user, "GetForegroundWindow");
		final long getWindow = required(user, "GetWindow");
		final long enabled = required(user, "IsWindowEnabled");
		final long trackMouse = required(user, "TrackMouseEvent");
		final long dpi = required(user, "GetDpiForWindow");
		final long dwmAttribute = required(dwm, "DwmGetWindowAttribute");
		final long capture = required(user, "SetCapture");
		final long getCapture = required(user, "GetCapture");
		final long releaseCapture = required(user, "ReleaseCapture");
		final long clientRect = required(user, "GetClientRect");
		final long invalidate = required(user, "InvalidateRect");
		final long validate = required(user, "ValidateRect");
		final long fillRect = required(user, "FillRect");
		final long frameRect = required(user, "FrameRect");
		final long drawText = required(user, "DrawTextW");
		final long font = required(gdi, "CreateFontIndirectW");
		final long brush = required(gdi, "CreateSolidBrush");
		final long delete = required(gdi, "DeleteObject");
		final long select = required(gdi, "SelectObject");
		final long textColor = required(gdi, "SetTextColor");
		final long bkMode = required(gdi, "SetBkMode");

		static Api get() {
			if (instance == null) instance = new Api();
			return instance;
		}

		static long required(SharedLibrary library, String name) {
			long address = library.getFunctionAddress(name);
			if (address == 0) throw new IllegalStateException("missing Windows API " + name);
			return address;
		}

		static Method wrapped(String name, int arguments) {
			Method nativeWrapper = Arrays.stream(User32.class.getMethods()).filter(method -> method.getName().equals(name) && !Modifier.isNative(method.getModifiers()) && (method.getParameterCount() == arguments || method.getParameterCount() == arguments + 1)).findFirst().orElse(null);
			if (nativeWrapper != null) return nativeWrapper;
			return Arrays.stream(User32.class.getMethods()).filter(method -> method.getName().equals(name.substring(1)) && !Modifier.isNative(method.getModifiers()) && method.getParameterCount() == arguments).findFirst().orElseThrow(() -> new IllegalStateException("missing LWJGL wrapper " + name));
		}

		long invoke(Method method, Object... arguments) {
			try {
				if (method.getParameterCount() != arguments.length) {
					Object[] withError = new Object[arguments.length + 1];
					withError[0] = 0L;
					System.arraycopy(arguments, 0, withError, 1, arguments.length);
					arguments = withError;
				}
				Object result = method.invoke(null, arguments);
				return result instanceof Boolean value ? (value ? 1 : 0) : ((Number) result).longValue();
			} catch (ReflectiveOperationException error) { throw new IllegalStateException(method.getName(), error); }
		}
	}
}
