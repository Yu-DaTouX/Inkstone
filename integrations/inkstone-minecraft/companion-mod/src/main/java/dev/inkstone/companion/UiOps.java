package dev.inkstone.companion;

import com.google.gson.JsonObject;
import dev.inkstone.companion.core.Companion;
import dev.inkstone.companion.core.Hover;
import dev.inkstone.companion.core.Json;
import dev.inkstone.companion.core.Keys;
import dev.inkstone.companion.core.Ui;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.Element;
import net.minecraft.client.gui.screen.ChatScreen;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.gui.widget.CheckboxWidget;
import net.minecraft.client.gui.widget.ClickableWidget;
import net.minecraft.client.gui.widget.SliderWidget;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.client.network.PlayerListEntry;
import net.minecraft.command.CommandSource;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.tooltip.TooltipType;
import net.minecraft.text.Text;
import net.minecraft.registry.Registries;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.Slot;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.integrated.IntegratedServer;
import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.suggestion.Suggestion;
import com.mojang.brigadier.suggestion.Suggestions;

final class UiOps {
	private UiOps() {
	}

	static Map<String, Object> read() {
		MinecraftClient client = MinecraftClient.getInstance();
		Screen screen = client.currentScreen;
		if (screen == null) return Json.map("screen", null);
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("class", screen.getClass().getSimpleName());
		result.put("title", screen.getTitle() == null ? "" : screen.getTitle().getString());
		ScreenHandler handler = handler(screen);
		result.put("kind", Ui.kind(screen.getClass().getSimpleName(), handler != null));
		result.put("guiScale", client.getWindow().getScaleFactor());
		double[] hover = Hover.point(screen);
		if (hover != null) result.put("hover", Json.map("x", hover[0], "y", hover[1]));
		if (handler != null) result.put("menu", handler.getClass().getSimpleName());
		result.put("slots", slots(client, screen, handler));
		result.put("widgets", widgets(screen));
		if (handler != null) result.put("carried", item(handler.getCursorStack()));
		if (screen instanceof ChatScreen) result.put("suggestions", suggestions(chatText(screen)));
		return Json.map("screen", result);
	}

	private static ScreenHandler handler(Screen screen) {
		if (screen instanceof HandledScreen<?> handled) return handled.getScreenHandler();
		return null;
	}

	private static List<Object> slots(MinecraftClient client, Screen screen, ScreenHandler handler) {
		List<Object> slots = new ArrayList<>();
		if (handler == null || !(screen instanceof HandledScreen<?>)) return slots;
		int offsetX = ((ScreenOffset) screen).inkstoneScreenX();
		int offsetY = ((ScreenOffset) screen).inkstoneScreenY();
		for (int index = 0; index < handler.slots.size(); index++) {
			Slot slot = handler.slots.get(index);
			boolean player = client.player != null && slot.inventory == client.player.getInventory();
			slots.add(Json.map("index", index, "x", offsetX + slot.x, "y", offsetY + slot.y, "cx", offsetX + slot.x + 8, "cy", offsetY + slot.y + 8, "container", player ? "player" : "menu", "role", player ? playerRole(slot.getIndex()) : "menu", "item", item(slot.getStack())));
		}
		return slots;
	}

	private static String playerRole(int containerSlot) {
		if (containerSlot >= 0 && containerSlot < 9) return "hotbar";
		if (containerSlot >= 9 && containerSlot < 36) return "inventory";
		if (containerSlot >= 36 && containerSlot < 40) return "armor";
		if (containerSlot == 40) return "offhand";
		return "other";
	}

	private static List<ClickableWidget> clickable(Screen screen) {
		List<ClickableWidget> widgets = new ArrayList<>();
		for (Element element : screen.children()) {
			if (element instanceof ClickableWidget widget && widget.visible) widgets.add(widget);
		}
		return widgets;
	}

	private static List<Object> widgets(Screen screen) {
		List<Object> widgets = new ArrayList<>();
		List<ClickableWidget> clickable = clickable(screen);
		for (int index = 0; index < clickable.size(); index++) {
			ClickableWidget widget = clickable.get(index);
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("id", index);
			entry.put("type", type(widget));
			entry.put("label", widget.getMessage() == null ? "" : widget.getMessage().getString());
			if (widget instanceof TextFieldWidget field) entry.put("value", field.getText());
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

	private static String type(ClickableWidget widget) {
		if (widget instanceof TextFieldWidget) return "edit";
		if (widget instanceof CheckboxWidget) return "checkbox";
		if (widget instanceof SliderWidget) return "slider";
		if (widget instanceof ButtonWidget) return "button";
		return "other";
	}

	static Map<String, Object> action(JsonObject body) {
		MinecraftClient client = MinecraftClient.getInstance();
		Screen screen = client.currentScreen;
		String action = Json.string(body, "action", "");
		if ("open".equals(action)) {
			open(client, body);
			return read();
		}
		if (screen == null) throw new IllegalArgumentException("no screen is open");
		if ("hover".equals(action)) return hover(client, screen, body);
		Hover.clear();
		switch (action) {
			case "click" -> click(client, screen, body);
			case "type" -> type(client, screen, body);
			case "key" -> {
				String key = Json.string(body, "key", "");
				if (key.isBlank()) throw new IllegalArgumentException("key is empty");
				screen.keyPressed(Keys.code(key), 0, 0);
			}
			case "close" -> screen.close();
			default -> throw new IllegalArgumentException("unknown action " + action);
		}
		return read();
	}

	private static void click(MinecraftClient client, Screen screen, JsonObject body) {
		int button = Ui.button(Json.string(body, "button", "left"));
		boolean shift = Json.bool(body, "shift", false);
		Integer slotIndex = body.has("slot") ? Json.integer(body, "slot", 0) : null;
		Integer widgetIndex = body.has("widget") ? Json.integer(body, "widget", 0) : null;
		if (slotIndex != null) {
			ScreenHandler handler = handler(screen);
			if (handler == null) throw new IllegalArgumentException("this screen has no slots");
			if (client.interactionManager == null || client.player == null) throw new IllegalStateException("not in a world");
			SlotActionType actionType = shift ? SlotActionType.QUICK_MOVE : SlotActionType.PICKUP;
			client.interactionManager.clickSlot(handler.syncId, slotIndex, button, actionType, client.player);
			return;
		}
		if (widgetIndex != null) {
			List<ClickableWidget> clickable = clickable(screen);
			if (widgetIndex < 0 || widgetIndex >= clickable.size()) throw new IllegalArgumentException("widget " + widgetIndex + " does not exist (found " + clickable.size() + ")");
			ClickableWidget widget = clickable.get(widgetIndex);
			double x = widget.getX() + widget.getWidth() / 2.0;
			double y = widget.getY() + widget.getHeight() / 2.0;
			if (widget.mouseClicked(x, y, button)) widget.mouseReleased(x, y, button);
			return;
		}
		if (body.has("x") && body.has("y")) {
			double x = Json.number(body, "x", 0);
			double y = Json.number(body, "y", 0);
			screen.mouseClicked(x, y, button);
			screen.mouseReleased(x, y, button);
			return;
		}
		throw new IllegalArgumentException("click needs slot, widget or x+y");
	}

	private static void type(MinecraftClient client, Screen screen, JsonObject body) {
		String text = Json.string(body, "text", "");
		boolean replace = Json.bool(body, "replace", false);
		boolean submit = Json.bool(body, "submit", false);
		Integer widgetIndex = body.has("widget") ? Json.integer(body, "widget", 0) : null;
		TextFieldWidget field = null;
		if (widgetIndex != null) {
			List<ClickableWidget> clickable = clickable(screen);
			if (widgetIndex < 0 || widgetIndex >= clickable.size()) throw new IllegalArgumentException("widget " + widgetIndex + " does not exist (found " + clickable.size() + ")");
			if (clickable.get(widgetIndex) instanceof TextFieldWidget candidate) field = candidate;
			if (field == null) throw new IllegalArgumentException("widget " + widgetIndex + " is not a text field");
		} else {
			for (ClickableWidget widget : clickable(screen)) {
				if (widget instanceof TextFieldWidget candidate && candidate.isFocused()) {
					field = candidate;
					break;
				}
			}
			if (field == null) throw new IllegalArgumentException("no focused text field; pass widget");
		}
		field.setFocused(true);
		if (replace) field.setText("");
		field.write(text);
		if (submit) {
			if (screen instanceof ChatScreen chat) chat.sendMessage(field.getText(), false);
			else screen.keyPressed(Keys.code("enter"), 0, 0);
		}
	}

	private static Map<String, Object> hover(MinecraftClient client, Screen screen, JsonObject body) {
		ItemStack stack = null;
		if (body.has("slot")) {
			ScreenHandler handler = handler(screen);
			if (handler == null || !(screen instanceof ScreenOffset offset)) throw new IllegalArgumentException("this screen has no slots");
			int index = Json.integer(body, "slot", 0);
			if (index < 0 || index >= handler.slots.size()) throw new IllegalArgumentException("slot " + index + " does not exist (found " + handler.slots.size() + ")");
			Slot slot = handler.slots.get(index);
			Hover.set(offset.inkstoneScreenX() + slot.x + 8, offset.inkstoneScreenY() + slot.y + 8, screen);
			stack = slot.getStack();
		} else if (body.has("x") && body.has("y")) {
			Hover.set(Json.number(body, "x", 0), Json.number(body, "y", 0), screen);
		} else throw new IllegalArgumentException("hover needs slot or x+y");
		Map<String, Object> result = read();
		if (stack != null && !stack.isEmpty()) result.put("tooltip", tooltip(client, stack));
		return result;
	}

	private static List<String> tooltip(MinecraftClient client, ItemStack stack) {
		List<String> lines = new ArrayList<>();
		Item.TooltipContext context = client.world == null ? Item.TooltipContext.DEFAULT : Item.TooltipContext.create(client.world);
		for (Text line : stack.getTooltip(context, client.player, TooltipType.BASIC)) lines.add(line.getString());
		return lines;
	}

	private static void open(MinecraftClient client, JsonObject body) {
		String which = Json.string(body, "screen", "");
		if (client.player == null) throw new IllegalStateException("not in a world");
		if ("inventory".equals(which)) {
			client.setScreen(new InventoryScreen(client.player));
			return;
		}
		if ("chat".equals(which)) {
			String text = Json.string(body, "text", "");
			client.setScreen(new ChatScreen(text));
			return;
		}
		throw new IllegalArgumentException("screen must be inventory or chat");
	}

	private static String chatText(Screen screen) {
		for (ClickableWidget widget : clickable(screen)) if (widget instanceof TextFieldWidget field) return field.getText();
		return "";
	}

	static List<String> suggestions(String text) {
		List<String> values = new ArrayList<>();
		MinecraftClient client = MinecraftClient.getInstance();
		String raw = text == null ? "" : text;
		if (raw.startsWith("/")) {
			IntegratedServer server = client.getServer();
			if (server == null) return values;
			com.mojang.brigadier.CommandDispatcher<ServerCommandSource> dispatcher = server.getCommandManager().getDispatcher();
			try {
				ParseResults<ServerCommandSource> parsed = dispatcher.parse(raw.substring(1), server.getCommandSource());
				CompletableFuture<Suggestions> future = dispatcher.getCompletionSuggestions(parsed, raw.length() - 1);
				for (Suggestion suggestion : future.get(3, TimeUnit.SECONDS).getList()) values.add(suggestion.getText());
			} catch (Exception error) {
				Companion.log("suggestions failed: " + error);
			}
			return values;
		}
		if (client.getNetworkHandler() != null) {
			for (PlayerListEntry entry : client.getNetworkHandler().getPlayerList()) {
				String name = entry.getProfile().getName();
				if (name != null && name.toLowerCase(Locale.ROOT).startsWith(raw.toLowerCase(Locale.ROOT))) values.add(name);
			}
		}
		return values;
	}

	static Map<String, Object> item(ItemStack stack) {
		if (stack == null || stack.isEmpty()) return null;
		return Json.map("id", Registries.ITEM.getId(stack.getItem()).toString(), "count", stack.getCount(), "components", stack.getComponents().toString());
	}
}
