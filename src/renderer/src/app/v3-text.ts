import type { Lang } from '../i18n'

export interface V3Text {
  schedule: string
  settings: string
  settingsTitle: string
  appearance: string
  theme: string
  themeLight: string
  themeDark: string
  language: string
  back: string
  more: string
  sidebarLabel: string
  loading: string
  searchShortcut: string
  newChatShortcut: string
  newSessionTitle: string
  toggleSidebar: string
  panelToggles: string
  focusSearch: string
  statusRunning: string
  statusWaiting: string
  statusFailed: string
  projectFallback: string
  groupUngrouped: string
  newInProject: string
  settingsEntryHint: string
  keepOnTop: string
  terminalRunning: string
  sessionBarNoRoom: string
  showSessionBar: string
  hideSessionBar: string
  sessionMenu: string
  dragToSplit: string
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
  schedule: '定时任务',
  settings: '设置',
  settingsTitle: '设置',
  appearance: '外观',
  theme: '主题',
  themeLight: '浅色',
  themeDark: '深色',
  language: '语言',
  back: '返回',
  more: '更多',
  sidebarLabel: '侧栏',
  loading: '正在启动…',
  searchShortcut: '搜索会话（Ctrl+K）',
  newChatShortcut: '新会话（{keys}）',
  newSessionTitle: '新建会话',
  toggleSidebar: '展开或收起侧栏（Ctrl+B）',
  panelToggles: '面板开关',
  focusSearch: '查看会话',
  statusRunning: '运行中',
  statusWaiting: '等你确认',
  statusFailed: '失败',
  projectFallback: '本地 / 未归类',
  groupUngrouped: '未归类',
  newInProject: '在此项目新建会话',
  settingsEntryHint: '打开设置',
  keepOnTop: '窗口置顶',
  terminalRunning: '命令运行中',
  sessionBarNoRoom: '会话栏已开启，窗口太窄暂不显示；点击关闭',
  showSessionBar: '显示会话栏',
  hideSessionBar: '隐藏会话栏',
  sessionMenu: '会话操作',
  dragToSplit: '拖到会话区左右两侧可分屏打开',
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
  schedule: 'Scheduled tasks',
  settings: 'Settings',
  settingsTitle: 'Settings',
  appearance: 'Appearance',
  theme: 'Theme',
  themeLight: 'Light',
  themeDark: 'Dark',
  language: 'Language',
  back: 'Back',
  more: 'More',
  sidebarLabel: 'Sidebar',
  loading: 'Starting…',
  searchShortcut: 'Search chats (Ctrl+K)',
  newChatShortcut: 'New chat ({keys})',
  newSessionTitle: 'New session',
  toggleSidebar: 'Show or hide the sidebar (Ctrl+B)',
  panelToggles: 'Panel toggles',
  focusSearch: 'View chats',
  statusRunning: 'Running',
  statusWaiting: 'Waiting for you',
  statusFailed: 'Failed',
  projectFallback: 'Local / ungrouped',
  groupUngrouped: 'Ungrouped',
  newInProject: 'New chat in this project',
  settingsEntryHint: 'Open settings',
  keepOnTop: 'Keep window on top',
  terminalRunning: 'command running',
  sessionBarNoRoom: 'Session bar is on but the window is too narrow to show it. Click to turn it off',
  showSessionBar: 'Show session bar',
  hideSessionBar: 'Hide session bar',
  sessionMenu: 'Chat actions',
  dragToSplit: 'Drag onto the left or right of the chat to open side by side',
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

export function withShortcutKeys(label: string, keys: string): string {
  return keys ? label.replace('{keys}', keys) : label.replace(/\s*[（(]\{keys\}[）)]/, '')
}

export function v3Text(lang: Lang): V3Text {
  return lang === 'en-US' ? EN : ZH
}
