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
  runRecords: string
  showMore: string
  showLess: string
  contentMatches: string
  contentSearching: string
  contentFailed: string
  contentFallbackTitle: string
  contentArchived: string
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
  runRecords: '运行总览',
  showMore: '显示更多',
  showLess: '收起',
  contentMatches: '内容匹配',
  contentSearching: '正在搜索全文…',
  contentFailed: '全文搜索失败',
  contentFallbackTitle: '{date} 的会话',
  contentArchived: '已归档'
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
  runRecords: 'Runs',
  showMore: 'Show more',
  showLess: 'Show less',
  contentMatches: 'In conversations',
  contentSearching: 'Searching conversations…',
  contentFailed: 'Full-text search failed',
  contentFallbackTitle: 'Chat from {date}',
  contentArchived: 'Archived'
}

export function sidebarText(lang: string): SidebarText {
  return lang === 'en-US' ? en : zh
}
