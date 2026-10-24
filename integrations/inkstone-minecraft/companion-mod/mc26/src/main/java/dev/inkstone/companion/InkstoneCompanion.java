package dev.inkstone.companion;

import dev.inkstone.companion.core.Companion;
import net.fabricmc.api.ClientModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class InkstoneCompanion implements ClientModInitializer {
	public static final Logger LOGGER = LoggerFactory.getLogger("InkstoneCompanion");

	@Override
	public void onInitializeClient() {
		Companion.init(new Bridge(), message -> LOGGER.info("[InkstoneCompanion] {}", message));
	}
}
