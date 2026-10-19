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
    id: 'models-claude-code',
    section: 'models',
    zh: 'Claude Code 订阅',
    en: 'Claude Code subscription',
    keywords: ['pi-claude-bridge', 'bridge', '订阅插件', 'Claude', 'Max', 'Pro'],
    more: true
  },
  {
    id: 'models-opencode-proxy',
    section: 'models',
    zh: 'OpenCode 反代',
    en: 'OpenCode proxy',
    keywords: ['OpenCode', '反向代理', 'proxy', '插件市场', 'market'],
    more: true
  },
  {
    id: 'models-thinking-levels',
    section: 'models',
    zh: '各模型默认思考档位',
    en: 'Default thinking level per model',
    keywords: ['思考', '推理', 'thinking', 'reasoning', 'effort', '档位'],
    more: true
  },
  {
    id: 'usage-range',
    section: 'usage',
    zh: '统计范围',
    en: 'Time range',
    keywords: ['全部', '近 30 天', '近 7 天', 'range', 'Token', '费用', 'cost', '统计']
  },
  {
    id: 'usage-breakdown',
    section: 'usage',
    zh: '分组与视图',
    en: 'Group by & view',
    keywords: ['按日', '按模型', '图表', '表格', 'by day', 'by model', 'chart', 'table']
  },
  {
    id: 'usage-currency',
    section: 'usage',
    zh: '显示货币',
    en: 'Display currency',
    keywords: ['货币', '汇率', 'exchange rate', 'currency', '人民币', 'CNY', 'USD', '原石'],
    more: true
  }
]
