import type { Lang } from '../i18n'

export interface V3Text {
  runs: string
  runsEmpty: string
  runsProvisional: string
  runsBack: string
  runsStatus: string
  schedule: string
  review: string
  settings: string
  settingsTitle: string
  settingsNote: string
  appearance: string
  theme: string
  themeLight: string
  themeDark: string
  language: string
  uiVersion: string
  uiVersionV3: string
  uiVersionBack: string
  uiVersionEnv: string
  uiVersionNote: string
  uiVersionFailed: string
  back: string
  more: string
  sidebarLabel: string
  loading: string
  searchShortcut: string
  newChatShortcut: string
  toggleSidebar: string
  focusSearch: string
  statusRunning: string
  statusWaiting: string
  statusFailed: string
  projectFallback: string
  groupUngrouped: string
  newInProject: string
  settingsEntryHint: string
  sessionMenu: string
  dragToSplit: string
  dropLeft: string
  dropRight: string
  deleteConfirmTitle: string
  deleteConfirmBody: string
  deleteConfirm: string
  cancel: string
  pinnedGroup: string
  usageEmptyNote: string
  usageStripLabel: string
  usageStripSessions: string
  usageStripDays: string
  usageStripRecent: string
}

const ZH: V3Text = {
  runs: '运行总览',
  runsEmpty: '暂无运行。开始一件任务，它会出现在这里。',
  runsProvisional:
    '这是按现有运行实例（agent_start → agent_settled 的投影）列出的清单，尚未接入运行注册表（WP-11）；状态词不代表权威七态，也不含停滞计时。',
  runsBack: '返回对话',
  runsStatus: '状态',
  schedule: '定时任务',
  review: '代码评审',
  settings: '设置',
  settingsTitle: '设置',
  settingsNote:
    'v3 的临时精简设置面板：目前只有外观与外壳切换。模型、权限、能力、设备等仍在旧界面，切回 v2 即可使用。',
  appearance: '外观',
  theme: '主题',
  themeLight: '浅色',
  themeDark: '深色',
  language: '语言',
  uiVersion: '界面版本',
  uiVersionV3: '当前：v3（预览）',
  uiVersionBack: '切回 v2 界面',
  uiVersionEnv: '本次由环境变量固定为 v3，设置里的切换不生效。',
  uiVersionNote: '切换后会重新载入窗口；会话、运行与设置都不受影响。',
  uiVersionFailed: '切换失败，请稍后重试。',
  back: '返回',
  more: '更多',
  sidebarLabel: '侧栏',
  loading: '正在启动…',
  searchShortcut: '搜索会话（Ctrl+K）',
  newChatShortcut: '新对话（Ctrl+N）',
  toggleSidebar: '展开或收起侧栏（Ctrl+B）',
  focusSearch: '查看会话',
  statusRunning: '运行中',
  statusWaiting: '等你确认',
  statusFailed: '失败',
  projectFallback: '本地 / 未归类',
  groupUngrouped: '未归类',
  newInProject: '在此项目新建对话',
  settingsEntryHint: '打开设置',
  sessionMenu: '会话操作',
  dragToSplit: '拖到对话区左右两侧可分屏打开',
  dropLeft: '放到左侧',
  dropRight: '放到右侧',
  deleteConfirmTitle: '删除这个会话？',
  deleteConfirmBody: '「{name}」会移到回收站。',
  deleteConfirm: '移入回收站',
  cancel: '取消',
  pinnedGroup: '置顶',
  usageEmptyNote: '还没有用量记录，发出第一条消息后开始统计。',
  usageStripLabel: '本机用量',
  usageStripSessions: '{n} 个会话',
  usageStripDays: '活跃 {n} 天',
  usageStripRecent: '近 14 天每日 Token'
}

const EN: V3Text = {
  runs: 'Runs',
  runsEmpty: 'No runs yet. Start a task and it will show up here.',
  runsProvisional:
    'This lists the current runner instances (a projection of agent_start → agent_settled). It is not yet wired to the run registry (WP-11): the labels are not the authoritative seven states and there is no stall timing.',
  runsBack: 'Back to chat',
  runsStatus: 'Status',
  schedule: 'Scheduled tasks',
  review: 'Code review',
  settings: 'Settings',
  settingsTitle: 'Settings',
  settingsNote:
    'Temporary slim settings for v3: only appearance and shell switching. Models, permissions, capabilities and devices still live in the old UI — switch back to v2 for those.',
  appearance: 'Appearance',
  theme: 'Theme',
  themeLight: 'Light',
  themeDark: 'Dark',
  language: 'Language',
  uiVersion: 'Interface version',
  uiVersionV3: 'Current: v3 (preview)',
  uiVersionBack: 'Switch back to v2',
  uiVersionEnv: 'Pinned to v3 by an environment variable in this session, so the setting will not apply.',
  uiVersionNote: 'The window reloads after switching; sessions, runs and settings are unaffected.',
  uiVersionFailed: 'Could not switch. Please try again.',
  back: 'Back',
  more: 'More',
  sidebarLabel: 'Sidebar',
  loading: 'Starting…',
  searchShortcut: 'Search chats (Ctrl+K)',
  newChatShortcut: 'New chat (Ctrl+N)',
  toggleSidebar: 'Show or hide the sidebar (Ctrl+B)',
  focusSearch: 'View chats',
  statusRunning: 'Running',
  statusWaiting: 'Waiting for you',
  statusFailed: 'Failed',
  projectFallback: 'Local / ungrouped',
  groupUngrouped: 'Ungrouped',
  newInProject: 'New chat in this project',
  settingsEntryHint: 'Open settings',
  sessionMenu: 'Chat actions',
  dragToSplit: 'Drag onto the left or right of the chat to open side by side',
  dropLeft: 'Drop on the left',
  dropRight: 'Drop on the right',
  deleteConfirmTitle: 'Delete this chat?',
  deleteConfirmBody: '“{name}” will be moved to the trash.',
  deleteConfirm: 'Move to trash',
  cancel: 'Cancel',
  pinnedGroup: 'Pinned',
  usageEmptyNote: 'No usage yet. Stats start with your first message.',
  usageStripLabel: 'Local usage',
  usageStripSessions: '{n} sessions',
  usageStripDays: '{n} active days',
  usageStripRecent: 'Daily tokens, last 14 days'
}

export function v3Text(lang: Lang): V3Text {
  return lang === 'en-US' ? EN : ZH
}
