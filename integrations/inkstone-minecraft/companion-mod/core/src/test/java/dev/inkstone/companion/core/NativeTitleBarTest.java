package dev.inkstone.companion.core;

import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.imageio.ImageIO;
import org.lwjgl.system.MemoryStack;
import org.lwjgl.system.MemoryUtil;
import org.lwjgl.system.Platform;
import org.lwjgl.system.libffi.FFICIF;
import org.lwjgl.system.libffi.LibFFI;
import org.lwjgl.system.windows.User32;
import static org.lwjgl.system.JNI.*;

final class NativeTitleBarTest {
	private static int passed;

	private static void check(boolean value, String name) {
		if (!value) throw new AssertionError(name);
		passed++;
	}

	static int run() throws Exception {
		for (int dpi : new int[] {96, 120, 144, 192, 288}) {
			int width = 960 * dpi / 96;
			int left = width - 138 * dpi / 96;
			TitleBarBounds bounds = TitleBarBounds.beside(-1920, 0, width, left, 0, width, 32 * dpi / 96, dpi);
			check(bounds != null && bounds.x() + bounds.width() < -1920 + left && bounds.x() >= -1920 && bounds.height() > 0, "native button stays left of caption controls at DPI " + dpi);
		}
		check(TitleBarBounds.beside(0, 0, 200, 62, 0, 200, 32, 96) == null, "narrow caption is hidden instead of covering system controls");
		check(TitleBarBounds.beside(0, 0, 960, 0, 0, 0, 0, 96) == null, "undefined caption bounds are rejected");
		if (Platform.get() != Platform.WINDOWS) return passed;
		NativeTitleBar.Api api = NativeTitleBar.Api.get();
		long owner;
		try (MemoryStack stack = MemoryStack.stackPush()) {
			owner = api.invoke(api.create, User32.WS_EX_NOACTIVATE | User32.WS_EX_TOOLWINDOW, MemoryUtil.memAddress(stack.UTF16("STATIC")), MemoryUtil.memAddress(stack.UTF16("Inkstone hidden titlebar test")), User32.WS_OVERLAPPEDWINDOW, -32000, -32000, 960, 540, 0L, 0L, 0L, 0L);
		}
		check(owner != 0 && !User32.IsWindowVisible(owner), "native fixture owner stays hidden");
		long ownerProcedure = User32.GetWindowLongPtr(owner, -4);
		long before = callP(api.foreground);
		try (MemoryStack stack = MemoryStack.stackPush()) {
			var rect = org.lwjgl.system.windows.RECT.calloc(stack);
			check(api.invoke(api.windowRect, owner, rect.address()) != 0 && rect.right() > rect.left(), "native frame reader works with the bundled LWJGL version");
		}
		try {
			for (int dpi : new int[] {96, 144, 192}) for (boolean dark : new boolean[] {true, false}) {
				Control control = Control.fromProperties();
				try (NativeTitleBar button = new NativeTitleBar(owner, control::agent, () -> control.toggle(Control.USER))) {
					long handle = button.handle();
					check((User32.GetWindowLongPtr(handle, -20) & User32.WS_EX_NOACTIVATE) != 0 && User32.GetWindowLongPtr(handle, -8) == owner, "native button is nonactivating and owned by its game fixture");
					check(callPPPP(handle, User32.WM_MOUSEACTIVATE, 0L, 0L, api.send) == 3, "mouse activation is explicitly suppressed");
					int width = 96 * dpi / 96;
					int height = 26 * dpi / 96;
					api.invoke(api.position, handle, 0L, -32000, -32000, width, height, User32.SWP_NOACTIVATE | User32.SWP_NOZORDER | User32.SWP_NOOWNERZORDER);
					set(button, "dark", dark);
					set(button, "dpi", dpi);
					capture(button, api, width, height, "agent", dark, dpi);
					callPPPP(handle, 0x00F5, 0L, 0L, api.send);
					check(!control.agent() && button.label().equals("交还 Agent"), "native BM_CLICK takes control without keyboard input");
					check(windowText(handle, api).equals("交还 Agent"), "native accessibility label follows user control");
					capture(button, api, width, height, "user", dark, dpi);
					callPPPP(handle, 0x00F5, 0L, 0L, api.send);
					check(control.agent() && button.label().equals("接管"), "second native BM_CLICK returns control");
					check(windowText(handle, api).equals("接管"), "native accessibility label follows agent control");
					button.update();
					check(!User32.IsWindowVisible(handle) && callP(api.foreground) != handle && callP(api.foreground) != owner, "hidden fixture never becomes visible or foreground");
				}
			}
			check(User32.GetWindowLongPtr(owner, -4) == ownerProcedure, "game window procedure is preserved");
			check(callP(api.foreground) != owner, "test does not foreground its hidden game fixture");
			System.out.println("Native titlebar: " + passed + " passed; foreground before=" + before + " after=" + callP(api.foreground));
		} finally { api.invoke(api.destroy, owner); }
		return passed;
	}

	private static void set(Object target, String name, Object value) throws Exception {
		var field = target.getClass().getDeclaredField(name);
		field.setAccessible(true);
		field.set(target, value);
	}

	private static String windowText(long window, NativeTitleBar.Api api) {
		try (MemoryStack stack = MemoryStack.stackPush()) {
			var text = stack.calloc(128);
			callPPI(window, MemoryUtil.memAddress(text), 64, NativeTitleBar.Api.required(api.user, "GetWindowTextW"));
			return MemoryUtil.memUTF16(MemoryUtil.memAddress(text));
		}
	}

	private static void capture(NativeTitleBar button, NativeTitleBar.Api api, int width, int height, String state, boolean dark, int dpi) throws Exception {
		long createDc = NativeTitleBar.Api.required(api.gdi, "CreateCompatibleDC");
		long deleteDc = NativeTitleBar.Api.required(api.gdi, "DeleteDC");
		long createDib = NativeTitleBar.Api.required(api.gdi, "CreateDIBSection");
		long dc = callPP(0L, createDc);
		long bitmap = 0;
		long previous = 0;
		try (MemoryStack stack = MemoryStack.stackPush()) {
			var info = stack.calloc(40);
			info.putInt(0, 40).putInt(4, width).putInt(8, -height).putShort(12, (short) 1).putShort(14, (short) 32);
			var bits = stack.callocPointer(1);
			FFICIF cif = FFICIF.calloc(stack);
			var types = stack.pointers(LibFFI.ffi_type_pointer.address(), LibFFI.ffi_type_pointer.address(), LibFFI.ffi_type_uint32.address(), LibFFI.ffi_type_pointer.address(), LibFFI.ffi_type_pointer.address(), LibFFI.ffi_type_uint32.address());
			check(LibFFI.ffi_prep_cif(cif, LibFFI.FFI_DEFAULT_ABI, LibFFI.ffi_type_pointer, types) == 0, "offscreen bitmap call prepared");
			var values = stack.pointers(stack.pointers(dc).address(), stack.pointers(MemoryUtil.memAddress(info)).address(), MemoryUtil.memAddress(stack.ints(0)), stack.pointers(bits.address()).address(), stack.pointers(0L).address(), MemoryUtil.memAddress(stack.ints(0)));
			var result = stack.calloc(8);
			LibFFI.ffi_call(cif, createDib, result, values);
			bitmap = MemoryUtil.memGetAddress(MemoryUtil.memAddress(result));
			check(dc != 0 && bitmap != 0 && bits.get(0) != 0, "offscreen native DIB allocated");
			previous = callPPP(dc, bitmap, api.select);
			callPPPP(button.handle(), 0x0318, dc, 0L, api.send);
			var pixels = MemoryUtil.memByteBuffer(bits.get(0), width * height * 4);
			BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
			boolean varied = false;
			java.util.Set<Integer> colors = new java.util.HashSet<>();
			int first = pixels.getInt(0);
			for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
				int offset = (y * width + x) * 4;
				int rgb = (pixels.get(offset) & 255) | (pixels.get(offset + 1) & 255) << 8 | (pixels.get(offset + 2) & 255) << 16;
				image.setRGB(x, y, 0xff000000 | rgb);
				colors.add(rgb);
				if (pixels.getInt(offset) != first) varied = true;
			}
			check(varied && colors.size() > 2, "native titlebar label and border rendered into an offscreen bitmap");
			String evidence = System.getProperty("inkstone.test.evidence", "");
			if (!evidence.isBlank()) {
				Files.createDirectories(Path.of(evidence));
				Path path = Path.of(evidence, "titlebar-" + org.lwjgl.Version.getVersion() + "-" + state + "-" + (dark ? "dark" : "light") + "-" + dpi + "-" + System.nanoTime() + ".png");
				ImageIO.write(image, "png", path.toFile());
			}
		} finally {
			if (previous != 0) callPPP(dc, previous, api.select);
			if (bitmap != 0) callPI(bitmap, api.delete);
			callPI(dc, deleteDc);
		}
	}
}
