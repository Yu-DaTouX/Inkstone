package {{packageName}};

import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

public final class ModItems {
	public static final Item EXAMPLE_ITEM = register("example_item", new Item(new Item.Settings()));

	private ModItems() {
	}

	private static Item register(String path, Item item) {
		return Registry.register(Registries.ITEM, Identifier.of({{modClass}}.MOD_ID, path), item);
	}

	public static void register() {
	}
}
