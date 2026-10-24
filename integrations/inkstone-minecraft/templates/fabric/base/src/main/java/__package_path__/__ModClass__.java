package {{packageName}};

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class {{modClass}} implements ModInitializer {
	public static final String MOD_ID = "{{modId}}";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitialize() {
{{exampleInit}}		LOGGER.info("{{modName}} initialized");
	}
}
