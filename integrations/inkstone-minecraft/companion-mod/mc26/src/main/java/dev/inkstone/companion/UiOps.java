package dev.inkstone.companion;

import com.google.gson.JsonObject;
import dev.inkstone.companion.core.Companion;
import dev.inkstone.companion.core.Json;
import dev.inkstone.companion.core.Keys;
import dev.inkstone.companion.core.Ui;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractButton;
import net.minecraft.client.gui.components.AbstractSliderButton;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Checkbox;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;

final class UiOps {
	private UiOps() {
	}

	static Map<String, Object> read() {
		Minecraft client = Minecraft.getInstance();
		Screen screen = client.screen;
		if (screen == null) return Json.map("screen", null);
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("class", screen.getClass().getSimpleName());
		result.put("title", screen.getTitle() == null ? "" : screen.getTitle().getString());
		AbstractContainerMenu menu = menu(screen);
		result.put("kind", Ui.kind(screen.getClass().getSimpleName(), menu != null));
		if (menu != null) result.put("menu", menu.getClass().getSimpleName());
		result.put("slots", slots(client, screen, menu));
		result.put("widgets", widgets(screen));
		if (menu != null) result.put("carried", item(menu.getCarried()));
		if (screen instanceof ChatScreen) result.put("suggestions", CommandOps.suggestions(chatText(screen)));
		return Json.map("screen", result);
	}

	private static AbstractContainerMenu menu(Screen screen) {
		if (screen instanceof AbstractContainerScreen<?> container) return container.getMenu();
		return null;
	}

	private static List<Object> slots(Minecraft client, Screen screen, AbstractContainerMenu menu) {
		List<Object> slots = new ArrayList<>();
		if (menu == null || !(screen instanceof ScreenOffset offset)) return slots;
		int offsetX = offset.inkstoneScreenX();
		int offsetY = offset.inkstoneScreenY();
		for (int index = 0; index < menu.slots.size(); index++) {
			Slot slot = menu.slots.get(index);
			boolean player = client.player != null && slot.container == client.player.getInventory();
			slots.add(Json.map("index", index, "x", offsetX + slot.x, "y", offsetY + slot.y, "container", player ? "player" : "menu", "item", item(slot.getItem())));
		}
		return slots;
	}

	private static List<AbstractWidget> clickable(Screen screen) {
		List<AbstractWidget> widgets = new ArrayList<>();
		for (GuiEventListener element : screen.children()) {
			if (element instanceof AbstractWidget widget && widget.visible) widgets.add(widget);
		}
		return widgets;
	}

	private static List<Object> widgets(Screen screen) {
		List<Object> widgets = new ArrayList<>();
		List<AbstractWidget> clickable = clickable(screen);
		for (int index = 0; index < clickable.size(); index++) {
			AbstractWidget widget = clickable.get(index);
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("id", index);
			entry.put("type", type(widget));
			entry.put("label", widget.getMessage() == null ? "" : widget.getMessage().getString());
			if (widget instanceof EditBox field) entry.put("value", field.getValue());
			entry.put("focused", widget.isFocused());
			entry.put("active", widget.active);
			entry.put("x", widget.getX());
			entry.put("y", widget.getY());
			entry.put("w", widget.getWidth());
			entry.put("h", widget.getHeight());
			widgets.add(entry);
		}
		return widgets;
	}

	private static String type(AbstractWidget widget) {
		if (widget instanceof EditBox) return "edit";
		if (widget instanceof Checkbox) return "checkbox";
		if (widget instanceof AbstractSliderButton) return "slider";
		if (widget instanceof AbstractButton) return "button";
		return "other";
	}

	static Map<String, Object> action(JsonObject body) {
		Minecraft client = Minecraft.getInstance();
		Screen screen = client.screen;
		String action = Json.string(body, "action", "");
		if ("open".equals(action)) {
			open(client, body);
			return read();
		}
		if (screen == null) throw new IllegalArgumentException("no screen is open");
		switch (action) {
			case "click" -> click(client, screen, body);
			case "type" -> type(client, screen, body);
			case "key" -> {
				String key = Json.string(body, "key", "");
				if (key.isBlank()) throw new IllegalArgumentException("key is empty");
				screen.keyPressed(new KeyEvent(Keys.code(key), 0, 0));
			}
			case "close" -> screen.onClose();
			default -> throw new IllegalArgumentException("unknown action " + action);
		}
		return read();
	}

	private static void click(Minecraft client, Screen screen, JsonObject body) {
		int button = Ui.button(Json.string(body, "button", "left"));
		boolean shift = Json.bool(body, "shift", false);
		Integer slotIndex = body.has("slot") ? Json.integer(body, "slot", 0) : null;
		Integer widgetIndex = body.has("widget") ? Json.integer(body, "widget", 0) : null;
		if (slotIndex != null) {
			AbstractContainerMenu menu = menu(screen);
			if (menu == null) throw new IllegalArgumentException("this screen has no slots");
			if (client.gameMode == null || client.player == null) throw new IllegalStateException("not in a world");
			ContainerInput input = shift ? ContainerInput.QUICK_MOVE : ContainerInput.PICKUP;
			client.gameMode.handleContainerInput(menu.containerId, slotIndex, button, input, client.player);
			return;
		}
		if (widgetIndex != null) {
			List<AbstractWidget> clickable = clickable(screen);
			if (widgetIndex < 0 || widgetIndex >= clickable.size()) throw new IllegalArgumentException("widget " + widgetIndex + " does not exist (found " + clickable.size() + ")");
			AbstractWidget widget = clickable.get(widgetIndex);
			widget.mouseClicked(new MouseButtonEvent(widget.getX() + widget.getWidth() / 2.0, widget.getY() + widget.getHeight() / 2.0, new MouseButtonInfo(button, 0)), false);
			return;
		}
		if (body.has("x") && body.has("y")) {
			screen.mouseClicked(new MouseButtonEvent(Json.number(body, "x", 0), Json.number(body, "y", 0), new MouseButtonInfo(button, 0)), false);
			return;
		}
		throw new IllegalArgumentException("click needs slot, widget or x+y");
	}

	private static void type(Minecraft client, Screen screen, JsonObject body) {
		String text = Json.string(body, "text", "");
		boolean replace = Json.bool(body, "replace", false);
		boolean submit = Json.bool(body, "submit", false);
		Integer widgetIndex = body.has("widget") ? Json.integer(body, "widget", 0) : null;
		EditBox field = null;
		if (widgetIndex != null) {
			List<AbstractWidget> clickable = clickable(screen);
			if (widgetIndex < 0 || widgetIndex >= clickable.size()) throw new IllegalArgumentException("widget " + widgetIndex + " does not exist (found " + clickable.size() + ")");
			if (clickable.get(widgetIndex) instanceof EditBox candidate) field = candidate;
			if (field == null) throw new IllegalArgumentException("widget " + widgetIndex + " is not a text field");
		} else {
			for (AbstractWidget widget : clickable(screen)) {
				if (widget instanceof EditBox candidate && candidate.isFocused()) {
					field = candidate;
					break;
				}
			}
			if (field == null) throw new IllegalArgumentException("no focused text field; pass widget");
		}
		field.setFocused(true);
		if (replace) field.setValue("");
		field.insertText(text);
		if (submit) {
			if (screen instanceof ChatScreen chat) chat.handleChatInput(field.getValue(), false);
			else screen.keyPressed(new KeyEvent(Keys.code("enter"), 0, 0));
		}
	}

	private static void open(Minecraft client, JsonObject body) {
		String which = Json.string(body, "screen", "");
		if (client.player == null) throw new IllegalStateException("not in a world");
		if ("inventory".equals(which)) {
			client.setScreen(new InventoryScreen(client.player));
			return;
		}
		if ("chat".equals(which)) {
			client.setScreen(new ChatScreen(Json.string(body, "text", ""), false));
			return;
		}
		throw new IllegalArgumentException("screen must be inventory or chat");
	}

	private static String chatText(Screen screen) {
		for (AbstractWidget widget : clickable(screen)) if (widget instanceof EditBox field) return field.getValue();
		return "";
	}

	static List<String> suggestions(String text) {
		return CommandOps.suggestions(text);
	}

	static Map<String, Object> item(ItemStack stack) {
		if (stack == null || stack.isEmpty()) return null;
		return Json.map("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(), "count", stack.getCount(), "components", stack.getComponents().toString());
	}
}
