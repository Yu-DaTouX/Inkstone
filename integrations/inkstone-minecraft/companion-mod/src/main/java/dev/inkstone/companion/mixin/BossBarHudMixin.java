package dev.inkstone.companion.mixin;

import dev.inkstone.companion.BossBarCount;
import java.util.Map;
import java.util.UUID;
import net.minecraft.client.gui.hud.BossBarHud;
import net.minecraft.entity.boss.BossBar;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;

@Mixin(BossBarHud.class)
abstract class BossBarHudMixin implements BossBarCount {
	@Shadow
	@Final
	Map<UUID, BossBar> bossBars;

	@Override
	public int inkstoneBossBarCount() {
		return this.bossBars.size();
	}
}
