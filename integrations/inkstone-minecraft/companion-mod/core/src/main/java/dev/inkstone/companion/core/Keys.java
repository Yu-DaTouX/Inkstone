package dev.inkstone.companion.core;

import java.util.LinkedHashMap;
import java.util.Map;
import org.lwjgl.glfw.GLFW;

public final class Keys {
	private static final Map<String, Integer> CODES = new LinkedHashMap<>();

	static {
		for (char letter = 'a'; letter <= 'z'; letter++) CODES.put(String.valueOf(letter), GLFW.GLFW_KEY_A + (letter - 'a'));
		for (char digit = '0'; digit <= '9'; digit++) CODES.put(String.valueOf(digit), GLFW.GLFW_KEY_0 + (digit - '0'));
		CODES.put("space", GLFW.GLFW_KEY_SPACE);
		CODES.put("escape", GLFW.GLFW_KEY_ESCAPE);
		CODES.put("esc", GLFW.GLFW_KEY_ESCAPE);
		CODES.put("enter", GLFW.GLFW_KEY_ENTER);
		CODES.put("return", GLFW.GLFW_KEY_ENTER);
		CODES.put("tab", GLFW.GLFW_KEY_TAB);
		CODES.put("backspace", GLFW.GLFW_KEY_BACKSPACE);
		CODES.put("delete", GLFW.GLFW_KEY_DELETE);
		CODES.put("insert", GLFW.GLFW_KEY_INSERT);
		CODES.put("home", GLFW.GLFW_KEY_HOME);
		CODES.put("end", GLFW.GLFW_KEY_END);
		CODES.put("page_up", GLFW.GLFW_KEY_PAGE_UP);
		CODES.put("page_down", GLFW.GLFW_KEY_PAGE_DOWN);
		CODES.put("up", GLFW.GLFW_KEY_UP);
		CODES.put("down", GLFW.GLFW_KEY_DOWN);
		CODES.put("left", GLFW.GLFW_KEY_LEFT);
		CODES.put("right", GLFW.GLFW_KEY_RIGHT);
		CODES.put("left_shift", GLFW.GLFW_KEY_LEFT_SHIFT);
		CODES.put("right_shift", GLFW.GLFW_KEY_RIGHT_SHIFT);
		CODES.put("shift", GLFW.GLFW_KEY_LEFT_SHIFT);
		CODES.put("left_control", GLFW.GLFW_KEY_LEFT_CONTROL);
		CODES.put("right_control", GLFW.GLFW_KEY_RIGHT_CONTROL);
		CODES.put("control", GLFW.GLFW_KEY_LEFT_CONTROL);
		CODES.put("ctrl", GLFW.GLFW_KEY_LEFT_CONTROL);
		CODES.put("left_alt", GLFW.GLFW_KEY_LEFT_ALT);
		CODES.put("right_alt", GLFW.GLFW_KEY_RIGHT_ALT);
		CODES.put("alt", GLFW.GLFW_KEY_LEFT_ALT);
		CODES.put("caps_lock", GLFW.GLFW_KEY_CAPS_LOCK);
		for (int index = 1; index <= 12; index++) CODES.put("f" + index, GLFW.GLFW_KEY_F1 + (index - 1));
		CODES.put("minus", GLFW.GLFW_KEY_MINUS);
		CODES.put("equal", GLFW.GLFW_KEY_EQUAL);
		CODES.put("comma", GLFW.GLFW_KEY_COMMA);
		CODES.put("period", GLFW.GLFW_KEY_PERIOD);
		CODES.put("slash", GLFW.GLFW_KEY_SLASH);
		CODES.put("semicolon", GLFW.GLFW_KEY_SEMICOLON);
		CODES.put("apostrophe", GLFW.GLFW_KEY_APOSTROPHE);
		CODES.put("grave", GLFW.GLFW_KEY_GRAVE_ACCENT);
		CODES.put("left_bracket", GLFW.GLFW_KEY_LEFT_BRACKET);
		CODES.put("right_bracket", GLFW.GLFW_KEY_RIGHT_BRACKET);
		CODES.put("backslash", GLFW.GLFW_KEY_BACKSLASH);
	}

	private Keys() {
	}

	public static int code(String name) {
		String key = name == null ? "" : name.trim().toLowerCase();
		if (key.startsWith("key.keyboard.")) key = key.substring("key.keyboard.".length());
		Integer code = CODES.get(key);
		if (code == null) throw new IllegalArgumentException("unknown key " + name);
		return code;
	}

	public static boolean known(String name) {
		try {
			code(name);
			return true;
		} catch (IllegalArgumentException error) {
			return false;
		}
	}
}
