package dev.inkstone.companion.mixin;

import dev.inkstone.companion.BossBarCount;
import java.util.Map;
import java.util.UUID;
import net.minecraft.client.gui.components.BossHealthOverlay;
import net.minecraft.client.gui.components.LerpingBossEvent;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;

@Mixin(BossHealthOverlay.class)
abstract class BossHealthOverlayMixin implements BossBarCount {
	@Shadow
	@Final
	Map<UUID, LerpingBossEvent> events;

	@Override
	public int inkstoneBossBarCount() {
		return this.events.size();
	}
}
