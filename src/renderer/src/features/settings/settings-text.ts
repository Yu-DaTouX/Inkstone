/**
 * v3 设置自己的短文案。
 *
 * 放在 features/settings 下而不是 `app/v3-text.ts`：那是外壳与侧栏的共享文件
 * （R0 正在改 Shell/Header），也不写进两份共享 i18n JSON（热点、且 v3 未定稿）。
 * 键面只属于设置；等 v3 定稿后再统一并入 i18n。
 */
import type { Lang } from '../../i18n'

export interface SettingsText {
  title: string
  navLabel: string
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
  sectionSync: string
  onboardingTitle: string
  onboardingDesc: string
  onboardingAction: string
  loading: string
  notReady: string

  /* 外观 */
  appearanceNote: string
  theme: string
  themeLight: string
  themeDark: string
  density: string
  densityCompact: string
  densityStandard: string
  densityComfortable: string
  fontSizeUi: string
  fontSizeNow: string
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
  soundEnable: string
  soundEnableDesc: string
  soundVolume: string
  motion: string
  motionReduced: string
  motionFull: string
  motionNote: string
  asciiBackground: string
  asciiBackgroundDesc: string
  language: string

  /* 上下文 */
  sectionContext: string
  contextNote: string
  contextUnavailable: string
  contextAutoCompact: string
  contextCompactAt: string
  contextCompactAtNow: string
  contextCompactAtClamped: string
  contextTrim: string
  contextTrimDesc: string
  contextTrimAt: string
  contextCompactNow: string
  contextUsed: string
  contextWindowLabel: string
  contextUnknown: string

  /* 界面版本 */
  uiVersion: string
  uiVersionV3: string
  uiVersionEnv: string
  uiVersionNote: string
  uiVersionBack: string
  uiVersionFailed: string

  /* 未迁移 / 缺失 */
  missingTitle: string
  missingBody: string
  unmigratedTitle: string
  unmigratedBody: string
  unknownTitle: string
  unknownBody: string
  openLegacy: string
  backToAppearance: string
  backToChat: string

  /* 用量 */
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
  usageNoModels: string
  usageEmpty: string
  usageLoading: string
  usageError: string
  usageRetry: string
  usageRuns: string
  usageView: string
  usageChart: string
  usageTable: string
  usageDimension: string
  usageByDay: string
  usageByModel: string
  usageByProject: string
  usageDayColumn: string
  usageProjectColumn: string
  usageProjectUnavailable: string
  usageNoDays: string
  usageDailyCap: string

  /* 快捷键 */
  shortcutsNote: string
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
  sectionAppearance: '外观',
  sectionSession: '会话',
  sectionNotifications: '通知与提醒',
  sectionModels: '模型与服务',
  sectionCapabilities: '能力',
  sectionSecurity: '权限与安全',
  sectionDevices: '设备与同步',
  sectionData: '数据',
  sectionUsage: '用量',
  sectionShortcuts: '快捷键',
  sectionAbout: '关于与更新',
  sectionSync: '同步',
  onboardingTitle: '首次引导',
  onboardingDesc: '只在首次启动时自动出现，可在这里重新过一遍；已改的设置不会被重置。',
  onboardingAction: '重新查看引导',
  loading: '正在读取设置…',
  notReady: '设置还没就绪，稍后重试。',

  appearanceNote: '所有改动只在用户点击后写入设置，打开页面本身不会改任何值。',
  theme: '主题',
  themeLight: '浅色',
  themeDark: '深色',
  density: '界面密度',
  densityCompact: '紧凑',
  densityStandard: '标准',
  densityComfortable: '宽松',
  fontSizeUi: '界面字号',
  fontSizeNow: '当前 {n}px',
  fontRead: '阅读字体',
  fontReadDesc: '界面与正文使用的字体；换成非等宽字体后，列表不再严格按字符对齐。',
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
  soundEnable: '提示音与通知',
  soundEnableDesc: '回合完成 / 等你回答 / 出错时响铃；关掉即静音。',
  soundVolume: '音量',
  motion: '动效',
  motionReduced: '跟随系统：已开启「减弱动效」',
  motionFull: '跟随系统：完整动效',
  motionNote: '动效跟随系统的「减少动态效果」设置，在系统里修改即可。',
  asciiBackground: '动态背景',
  asciiBackgroundDesc: '新会话空态铺一层随噪声缓慢流动的 ASCII 字符；发送第一条消息后淡出。',
  language: '语言',

  sectionContext: '上下文',
  contextNote: '压缩由 Agent 内核完成；这里可调整自动压缩上限与旧工具输出的裁剪。这些设置按会话生效。',
  contextUnavailable: '当前没有打开的会话，连接会话后才能改动这几项。',
  contextAutoCompact: '自动压缩',
  contextCompactAt: '自动压缩上限',
  contextCompactAtNow: '到 {n} 触发',
  contextCompactAtClamped: '模型窗口较小，实际在 {e} 触发（设置为 {n}）',
  contextTrim: '裁剪较早的大段工具输出',
  contextTrimDesc: '发给模型前省略较早的大块工具输出；不改会话文件、不做摘要，可用开关关闭。',
  contextTrimAt: '裁剪起点',
  contextCompactNow: '立即压缩',
  contextUsed: '已用',
  contextWindowLabel: '窗口',
  contextUnknown: '未知',

  uiVersion: '界面版本',
  uiVersionV3: '当前：v3（预览）',
  uiVersionEnv: '本次由环境变量固定为 v3，设置里的切换不生效。',
  uiVersionNote: '切换后会保存设置并重新载入窗口；会话、运行与设置都不受影响。',
  uiVersionBack: '切回 v2 界面',
  uiVersionFailed: '切换失败，设置未保存，请稍后重试。',

  missingTitle: '这一页暂不可用',
  missingBody: '这一页在当前版本里暂不可用。同样的配置可以先在旧界面完成。',
  unmigratedTitle: '这一页还在旧界面',
  unmigratedBody: '“{view}”暂时只在旧界面提供，可切回旧界面查看。',
  unknownTitle: '没有这个设置页',
  unknownBody: '“{view}”不是已知的设置页。可切回旧界面，或返回外观。',
  openLegacy: '切回旧界面查看',
  backToAppearance: '返回外观',
  backToChat: '返回对话',

  usageNote: '数据来自本机会话文件。图表与表格都是真实计数，不估算成本。',
  rangeAll: '全部',
  range30: '近 30 天',
  range7: '近 7 天',
  usageSessions: '会话',
  usageMessages: '消息',
  usageTokens: 'Token',
  usageTokensBreakdown: '主会话 {main} · 子代理 {subagents}',
  usageTokensHint: 'Token 含子代理与缓存读写；会话、消息、活跃天数仍只计主会话。',
  usageActiveDays: '活跃天数',
  usagePeakHour: '高峰时段',
  usagePeakNone: '暂无',
  usageModels: '模型用量',
  usageModelColumn: '模型',
  usageTokensColumn: 'Token',
  usageShareColumn: '占比',
  usageNoModels: '这段时间没有模型用量。',
  usageEmpty: '这段时间还没有用量记录。',
  usageLoading: '正在统计本机用量…',
  usageError: '用量统计读取失败。',
  usageRetry: '重试',
  usageRuns: '运行总览',
  usageView: '视图',
  usageChart: '图表',
  usageTable: '表格',
  usageDimension: '分组',
  usageByDay: '按日',
  usageByModel: '按模型',
  usageByProject: '按项目',
  usageDayColumn: '日期',
  usageProjectColumn: '项目',
  usageProjectUnavailable: '目前只按日和模型统计，暂不提供按项目用量。',
  usageNoDays: '这段时间没有按日记录。',
  usageDailyCap: '按日图表与表格仅展示最近 30 天。',

  shortcutsNote: '这里列出全局键位；输入框、审批、终端的键位见 Ctrl+/ 一览。键位暂不支持自定义。',
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
  sectionAppearance: 'Appearance',
  sectionSession: 'Session',
  sectionNotifications: 'Notifications',
  sectionModels: 'Models & services',
  sectionCapabilities: 'Capabilities',
  sectionSecurity: 'Permissions & security',
  sectionDevices: 'Devices & sync',
  sectionData: 'Data',
  sectionUsage: 'Usage',
  sectionShortcuts: 'Keyboard shortcuts',
  sectionAbout: 'About & updates',
  sectionSync: 'Sync',
  onboardingTitle: 'First-run setup',
  onboardingDesc: 'It only opens automatically on first launch; replay it here. Existing settings are not reset.',
  onboardingAction: 'Replay setup',
  loading: 'Loading settings…',
  notReady: 'Settings are not ready yet. Try again shortly.',

  appearanceNote: 'Nothing is written until you click; opening this page never changes a value on its own.',
  theme: 'Theme',
  themeLight: 'Light',
  themeDark: 'Dark',
  density: 'Density',
  densityCompact: 'Compact',
  densityStandard: 'Standard',
  densityComfortable: 'Comfortable',
  fontSizeUi: 'Interface font size',
  fontSizeNow: 'Currently {n}px',
  fontRead: 'Reading font',
  fontReadDesc: 'Font for the interface and body text. With a non-monospace font, lists no longer align by character.',
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
  soundEnable: 'Chimes and notifications',
  soundEnableDesc: 'Play a sound on turn done / waiting for you / error. Turn off to stay silent.',
  soundVolume: 'Volume',
  motion: 'Motion',
  motionReduced: 'Following system: reduced motion is on',
  motionFull: 'Following system: full motion',
  motionNote: 'Motion follows the system “Reduce motion” setting; change it in the system settings.',
  asciiBackground: 'Dynamic background',
  asciiBackgroundDesc: 'A slowly drifting ASCII noise layer behind the empty new-session view; it fades once the first message is sent.',
  language: 'Language',

  sectionContext: 'Context',
  contextNote: 'The Agent runtime handles compaction. Here you can adjust the auto-compaction limit and trimming of older tool output. These settings are per session.',
  contextUnavailable: 'No session is open; connect a session before changing these.',
  contextAutoCompact: 'Auto-compaction',
  contextCompactAt: 'Auto-compaction limit',
  contextCompactAtNow: 'Triggers at {n}',
  contextCompactAtClamped: 'The model window is small; it triggers at {e} (set to {n})',
  contextTrim: 'Trim older large tool output',
  contextTrimDesc: 'Trims older large tool output before sending to the model; it does not change the session file or summarise, and can be switched off.',
  contextTrimAt: 'Trim threshold',
  contextCompactNow: 'Compact now',
  contextUsed: 'Used',
  contextWindowLabel: 'Window',
  contextUnknown: 'unknown',

  uiVersion: 'Interface version',
  uiVersionV3: 'Current: v3 (preview)',
  uiVersionEnv: 'Pinned to v3 by an environment variable in this session, so the setting will not apply.',
  uiVersionNote: 'Switching saves the setting and reloads the window; sessions, runs and settings are unaffected.',
  uiVersionBack: 'Switch back to v2',
  uiVersionFailed: 'Could not switch; the setting was not saved. Please try again.',

  missingTitle: 'This page is not available yet',
  missingBody: 'This page is not available in the current version. The same settings can be changed in the old UI for now.',
  unmigratedTitle: 'This page is still in the old UI',
  unmigratedBody: '“{view}” is only available in the old UI for now. You can switch back to view it.',
  unknownTitle: 'No such settings page',
  unknownBody: '“{view}” is not a known settings page. You can switch back to the old UI or return to Appearance.',
  openLegacy: 'Open in the old UI',
  backToAppearance: 'Back to Appearance',
  backToChat: 'Back to chat',

  usageNote: 'Data comes from local session files. Charts and tables both use real counts; no cost estimates.',
  rangeAll: 'All',
  range30: 'Last 30 days',
  range7: 'Last 7 days',
  usageSessions: 'Sessions',
  usageMessages: 'Messages',
  usageTokens: 'Tokens',
  usageTokensBreakdown: 'Main {main} · Subagents {subagents}',
  usageTokensHint: 'Tokens include subagents plus cache read/write; sessions, messages and active days still count main sessions only.',
  usageActiveDays: 'Active days',
  usagePeakHour: 'Peak hour',
  usagePeakNone: 'n/a',
  usageModels: 'Usage by model',
  usageModelColumn: 'Model',
  usageTokensColumn: 'Tokens',
  usageShareColumn: 'Share',
  usageNoModels: 'No model usage in this range.',
  usageEmpty: 'No usage recorded in this range yet.',
  usageLoading: 'Crunching local usage…',
  usageError: 'Could not read usage statistics.',
  usageRetry: 'Retry',
  usageRuns: 'Runs overview',
  usageView: 'View',
  usageChart: 'Chart',
  usageTable: 'Table',
  usageDimension: 'Group by',
  usageByDay: 'By day',
  usageByModel: 'By model',
  usageByProject: 'By project',
  usageDayColumn: 'Date',
  usageProjectColumn: 'Project',
  usageProjectUnavailable: 'For now usage is counted by day and by model only; per-project usage is not available yet.',
  usageNoDays: 'No daily records in this range.',
  usageDailyCap: 'The daily chart and table show the most recent 30 days only.',

  shortcutsNote: 'Global shortcuts are listed here; Composer, approval and terminal shortcuts are in the Ctrl+/ sheet. Shortcuts cannot be customised yet.',
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
