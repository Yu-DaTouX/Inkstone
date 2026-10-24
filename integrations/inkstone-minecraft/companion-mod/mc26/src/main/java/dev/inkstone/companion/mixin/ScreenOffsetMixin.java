package dev.inkstone.companion.mixin;

import dev.inkstone.companion.ScreenOffset;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(AbstractContainerScreen.class)
public interface ScreenOffsetMixin extends ScreenOffset {
	@Override
	@Accessor("leftPos")
	int inkstoneScreenX();

	@Override
	@Accessor("topPos")
	int inkstoneScreenY();
}
