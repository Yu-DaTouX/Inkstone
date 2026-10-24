package dev.inkstone.companion.mixin;

import dev.inkstone.companion.EntityFlags;
import net.minecraft.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(Entity.class)
public abstract class EntityFlagMixin implements EntityFlags {
	@Invoker("setFlag")
	protected abstract void inkstoneSetFlag(int index, boolean value);

	@Override
	public void inkstoneSetGlowing(boolean glowing) {
		inkstoneSetFlag(6, glowing);
	}
}
