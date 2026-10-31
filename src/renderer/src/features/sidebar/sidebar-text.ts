export interface SidebarText {
  projectMenu: string
  iconColor: string
  iconColorAuto: string
  iconColorOption: string
  iconText: string
  iconTextHint: string
  iconTextReset: string
  iconSaveFailed: string
  registerFailed: string
  archivedEntryCount: string
  archivedBack: string
  archivedProjects: string
  archivedSessions: string
  archivedEmpty: string
  restoreProject: string
  restoreProjectFailed: string
  restoreSession: string
  archiveShelf: string
  archiveShelfDrop: string
  archiveShelfAll: string
  restoreDrop: string
  projectSessionCount: string
  entryAwaiting: string
  entryRunning: string
  newChatInFolder: string
  showMore: string
  showLess: string
  showMoreLabel: string
  showLessLabel: string
  showMoreAnnounce: string
  showLessAnnounce: string
  contentMatches: string
  contentSearching: string
  contentFailed: string
  contentFallbackTitle: string
  contentArchived: string
  search: string
  searchHint: string
  pin: string
  filterSessions: string
  localUser: string
  connectionSettings: string
  moveDropTitle: string
  moveDropBody: string
  moveDropOwnerOnly: string
  moveDropOwnerOnlyHint: string
  moveDropWithCwd: string
  moveDropWithCwdHint: string
  projectScope: string
  allProjects: string
  clearScope: string
  workingShelf: string
  pinDrop: string
  unpinDrop: string
  recencyToday: string
  recencyYesterday: string
  recencyWeek: string
  recencyOlder: string
  attention: string
  attentionRunning: string
  attentionAwaiting: string
  attentionUnread: string
  attentionJump: string
}

const zh: SidebarText = {
  projectMenu: '项目操作',
  iconColor: '图标颜色',
  iconColorAuto: '自动',
  iconColorOption: '颜色 {n}',
  iconText: '图标文字…',
  iconTextHint: '1–2 个字，留空则按项目名自动生成',
  iconTextReset: '恢复自动',
  iconSaveFailed: '保存项目图标失败，请重试',
  registerFailed: '无法把该目录登记为项目',
  archivedEntryCount: '已归档 · {n}',
  archivedBack: '返回会话',
  archivedProjects: '项目',
  archivedSessions: '会话',
  archivedEmpty: '没有归档的项目或会话',
  restoreProject: '恢复项目',
  restoreProjectFailed: '恢复项目失败，请重试',
  restoreSession: '取消归档',
  archiveShelf: '已归档',
  archiveShelfDrop: '松开即可归档',
  archiveShelfAll: '查看全部归档',
  restoreDrop: '松开即可取消归档',
  projectSessionCount: '{n} 个会话',
  entryAwaiting: '需要你处理',
  entryRunning: '正在运行',
  newChatInFolder: '打开项目…',
  showMore: '显示 {n} 条更多',
  showLess: '收起',
  showMoreLabel: '在 {group} 中再显示 {n} 个会话',
  showLessLabel: '收起 {group} 的会话',
  showMoreAnnounce: '在 {group} 中再显示 {n} 个会话',
  showLessAnnounce: '已收起 {group} 的会话',
  contentMatches: '内容匹配',
  contentSearching: '正在搜索全文…',
  contentFailed: '全文搜索失败',
  contentFallbackTitle: '{date} 的会话',
  contentArchived: '已归档',
  search: '搜索',
  searchHint: '搜索与命令（Ctrl+K）',
  pin: '固定会话列表',
  filterSessions: '筛选会话',
  localUser: '本机',
  connectionSettings: '连接设置',
  moveDropTitle: '把会话移到「{folder}」',
  moveDropBody: '「{name}」要怎么移动？',
  moveDropOwnerOnly: '只改归属',
  moveDropOwnerOnlyHint: '会话显示在新文件夹下，命令仍在原工作目录运行。',
  moveDropWithCwd: '同时改工作目录',
  moveDropWithCwdHint: '对话保留，之后的命令在 {cwd} 运行。会话正在运行时不能改。',
  projectScope: '按项目筛选',
  allProjects: '全部项目',
  clearScope: '显示全部项目',
  workingShelf: '运行中',
  pinDrop: '松开即可置顶',
  unpinDrop: '松开即可取消置顶',
  recencyToday: '今天',
  recencyYesterday: '昨天',
  recencyWeek: '7 天内',
  recencyOlder: '更早',
  attention: '会话状态',
  attentionRunning: '运行',
  attentionAwaiting: '等你',
  attentionUnread: '未读',
  attentionJump: '{state} {n} 个，跳到下一个'
}

const en: SidebarText = {
  projectMenu: 'Project actions',
  iconColor: 'Icon color',
  iconColorAuto: 'Automatic',
  iconColorOption: 'Color {n}',
  iconText: 'Icon text…',
  iconTextHint: '1–2 characters. Leave empty to derive from the project name.',
  iconTextReset: 'Use automatic',
  iconSaveFailed: 'Could not save the project icon. Try again.',
  registerFailed: 'Could not register this folder as a project',
  archivedEntryCount: 'Archived · {n}',
  archivedBack: 'Back to chats',
  archivedProjects: 'Projects',
  archivedSessions: 'Chats',
  archivedEmpty: 'No archived projects or chats',
  restoreProject: 'Restore project',
  restoreProjectFailed: 'Could not restore project. Try again.',
  restoreSession: 'Unarchive',
  archiveShelf: 'Archived',
  archiveShelfDrop: 'Release to archive',
  archiveShelfAll: 'View all archived',
  restoreDrop: 'Release to unarchive',
  projectSessionCount: '{n} chats',
  entryAwaiting: 'Needs you',
  entryRunning: 'Running',
  newChatInFolder: 'Open project…',
  showMore: 'Show {n} more',
  showLess: 'Show less',
  showMoreLabel: 'Show {n} more in {group}',
  showLessLabel: 'Show less in {group}',
  showMoreAnnounce: 'Showing {n} more in {group}',
  showLessAnnounce: 'Showing less in {group}',
  contentMatches: 'In conversations',
  contentSearching: 'Searching conversations…',
  contentFailed: 'Full-text search failed',
  contentFallbackTitle: 'Chat from {date}',
  contentArchived: 'Archived',
  search: 'Search',
  searchHint: 'Search and commands (Ctrl+K)',
  pin: 'Pin session list',
  filterSessions: 'Filter chats',
  localUser: 'This computer',
  connectionSettings: 'Connection settings',
  moveDropTitle: 'Move chat to "{folder}"',
  moveDropBody: 'How should "{name}" be moved?',
  moveDropOwnerOnly: 'Change folder only',
  moveDropOwnerOnlyHint: 'The chat is listed under the new folder; commands still run in its original working directory.',
  moveDropWithCwd: 'Also change working directory',
  moveDropWithCwdHint: 'The conversation is kept and later commands run in {cwd}. Not available while the chat is running.',
  projectScope: 'Filter by project',
  allProjects: 'All projects',
  clearScope: 'Show all projects',
  workingShelf: 'Working',
  pinDrop: 'Release to pin',
  unpinDrop: 'Release to unpin',
  recencyToday: 'Today',
  recencyYesterday: 'Yesterday',
  recencyWeek: 'Previous 7 days',
  recencyOlder: 'Older',
  attention: 'Chat status',
  attentionRunning: 'running',
  attentionAwaiting: 'need you',
  attentionUnread: 'unread',
  attentionJump: '{n} {state}, jump to the next'
}

export function sidebarText(lang: string): SidebarText {
  return lang === 'en-US' ? en : zh
}
