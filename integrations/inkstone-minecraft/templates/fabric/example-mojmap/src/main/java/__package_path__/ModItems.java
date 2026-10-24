package {{packageName}};

import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.Item;

public final class ModItems {
	public static final Item EXAMPLE_ITEM = register("example_item", new Item(new Item.Properties()));

	private ModItems() {
	}

	private static Item register(String path, Item item) {
		return Registry.register(BuiltInRegistries.ITEM, ResourceLocation.fromNamespaceAndPath({{modClass}}.MOD_ID, path), item);
	}

	public static void register() {
	}
}
