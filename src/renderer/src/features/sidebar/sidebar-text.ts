export interface SidebarText {
  projectMenu: string
  newInWorktree: string
  iconColor: string
  iconColorAuto: string
  iconColorOption: string
  iconText: string
  iconTextHint: string
  iconTextReset: string
  iconSaveFailed: string
  restoreProject: string
  restoreProjectFailed: string
  archiveShelf: string
  showMore: string
  pin: string
  localUser: string
  connectionSettings: string
  workingShelf: string
  attention: string
}

const zh: SidebarText = {
  projectMenu: '项目操作',
  newInWorktree: '在工作树中新建会话',
  iconColor: '图标颜色',
  iconColorAuto: '自动',
  iconColorOption: '颜色 {n}',
  iconText: '图标文字…',
  iconTextHint: '1–2 个字，留空则按项目名自动生成',
  iconTextReset: '恢复自动',
  iconSaveFailed: '保存项目图标失败，请重试',
  restoreProject: '恢复项目',
  restoreProjectFailed: '恢复项目失败，请重试',
  archiveShelf: '已归档',
  showMore: '显示 {n} 条更多',
  pin: '固定会话列表',
  localUser: '本机',
  connectionSettings: '连接设置',
  workingShelf: '运行中',
  attention: '会话状态'
}

const en: SidebarText = {
  projectMenu: 'Project actions',
  newInWorktree: 'New session in a worktree',
  iconColor: 'Icon color',
  iconColorAuto: 'Automatic',
  iconColorOption: 'Color {n}',
  iconText: 'Icon text…',
  iconTextHint: '1–2 characters. Leave empty to derive from the project name.',
  iconTextReset: 'Use automatic',
  iconSaveFailed: 'Could not save the project icon. Try again.',
  restoreProject: 'Restore project',
  restoreProjectFailed: 'Could not restore project. Try again.',
  archiveShelf: 'Archived',
  showMore: 'Show {n} more',
  pin: 'Pin session list',
  localUser: 'This computer',
  connectionSettings: 'Connection settings',
  workingShelf: 'Working',
  attention: 'Session status'
}

export function sidebarText(lang: string): SidebarText {
  return lang === 'en-US' ? en : zh
}
