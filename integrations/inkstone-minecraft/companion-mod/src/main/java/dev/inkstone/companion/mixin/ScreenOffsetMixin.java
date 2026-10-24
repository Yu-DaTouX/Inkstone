package dev.inkstone.companion.mixin;

import dev.inkstone.companion.ScreenOffset;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(HandledScreen.class)
public interface ScreenOffsetMixin extends ScreenOffset {
	@Override
	@Accessor("x")
	int inkstoneScreenX();

	@Override
	@Accessor("y")
	int inkstoneScreenY();
}
