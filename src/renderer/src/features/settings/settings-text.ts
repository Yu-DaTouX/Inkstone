import type { Lang } from '../../i18n'

export interface SettingsText {
  title: string
  navLabel: string
  searchLabel: string
  searchPlaceholder: string
  searchEmpty: string
  searchResults: string
  searchMore: string
  searchIn: string
  sectionAppearance: string
  sectionSession: string
  sectionNotifications: string
  sectionModels: string
  sectionCapabilities: string
  sectionSecurity: string
  sectionDevices: string
  sectionData: string
  sectionUsage: string
  sectionShortcuts: string
  sectionAbout: string
  groupGeneral: string
  groupCustomize: string
  groupLocal: string
  navSkills: string
  navMcp: string
  navTools: string
  navMarket: string
  close: string
  onboardingTitle: string
  onboardingDesc: string
  onboardingAction: string
  loading: string
  notReady: string
  groupAppearanceLook: string
  groupAppearanceFonts: string
  groupAppearanceMotion: string
  groupAppearanceInput: string
  groupSessionContext: string
  groupSessionGeneral: string
  groupSessionRetry: string
  groupSessionSubagents: string
  groupNotifSound: string
  groupNotifEvents: string
  groupSecurityPermissions: string
  groupSecurityProjects: string
  groupDevicesAccess: string
  groupDataBackup: string
  groupDataStorage: string
  groupDataSync: string
  groupDataShare: string
  groupUsageOverview: string
  groupUsageBreakdown: string
  groupUsageCurrency: string
  groupShortcutsApp: string
  groupAboutApp: string
  groupAboutMore: string
  groupModelsIntegrations: string

  theme: string
  themeLight: string
  themeDark: string
  density: string
  densityDesc: string
  densityCompact: string
  densityComfortable: string
  reduceMotion: string
  reduceMotionDesc: string
  fontRead: string
  fontReadDesc: string
  fontCode: string
  fontCodeDesc: string
  fontDefault: string
  fontSans: string
  fontSerif: string
  fontMaple: string
  fontMono: string
  fontCustom: string
  fontCustomPlaceholder: string
  fontInvalid: string
  sound: string
  asciiBackground: string
  asciiBackgroundDesc: string
  workspaceTiles: string
  workspaceTilesDesc: string
  smoothText: string
  smoothTextDesc: string
  language: string

  contextAutoCompact: string
  contextCompactAt: string
  contextCompactAtNow: string
  contextCompactAtClamped: string
  contextProjectIgnored: string
  contextCappedByInkstone: string
  contextNoteJoin: string
  contextTrim: string
  contextTrimDesc: string
  contextTrimAt: string
  contextCompactNow: string
  contextUsed: string
  contextWindowLabel: string
  contextUnknown: string


  missingTitle: string
  missingBody: string
  unmigratedTitle: string
  unmigratedBody: string
  unknownTitle: string
  unknownBody: string
  backToAppearance: string
  backToChat: string

  usageNote: string
  rangeAll: string
  range30: string
  range7: string
  usageSessions: string
  usageMessages: string
  usageTokens: string
  usageTokensBreakdown: string
  usageTokensHint: string
  usageActiveDays: string
  usagePeakHour: string
  usagePeakNone: string
  usageModels: string
  usageModelColumn: string
  usageTokensColumn: string
  usageShareColumn: string
  usageCost: string
  usageCostColumn: string
  usageCurrency: string
  usageCurrencyDesc: string
  usageRate: string
  usageRateDesc: string
  usageNoModels: string
  usageEmpty: string
  usageLoading: string
  usageError: string
  usageRetry: string
  usageView: string
  usageChart: string
  usageTable: string
  usageDimension: string
  usageByDay: string
  usageByModel: string
  usageDayColumn: string
  usageNoDays: string
  usageDailyCap: string

  shortcutColumnAction: string
  shortcutColumnKeys: string
  shortcutColumnState: string
  shortcutFixed: string
  shortcutRebindable: string
  shortcutConflictNone: string
  shortcutConflictFound: string
}

const ZH: SettingsText = {
  title: '设置',
  navLabel: '设置分区',
  searchLabel: '搜索设置',
  searchPlaceholder: '搜索',
  searchEmpty: '没有匹配的设置',
  searchResults: '设置搜索结果',
  searchMore: '另有 {count} 项',
  searchIn: '{label}，在{section}',
  sectionAppearance: '外观与语言',
  sectionSession: '会话与上下文',
  sectionNotifications: '通知',
  sectionModels: '模型',
  sectionCapabilities: '能力',
  sectionSecurity: '权限与安全',
  sectionDevices: '手机与远程',
  sectionData: '数据与同步',
  sectionUsage: '用量',
  sectionShortcuts: '快捷键',
  sectionAbout: '关于',
  groupGeneral: '设置',
  groupCustomize: '自定义',
  groupLocal: '此电脑',
  navSkills: '技能与扩展',
  navMcp: 'MCP',
  navTools: '本机工具',
  navMarket: '插件市场',
  close: '关闭设置',
  onboardingTitle: '首次引导',
  onboardingDesc: '重新查看首次引导，不会重置设置。',
  onboardingAction: '重新查看引导',
  loading: '正在读取设置…',
  notReady: '设置还没就绪，稍后重试。',
  groupAppearanceLook: '外观',
  groupAppearanceFonts: '字体',
  groupAppearanceMotion: '动效与背景',
  groupAppearanceInput: '语言与输入',
  groupSessionContext: '上下文',
  groupSessionGeneral: '会话',
  groupSessionRetry: '出错与重试',
  groupSessionSubagents: '子 Agent',
  groupNotifSound: '声音与系统通知',
  groupNotifEvents: '提醒事件',
  groupSecurityPermissions: '权限',
  groupSecurityProjects: '项目',
  groupDevicesAccess: '远程连接',
  groupDataBackup: '备份',
  groupDataStorage: '存储位置',
  groupDataSync: '同步',
  groupDataShare: '分享',
  groupUsageOverview: '概览',
  groupUsageBreakdown: '明细',
  groupUsageCurrency: '货币',
  groupShortcutsApp: '应用快捷键',
  groupAboutApp: '版本与更新',
  groupAboutMore: '运行环境与帮助',
  groupModelsIntegrations: '其他接入',

  theme: '主题',
  themeLight: '浅色',
  themeDark: '深色',
  density: '字号与密度',
  densityDesc: '紧凑：界面 13px、正文 14px；舒适：界面 14px、正文 16px，控件与行距更大。',
  densityCompact: '紧凑',
  densityComfortable: '舒适',
  reduceMotion: '减少动效',
  reduceMotionDesc: '关闭过渡与动画。系统开启了减少动画时始终生效。',
  fontRead: '阅读字体',
  fontReadDesc: '界面与正文使用的字体。',
  fontCode: '代码字体',
  fontCodeDesc: '代码与终端里使用的字体。',
  fontDefault: '默认',
  fontSans: '系统无衬线',
  fontSerif: '衬线',
  fontMaple: 'Maple Mono',
  fontMono: '系统等宽',
  fontCustom: '自定义',
  fontCustomPlaceholder: '输入本机已安装的字体名',
  fontInvalid: '字体名只能包含文字、数字、空格、点、连字符与下划线',
  sound: '声音提示',
  asciiBackground: '动态背景',
  asciiBackgroundDesc: '新会话空态显示缓慢流动的字符背景。',
  workspaceTiles: '工具磁贴',
  workspaceTilesDesc: '在消息旁显示状态磁贴。',
  smoothText: '柔和字体渲染',
  smoothTextDesc: '用灰度抗锯齿显示文字，去掉彩色边缘。重启后生效。',
  language: '语言',

  contextAutoCompact: '自动压缩',
  contextCompactAt: '自动压缩上限',
  contextCompactAtNow: '到 {n} 触发。',
  contextCompactAtClamped: '模型窗口较小，实际在 {e} 触发（设置为 {n}）。',
  contextProjectIgnored: '本项目 .pi/settings.json 里的压缩设置未生效：该项目尚未受信任，pi 使用全局设置。',
  contextCappedByInkstone: '自动压缩上限低于 pi 自身阈值，将在 {n} 提前压缩。',
  contextNoteJoin: '',
  contextTrim: '裁剪较早的大段工具输出',
  contextTrimDesc: '发给模型前省略较早的大段工具输出。',
  contextTrimAt: '裁剪起点',
  contextCompactNow: '立即压缩',
  contextUsed: '已用',
  contextWindowLabel: '窗口',
  contextUnknown: '未知',


  missingTitle: '这一页暂不可用',
  missingBody: '这一页在当前版本里暂不可用。',
  unmigratedTitle: '这一页暂未提供',
  unmigratedBody: '“{view}”暂未在当前界面提供。',
  unknownTitle: '没有这个设置页',
  unknownBody: '“{view}”不是已知的设置页，可以返回外观。',
  backToAppearance: '返回外观',
  backToChat: '返回会话',

  usageNote: '来自本机会话文件；费用按模型报价（美元）换算。',
  rangeAll: '全部',
  range30: '近 30 天',
  range7: '近 7 天',
  usageSessions: '会话',
  usageMessages: '消息',
  usageTokens: 'Token',
  usageTokensBreakdown: '主会话 {main} · 子 Agent {subagents}',
  usageTokensHint: 'Token 含子 Agent 与缓存；其余只计主会话。',
  usageActiveDays: '活跃天数',
  usagePeakHour: '高峰时段',
  usagePeakNone: '暂无',
  usageModels: '模型用量',
  usageModelColumn: '模型',
  usageTokensColumn: 'Token',
  usageShareColumn: '占比',
  usageCost: '费用',
  usageCostColumn: '费用',
  usageCurrency: '显示货币',
  usageCurrencyDesc: '费用以美元记录，此处只改显示；1 原石 = 0.1 元。',
  usageRate: '1 USD = ? {code}',
  usageRateDesc: '默认 {default}；当前 $1 显示为 {sample}。',
  usageNoModels: '这段时间没有模型用量。',
  usageEmpty: '这段时间还没有用量记录。',
  usageLoading: '正在统计本机用量…',
  usageError: '用量统计读取失败。',
  usageRetry: '重试',
  usageView: '视图',
  usageChart: '图表',
  usageTable: '表格',
  usageDimension: '分组',
  usageByDay: '按日',
  usageByModel: '按模型',
  usageDayColumn: '日期',
  usageNoDays: '这段时间没有按日记录。',
  usageDailyCap: '按日图表与表格仅展示最近 30 天。',

  shortcutColumnAction: '作用',
  shortcutColumnKeys: '快捷键',
  shortcutColumnState: '改键',
  shortcutFixed: '只读',
  shortcutRebindable: '可改',
  shortcutConflictNone: '注册表内没有重复键位。',
  shortcutConflictFound: '检测到重复键位：{list}'
}

const EN: SettingsText = {
  title: 'Settings',
  navLabel: 'Settings sections',
  searchLabel: 'Search settings',
  searchPlaceholder: 'Search',
  searchEmpty: 'No matching settings',
  searchResults: 'Settings search results',
  searchMore: '{count} more',
  searchIn: '{label} in {section}',
  sectionAppearance: 'Appearance & language',
  sectionSession: 'Sessions & context',
  sectionNotifications: 'Notifications',
  sectionModels: 'Models',
  sectionCapabilities: 'Capabilities',
  sectionSecurity: 'Permissions & security',
  sectionDevices: 'Phone & remote',
  sectionData: 'Data & sync',
  sectionUsage: 'Usage',
  sectionShortcuts: 'Keyboard shortcuts',
  sectionAbout: 'About',
  groupGeneral: 'Settings',
  groupCustomize: 'Customize',
  groupLocal: 'This computer',
  navSkills: 'Skills & extensions',
  navMcp: 'MCP',
  navTools: 'Local tools',
  navMarket: 'Plugin market',
  close: 'Close settings',
  onboardingTitle: 'First-run setup',
  onboardingDesc: 'Replay first-run setup; settings are kept.',
  onboardingAction: 'Replay setup',
  loading: 'Loading settings…',
  notReady: 'Settings are not ready yet. Try again shortly.',
  groupAppearanceLook: 'Appearance',
  groupAppearanceFonts: 'Fonts',
  groupAppearanceMotion: 'Motion & background',
  groupAppearanceInput: 'Language & input',
  groupSessionContext: 'Context',
  groupSessionGeneral: 'Sessions',
  groupSessionRetry: 'Errors & retries',
  groupSessionSubagents: 'Subagents',
  groupNotifSound: 'Sound & system notifications',
  groupNotifEvents: 'Events',
  groupSecurityPermissions: 'Permissions',
  groupSecurityProjects: 'Projects',
  groupDevicesAccess: 'Remote access',
  groupDataBackup: 'Backup',
  groupDataStorage: 'Storage',
  groupDataSync: 'Sync',
  groupDataShare: 'Sharing',
  groupUsageOverview: 'Overview',
  groupUsageBreakdown: 'Breakdown',
  groupUsageCurrency: 'Currency',
  groupShortcutsApp: 'App shortcuts',
  groupAboutApp: 'Version & updates',
  groupAboutMore: 'Runtime & help',
  groupModelsIntegrations: 'Other integrations',

  theme: 'Theme',
  themeLight: 'Light',
  themeDark: 'Dark',
  density: 'Text size & density',
  densityDesc: 'Compact: 13px interface, 14px body. Comfortable: 14px interface, 16px body, taller controls and rows.',
  densityCompact: 'Compact',
  densityComfortable: 'Comfortable',
  reduceMotion: 'Reduce motion',
  reduceMotionDesc: 'Turn off transitions and animations. Always on when the system asks for reduced motion.',
  fontRead: 'Reading font',
  fontReadDesc: 'Font for the UI and body text.',
  fontCode: 'Code font',
  fontCodeDesc: 'Font used for code and the terminal.',
  fontDefault: 'Default',
  fontSans: 'System sans',
  fontSerif: 'Serif',
  fontMaple: 'Maple Mono',
  fontMono: 'System mono',
  fontCustom: 'Custom',
  fontCustomPlaceholder: 'Type an installed font name',
  fontInvalid: 'Font names may only contain letters, digits, spaces, dots, hyphens and underscores',
  sound: 'Sound',
  asciiBackground: 'Dynamic background',
  asciiBackgroundDesc: 'Drifting ASCII background on empty new sessions.',
  workspaceTiles: 'Tool tiles',
  workspaceTilesDesc: 'Show status tiles beside messages.',
  smoothText: 'Smooth text rendering',
  smoothTextDesc: 'Render text with grayscale antialiasing, without colored fringes. Takes effect after restart.',
  language: 'Language',

  contextAutoCompact: 'Auto-compaction',
  contextCompactAt: 'Auto-compaction limit',
  contextCompactAtNow: 'Triggers at {n}.',
  contextCompactAtClamped: 'The model window is small; it triggers at {e} (set to {n}).',
  contextProjectIgnored: 'Compaction settings in this project\'s .pi/settings.json are ignored because the project is not trusted; pi uses the global settings.',
  contextCappedByInkstone: 'The auto-compaction limit is below pi\'s own threshold, so compaction happens early at {n}.',
  contextNoteJoin: ' ',
  contextTrim: 'Trim older large tool output',
  contextTrimDesc: 'Omit older large tool output before sending to the model.',
  contextTrimAt: 'Trim threshold',
  contextCompactNow: 'Compact now',
  contextUsed: 'Used',
  contextWindowLabel: 'Window',
  contextUnknown: 'unknown',


  missingTitle: 'This page is not available yet',
  missingBody: 'This page is not available in the current version.',
  unmigratedTitle: 'This page is not available yet',
  unmigratedBody: '“{view}” is not available in the current interface yet.',
  unknownTitle: 'No such settings page',
  unknownBody: '“{view}” is not a known settings page. You can return to Appearance.',
  backToAppearance: 'Back to Appearance',
  backToChat: 'Back to chat',

  usageNote: 'From local session files; cost uses model prices (USD).',
  rangeAll: 'All',
  range30: 'Last 30 days',
  range7: 'Last 7 days',
  usageSessions: 'Sessions',
  usageMessages: 'Messages',
  usageTokens: 'Tokens',
  usageTokensBreakdown: 'Main {main} · Subagents {subagents}',
  usageTokensHint: 'Tokens include subagents and cache; the rest count main sessions only.',
  usageActiveDays: 'Active days',
  usagePeakHour: 'Peak hour',
  usagePeakNone: 'n/a',
  usageModels: 'Usage by model',
  usageModelColumn: 'Model',
  usageTokensColumn: 'Tokens',
  usageShareColumn: 'Share',
  usageCost: 'Cost',
  usageCostColumn: 'Cost',
  usageCurrency: 'Display currency',
  usageCurrencyDesc: 'Costs are stored in USD; this changes display only. 1 Primogem = ¥0.1.',
  usageRate: '1 USD = ? {code}',
  usageRateDesc: 'Default {default}; $1 currently shows as {sample}.',
  usageNoModels: 'No model usage in this range.',
  usageEmpty: 'No usage recorded in this range yet.',
  usageLoading: 'Crunching local usage…',
  usageError: 'Could not read usage statistics.',
  usageRetry: 'Retry',
  usageView: 'View',
  usageChart: 'Chart',
  usageTable: 'Table',
  usageDimension: 'Group by',
  usageByDay: 'By day',
  usageByModel: 'By model',
  usageDayColumn: 'Date',
  usageNoDays: 'No daily records in this range.',
  usageDailyCap: 'The daily chart and table show the most recent 30 days only.',

  shortcutColumnAction: 'Action',
  shortcutColumnKeys: 'Keys',
  shortcutColumnState: 'Rebind',
  shortcutFixed: 'Read-only',
  shortcutRebindable: 'Editable',
  shortcutConflictNone: 'No duplicate bindings in the registry.',
  shortcutConflictFound: 'Duplicate bindings: {list}'
}

export function settingsText(lang: Lang): SettingsText {
  return lang === 'en-US' ? EN : ZH
}
