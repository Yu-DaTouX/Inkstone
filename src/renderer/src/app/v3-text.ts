import type { Lang } from '../i18n'

export interface V3Text {
  back: string
  sidebarLabel: string
  newChatShortcut: string
  newSessionTitle: string
  toggleSidebar: string
  groupUngrouped: string
  newInProject: string
  settingsEntryHint: string
  keepOnTop: string
  sessionBarNoRoom: string
  showSessionBar: string
  hideSessionBar: string
  sessionMenu: string
  deleteConfirmTitle: string
  deleteConfirmBody: string
  deleteConfirm: string
  cancel: string
}

const ZH: V3Text = {
  back: '返回',
  sidebarLabel: '侧栏',
  newChatShortcut: '新会话（{keys}）',
  newSessionTitle: '新建会话',
  toggleSidebar: '展开或收起侧栏（Ctrl+B）',
  groupUngrouped: '未归类',
  newInProject: '在此项目新建会话',
  settingsEntryHint: '打开设置',
  keepOnTop: '窗口置顶',
  sessionBarNoRoom: '会话栏已自动收起，变宽后恢复',
  showSessionBar: '显示会话栏',
  hideSessionBar: '隐藏会话栏',
  sessionMenu: '会话操作',
  deleteConfirmTitle: '删除这个会话？',
  deleteConfirmBody: '「{name}」会移到回收站。',
  deleteConfirm: '删除',
  cancel: '取消'
}

const EN: V3Text = {
  back: 'Back',
  sidebarLabel: 'Sidebar',
  newChatShortcut: 'New session ({keys})',
  newSessionTitle: 'New session',
  toggleSidebar: 'Show or hide the sidebar (Ctrl+B)',
  groupUngrouped: 'Ungrouped',
  newInProject: 'New session in this project',
  settingsEntryHint: 'Open settings',
  keepOnTop: 'Keep window on top',
  sessionBarNoRoom: 'Session bar auto-hidden, returns when there is room',
  showSessionBar: 'Show session bar',
  hideSessionBar: 'Hide session bar',
  sessionMenu: 'Session actions',
  deleteConfirmTitle: 'Delete this session?',
  deleteConfirmBody: '“{name}” will be moved to the trash.',
  deleteConfirm: 'Delete',
  cancel: 'Cancel'
}

export function withShortcutKeys(label: string, keys: string): string {
  return keys ? label.replace('{keys}', keys) : label.replace(/\s*[（(]\{keys\}[）)]/, '')
}

export function v3Text(lang: Lang): V3Text {
  return lang === 'en-US' ? EN : ZH
}
