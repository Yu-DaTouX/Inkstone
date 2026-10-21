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
  newChat: string
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
  newChat: '新建会话',
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
  connectionSettings: '连接设置'
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
  newChat: 'New chat',
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
  connectionSettings: 'Connection settings'
}

export function sidebarText(lang: string): SidebarText {
  return lang === 'en-US' ? en : zh
}
