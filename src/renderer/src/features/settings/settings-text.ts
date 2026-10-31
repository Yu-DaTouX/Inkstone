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
  sectionCode: string
  advanced: string
  groupGeneral: string
  groupAgents: string
  groupCode: string
  groupConnections: string
  groupMaintenance: string
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
  groupUsageBreakdown: string
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
  sidebarLayout: string
  sidebarLayoutDesc: string
  sidebarLayoutProjects: string
  sidebarLayoutFlat: string
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
  contextCompactNow: string
  contextUsed: string
  contextWindowLabel: string
  contextUnknown: string


  unknownTitle: string
  unknownBody: string
  revealFolded: string
  backToAppearance: string
  backToChat: string

  usageNote: string
  rangeAll: string
  range30: string
  range7: string
  usageSessions: string
  usageTokensHint: string
  usagePeakHour: string
  usagePeakNone: string
  usageCurrency: string
  usageCurrencyDesc: string
  usageRate: string
  usageRateDesc: string
  usageNoModels: string
  usageView: string
  usageDimension: string
  usageByDay: string
  usageByModel: string
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
  sectionAppearance: '外观',
  sectionSession: '会话',
  sectionNotifications: '通知',
  sectionModels: '模型',
  sectionCapabilities: '能力',
  sectionSecurity: '权限',
  sectionDevices: '手机与远程',
  sectionData: '数据与同步',
  sectionUsage: '用量',
  sectionShortcuts: '快捷键',
  sectionAbout: '关于',
  sectionCode: '源代码管理',
  advanced: '高级',
  groupGeneral: '通用',
  groupAgents: '智能体',
  groupCode: '代码',
  groupConnections: '连接',
  groupMaintenance: '维护',
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
  groupUsageBreakdown: '明细',
  groupShortcutsApp: '应用快捷键',
  groupAboutApp: '版本与更新',
  groupAboutMore: '运行环境与帮助',
  groupModelsIntegrations: '其他接入',

  theme: '主题',
  themeLight: '浅色',
  themeDark: '深色',
  density: '字号与密度',
  densityDesc: '紧凑 13px，舒适 14px，行距更大。',
  densityCompact: '紧凑',
  densityComfortable: '舒适',
  sidebarLayout: '左栏布局',
  sidebarLayoutDesc: '按项目分组，或按最近活动平铺。',
  sidebarLayoutProjects: '按项目',
  sidebarLayoutFlat: '平铺',
  reduceMotion: '减少动效',
  reduceMotionDesc: '关闭过渡与动画；系统已开启时始终生效。',
  fontRead: '阅读字体',
  fontReadDesc: '界面与正文字体。',
  fontCode: '代码字体',
  fontCodeDesc: '代码与终端字体。',
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
  asciiBackgroundDesc: '新会话空态显示缓慢流动的字符。',
  workspaceTiles: '工具磁贴',
  workspaceTilesDesc: '在消息旁显示状态磁贴。',
  smoothText: '柔和字体渲染',
  smoothTextDesc: '灰度抗锯齿，去掉彩色边缘；重启生效。',
  language: '语言',

  contextAutoCompact: '自动压缩',
  contextCompactAt: '自动压缩上限',
  contextCompactAtNow: '到 {n} 触发。',
  contextCompactAtClamped: '模型窗口较小，实际在 {e} 触发。',
  contextProjectIgnored: '项目 .pi/settings.json 的压缩设置未生效：项目未受信任。',
  contextCappedByInkstone: '低于 pi 自身阈值，将在 {n} 提前压缩。',
  contextNoteJoin: '',
  contextCompactNow: '立即压缩',
  contextUsed: '已用',
  contextWindowLabel: '窗口',
  contextUnknown: '未知',


  unknownTitle: '没有这个设置页',
  unknownBody: '没有“{view}”这个设置页。',
  revealFolded: '这一项在折叠区里，先打开高亮的开关。',
  backToAppearance: '返回外观',
  backToChat: '返回会话',

  usageNote: '来自本机会话文件；费用按模型报价（美元）换算。',
  rangeAll: '全部',
  range30: '近 30 天',
  range7: '近 7 天',
  usageSessions: '会话',
  usageTokensHint: 'Token 含子 Agent 与缓存。',
  usagePeakHour: '高峰时段',
  usagePeakNone: '暂无',
  usageCurrency: '显示货币',
  usageCurrencyDesc: '只改显示；1 原石 = 0.1 元。',
  usageRate: '1 USD = ? {code}',
  usageRateDesc: '默认 {default}；当前 $1 = {sample}。',
  usageNoModels: '这段时间没有模型用量。',
  usageView: '视图',
  usageDimension: '分组',
  usageByDay: '按日',
  usageByModel: '按模型',
  usageNoDays: '这段时间没有按日记录。',
  usageDailyCap: '按日明细仅展示最近 30 天。',

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
  sectionAppearance: 'Appearance',
  sectionSession: 'Sessions',
  sectionNotifications: 'Notifications',
  sectionModels: 'Models',
  sectionCapabilities: 'Capabilities',
  sectionSecurity: 'Permissions',
  sectionDevices: 'Phone & remote',
  sectionData: 'Data & sync',
  sectionUsage: 'Usage',
  sectionShortcuts: 'Shortcuts',
  sectionAbout: 'About',
  sectionCode: 'Source control',
  advanced: 'Advanced',
  groupGeneral: 'General',
  groupAgents: 'Agents',
  groupCode: 'Code',
  groupConnections: 'Connections',
  groupMaintenance: 'Maintenance',
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
  groupUsageBreakdown: 'Breakdown',
  groupShortcutsApp: 'App shortcuts',
  groupAboutApp: 'Version & updates',
  groupAboutMore: 'Runtime & help',
  groupModelsIntegrations: 'Other integrations',

  theme: 'Theme',
  themeLight: 'Light',
  themeDark: 'Dark',
  density: 'Text size & density',
  densityDesc: 'Compact 13px; comfortable 14px with more space.',
  densityCompact: 'Compact',
  densityComfortable: 'Comfortable',
  sidebarLayout: 'Sidebar layout',
  sidebarLayoutDesc: 'Group by project, or one flat recent list.',
  sidebarLayoutProjects: 'By project',
  sidebarLayoutFlat: 'Flat',
  reduceMotion: 'Reduce motion',
  reduceMotionDesc: 'Turn off transitions; always on if the OS asks.',
  fontRead: 'Reading font',
  fontReadDesc: 'Font for UI and text.',
  fontCode: 'Code font',
  fontCodeDesc: 'Font for code and terminal.',
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
  asciiBackgroundDesc: 'Slow drifting characters on the empty state.',
  workspaceTiles: 'Tool tiles',
  workspaceTilesDesc: 'Show status tiles beside messages.',
  smoothText: 'Smooth text rendering',
  smoothTextDesc: 'Grayscale antialiasing; restart to apply.',
  language: 'Language',

  contextAutoCompact: 'Auto-compaction',
  contextCompactAt: 'Auto-compaction limit',
  contextCompactAtNow: 'Triggers at {n}.',
  contextCompactAtClamped: 'Small model window; triggers at {e}.',
  contextProjectIgnored: 'Project .pi/settings.json compaction ignored: project is untrusted.',
  contextCappedByInkstone: 'Below pi’s own threshold; compacts early at {n}.',
  contextNoteJoin: ' ',
  contextCompactNow: 'Compact now',
  contextUsed: 'Used',
  contextWindowLabel: 'Window',
  contextUnknown: 'unknown',


  unknownTitle: 'No such settings page',
  unknownBody: 'There is no “{view}” settings page.',
  revealFolded: 'This option sits in a collapsed group — turn on the highlighted switch first.',
  backToAppearance: 'Back to Appearance',
  backToChat: 'Back to chat',

  usageNote: 'From local session files; cost uses model prices (USD).',
  rangeAll: 'All',
  range30: 'Last 30 days',
  range7: 'Last 7 days',
  usageSessions: 'Sessions',
  usageTokensHint: 'Tokens include subagents and cache.',
  usagePeakHour: 'Peak hour',
  usagePeakNone: 'n/a',
  usageCurrency: 'Display currency',
  usageCurrencyDesc: 'Display only; 1 原石 = ¥0.1.',
  usageRate: '1 USD = ? {code}',
  usageRateDesc: 'Default {default}; $1 = {sample}.',
  usageNoModels: 'No model usage in this range.',
  usageView: 'View',
  usageDimension: 'Group by',
  usageByDay: 'By day',
  usageByModel: 'By model',
  usageNoDays: 'No daily records in this range.',
  usageDailyCap: 'Daily breakdown shows the most recent 30 days only.',

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
