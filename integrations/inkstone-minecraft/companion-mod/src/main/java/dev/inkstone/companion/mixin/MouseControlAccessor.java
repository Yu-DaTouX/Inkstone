package dev.inkstone.companion.mixin;

import net.minecraft.client.Mouse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(Mouse.class)
public interface MouseControlAccessor {
	@Accessor("cursorLocked")
	void inkstone$setGrabbed(boolean value);
}
