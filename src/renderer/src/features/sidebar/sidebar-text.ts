export interface SidebarText {
  projectMenu: string
  registerFailed: string
  archivedEntryCount: string
  archivedBack: string
  archivedProjects: string
  archivedSessions: string
  archivedEmpty: string
  restoreProject: string
  restoreSession: string
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
}

const zh: SidebarText = {
  projectMenu: '项目操作',
  registerFailed: '无法把该目录登记为项目',
  archivedEntryCount: '已归档 · {n}',
  archivedBack: '返回会话',
  archivedProjects: '项目',
  archivedSessions: '会话',
  archivedEmpty: '没有归档的项目或会话',
  restoreProject: '恢复项目',
  restoreSession: '取消归档',
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
  moveDropWithCwdHint: '对话保留，之后的命令在 {cwd} 运行。会话正在运行时不能改。'
}

const en: SidebarText = {
  projectMenu: 'Project actions',
  registerFailed: 'Could not register this folder as a project',
  archivedEntryCount: 'Archived · {n}',
  archivedBack: 'Back to chats',
  archivedProjects: 'Projects',
  archivedSessions: 'Chats',
  archivedEmpty: 'No archived projects or chats',
  restoreProject: 'Restore project',
  restoreSession: 'Unarchive',
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
  moveDropWithCwdHint: 'The conversation is kept and later commands run in {cwd}. Not available while the chat is running.'
}

export function sidebarText(lang: string): SidebarText {
  return lang === 'en-US' ? en : zh
}
