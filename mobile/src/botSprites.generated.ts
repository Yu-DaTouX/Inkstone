export const BOT_CELL = 84
export const BOT_COLUMNS = 48
export const BOT_ROW_COUNT = 6
export const BOT_ROWS = {"work":{"row":0,"frames":48,"fps":10},"ask":{"row":1,"frames":38,"fps":10},"wake":{"row":2,"frames":1,"fps":0},"done":{"row":3,"frames":1,"fps":0},"fail":{"row":4,"frames":1,"fps":0},"rest":{"row":5,"frames":1,"fps":0}} as const
export type BotSpriteMood = keyof typeof BOT_ROWS
export const BOT_SHEETS: Record<string, number> = {
  'claude-dark': require('./assets/bots/claude-dark.png'),
  'claude-light': require('./assets/bots/claude-light.png'),
  'codex-dark': require('./assets/bots/codex-dark.png'),
  'codex-light': require('./assets/bots/codex-light.png'),
  'deepseek-dark': require('./assets/bots/deepseek-dark.png'),
  'deepseek-light': require('./assets/bots/deepseek-light.png'),
  'qwen-dark': require('./assets/bots/qwen-dark.png'),
  'qwen-light': require('./assets/bots/qwen-light.png'),
  'gemini-dark': require('./assets/bots/gemini-dark.png'),
  'gemini-light': require('./assets/bots/gemini-light.png'),
  'kimi-dark': require('./assets/bots/kimi-dark.png'),
  'kimi-light': require('./assets/bots/kimi-light.png'),
  'glm-dark': require('./assets/bots/glm-dark.png'),
  'glm-light': require('./assets/bots/glm-light.png'),
  'grok-dark': require('./assets/bots/grok-dark.png'),
  'grok-light': require('./assets/bots/grok-light.png'),
  'pi-dark': require('./assets/bots/pi-dark.png'),
  'pi-light': require('./assets/bots/pi-light.png'),
}
