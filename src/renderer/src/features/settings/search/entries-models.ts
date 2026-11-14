import type { SettingsSearchEntry } from './search-model'

export const MODELS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  {
    id: 'models-subscriptions',
    section: 'models',
    zh: '登录与订阅',
    en: 'Sign in & subscriptions',
    keywords: ['登录', '订阅', 'OAuth', 'login', 'Codex', 'ChatGPT', 'Copilot', 'GitHub', '账号', 'account']
  },
  {
    id: 'models-api-keys',
    section: 'models',
    zh: 'API Key',
    en: 'API keys',
    keywords: ['密钥', 'key', 'token', '凭证', 'credential', 'OpenRouter', 'Anthropic', 'DeepSeek', 'xAI', '服务商', 'provider']
  },
  {
    id: 'models-image-generation',
    section: 'models',
    zh: '生图',
    en: 'Image generation',
    keywords: ['生图', '画图', '图像', '图片模型', 'key', '密钥', 'image', 'gpt-image', 'dall-e', 'seedream', 'gemini', '兼容接口']
  },
  {
    id: 'models-key-failover',
    section: 'models',
    zh: 'Key 失效时自动切换',
    en: 'Switch keys when one stops working',
    keywords: ['key', '密钥', '故障转移', 'failover', '额度', '余额']
  },
  {
    id: 'models-recheck',
    section: 'models',
    zh: '重新检测',
    en: 'Re-check',
    keywords: ['刷新', '重新读取', 'refresh', '凭证文件', 'auth.json', 'credentials file']
  },
  {
    id: 'models-custom',
    section: 'models',
    zh: '自定义服务',
    en: 'Custom services',
    keywords: ['自定义', 'Base URL', 'OpenAI 兼容', 'compatible', 'endpoint', '接口', '中转', 'custom provider'],
    more: true
  },
  {
    id: 'models-custom-detect',
    section: 'models',
    zh: '检测本地模型',
    en: 'Detect local models',
    keywords: ['本地', 'local', 'Ollama', 'LM Studio', 'ComfyUI'],
    more: true
  },
  {
    id: 'models-local-launch',
    section: 'models',
    zh: '本地模型',
    en: 'Local models',
    keywords: ['启动脚本', '启动命令', '自动启动', 'start script', 'launch', 'auto-start', 'bat', '改名', '重命名', '模型名称', 'rename', 'model name', '卸载', '停止命令', '显存', 'unload', 'stop command', 'local model']
  },
  {
    id: 'models-claude-code',
    section: 'models',
    zh: 'Claude Code 订阅',
    en: 'Claude Code subscription',
    keywords: ['pi-claude-bridge', 'bridge', '订阅插件', 'Claude', 'Max', 'Pro'],
    more: true
  },
  {
    id: 'models-thinking-levels',
    section: 'models',
    zh: '各模型默认思考档位',
    en: 'Default thinking level per model',
    keywords: ['思考', '推理', 'thinking', 'reasoning', 'effort', '档位'],
    more: true
  }
]
