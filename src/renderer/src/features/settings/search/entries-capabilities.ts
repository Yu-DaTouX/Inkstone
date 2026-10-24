import type { SettingsSearchEntry } from './search-model'

export const CAPABILITIES_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  {
    id: 'caps-skills',
    section: 'capabilities',
    tab: 'skills',
    zh: '技能',
    en: 'Skills',
    keywords: ['skill', '停用技能', '启用技能', '删除技能', '打开文件夹', 'enable skill', 'disable skill', '保留到我的技能']
  },
  {
    id: 'caps-extensions',
    section: 'capabilities',
    tab: 'skills',
    zh: '已安装的扩展',
    en: 'Installed extensions',
    keywords: ['扩展', 'extension', 'pi 包', 'package', '更新扩展', '移除扩展', 'uninstall']
  },
  {
    id: 'caps-prompts',
    section: 'capabilities',
    tab: 'skills',
    zh: '提示词模板',
    en: 'Prompt templates',
    keywords: ['prompt', '新建模板', '模板目录', '.pi/prompts', 'new template', 'template folder', '斜杠命令', 'slash command', '隐藏于菜单'],
    more: true
  },
  {
    id: 'caps-mcp-servers',
    section: 'capabilities',
    tab: 'mcp',
    zh: 'MCP 服务',
    en: 'MCP servers',
    keywords: ['mcp', 'pi 原生 MCP', 'mcp.json', '停用 MCP', '启用 MCP', '删除 MCP', '登录', '退出', '重连', 'login', 'logout', 'reconnect']
  },
  {
    id: 'caps-mcp-computer-use',
    section: 'capabilities',
    tab: 'mcp',
    zh: '电脑操作 · windows-mcp',
    en: 'Computer use · windows-mcp',
    keywords: ['windows-mcp', '砚直连', 'Inkstone direct', '检查', 'check', 'verify']
  },
  {
    id: 'caps-mcp-codegraph',
    section: 'capabilities',
    tab: 'mcp',
    zh: 'CodeGraph',
    en: 'CodeGraph',
    keywords: ['codegraph', '代码索引', '建立索引', 'index', '加入 pi MCP']
  },
  {
    id: 'caps-mcp-native-status',
    section: 'capabilities',
    tab: 'mcp',
    zh: '查看原生服务器状态',
    en: 'View native server status',
    keywords: ['/mcp', 'MCP 状态', 'mcp status', '连接状态']
  },
  {
    id: 'caps-mcp-legacy',
    section: 'capabilities',
    tab: 'mcp',
    zh: '砚连接的旧服务',
    en: 'Legacy Inkstone servers',
    keywords: ['导入到 pi', 'import to pi', '迁移', 'migration'],
    more: true
  },
  {
    id: 'caps-mcp-ownership',
    section: 'capabilities',
    tab: 'mcp',
    zh: '归属与迁移',
    en: 'Ownership & migration',
    keywords: ['切换到 pi', '切换到砚', 'switch', 'ownership'],
    more: true
  },
  {
    id: 'caps-mcp-app-snapshot',
    section: 'capabilities',
    tab: 'mcp',
    zh: 'App 工具快照',
    en: 'App tool snapshot',
    keywords: ['刷新工具快照', 'MCP App', 'tool snapshot', 'schema'],
    more: true
  },
  {
    id: 'caps-tools-computer-use',
    section: 'capabilities',
    tab: 'tools',
    zh: '电脑操作',
    en: 'Computer use',
    keywords: ['computer use', 'windows-mcp', '屏幕', '点击', 'uv', '安装 uv']
  },
  {
    id: 'caps-tools-opencli',
    section: 'capabilities',
    tab: 'tools',
    zh: '本机状态 · OpenCLI',
    en: 'Local status · OpenCLI',
    keywords: ['opencli', '搜索', 'search', '浏览器', 'Chrome 扩展', 'Node', '安装 OpenCLI', '重新检测']
  },
  {
    id: 'caps-tools-voice',
    section: 'capabilities',
    tab: 'tools',
    zh: '本地转写',
    en: 'Local transcription',
    keywords: ['语音', 'voice', '语音输入', '听写', 'whisper', 'transcription']
  },
  {
    id: 'caps-tools-voice-language',
    section: 'capabilities',
    tab: 'tools',
    zh: '识别语言',
    en: 'Language',
    keywords: ['语音语言', 'voice language', '转写语言', '中文', '英文']
  },
  {
    id: 'caps-tools-search-keys',
    section: 'capabilities',
    tab: 'tools',
    zh: '增强搜索',
    en: 'Enhanced search',
    keywords: ['API Key', 'Tavily', 'Brave', 'Firecrawl', 'Context7', '搜索 Key', '获取 Key', '清除 Key'],
    more: true
  },
  {
    id: 'caps-tools-git',
    section: 'capabilities',
    tab: 'tools',
    zh: '命令行工具',
    en: 'Command-line tools',
    keywords: ['git', 'bash', '安装 Git', 'install git', '重装 Git', '移除 Git'],
    more: true
  },
  {
    id: 'caps-tools-voice-setup',
    section: 'capabilities',
    tab: 'tools',
    zh: '转写程序与模型',
    en: 'Program & models',
    keywords: ['转写程序', '语音模型', '下载模型', 'whisper', 'model', 'download', '选择模型文件'],
    more: true
  },
  {
    id: 'caps-market-inkstone',
    section: 'capabilities',
    tab: 'market',
    zh: '砚插件',
    en: 'Inkstone plugins',
    keywords: ['Hermes', 'CodeGraph', '加入 pi MCP', '插件市场', 'market', 'plugin']
  },
  {
    id: 'caps-market-pi',
    section: 'capabilities',
    tab: 'market',
    zh: 'pi 插件',
    en: 'pi plugins',
    keywords: ['搜索插件', 'npm', 'pi.dev', '浏览目录', 'package search']
  },
  {
    id: 'caps-market-install',
    section: 'capabilities',
    tab: 'market',
    zh: '安装插件',
    en: 'Install a package',
    keywords: ['安装扩展', 'install', '安装源', '仅本项目', 'npm:']
  }
]
