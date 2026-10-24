package dev.inkstone.companion.core;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class Json {
	private static final Gson GSON = new Gson();

	private Json() {
	}

	public static String string(JsonObject body, String key, String fallback) {
		return body.has(key) && !body.get(key).isJsonNull() ? body.get(key).getAsString() : fallback;
	}

	public static int integer(JsonObject body, String key, int fallback) {
		return body.has(key) && !body.get(key).isJsonNull() ? body.get(key).getAsInt() : fallback;
	}

	public static double number(JsonObject body, String key, double fallback) {
		return body.has(key) && !body.get(key).isJsonNull() ? body.get(key).getAsDouble() : fallback;
	}

	public static boolean bool(JsonObject body, String key, boolean fallback) {
		return body.has(key) && !body.get(key).isJsonNull() ? body.get(key).getAsBoolean() : fallback;
	}

	public static JsonObject object(JsonObject body, String key) {
		return body.has(key) && body.get(key).isJsonObject() ? body.get(key).getAsJsonObject() : null;
	}

	public static JsonArray array(JsonObject body, String key) {
		return body.has(key) && body.get(key).isJsonArray() ? body.get(key).getAsJsonArray() : null;
	}

	public static double[] triple(JsonObject body, String key) {
		JsonElement element = body.get(key);
		if (element == null || !element.isJsonArray()) return null;
		JsonArray array = element.getAsJsonArray();
		if (array.size() != 3) return null;
		return new double[] {array.get(0).getAsDouble(), array.get(1).getAsDouble(), array.get(2).getAsDouble()};
	}

	public static List<String> strings(JsonObject body, String key) {
		JsonArray array = array(body, key);
		List<String> values = new ArrayList<>();
		if (array == null) return values;
		for (JsonElement element : array) if (!element.isJsonNull()) values.add(element.getAsString());
		return values;
	}

	public static Map<String, Object> stringMap(JsonObject body, String key) {
		JsonObject object = object(body, key);
		Map<String, Object> values = new LinkedHashMap<>();
		if (object == null) return values;
		for (Map.Entry<String, JsonElement> entry : object.entrySet()) values.put(entry.getKey(), plain(entry.getValue()));
		return values;
	}

	public static Object plain(JsonElement element) {
		if (element == null || element.isJsonNull()) return null;
		if (element.isJsonPrimitive()) {
			if (element.getAsJsonPrimitive().isBoolean()) return element.getAsBoolean();
			if (element.getAsJsonPrimitive().isNumber()) return element.getAsDouble();
			return element.getAsString();
		}
		return GSON.fromJson(element, Object.class);
	}

	public static JsonElement tree(Object value) {
		return GSON.toJsonTree(value);
	}

	public static Map<String, Object> map(Object... pairs) {
		Map<String, Object> result = new LinkedHashMap<>();
		for (int index = 0; index + 1 < pairs.length; index += 2) result.put(String.valueOf(pairs[index]), pairs[index + 1]);
		return result;
	}
}
