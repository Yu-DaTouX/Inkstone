package dev.inkstone.companion.mixin;

import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(MouseHandler.class)
public interface MouseControlAccessor {
	@Accessor("mouseGrabbed")
	void inkstone$setGrabbed(boolean value);
}
