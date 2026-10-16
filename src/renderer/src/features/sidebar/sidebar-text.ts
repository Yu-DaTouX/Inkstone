/** 侧栏自己的界面文案（中英各一份）；其余文案沿用 `rail.*` 键与 v3Text。 */
export interface SidebarText {
  projectMenu: string
  archivedEntryCount: string
  archivedBack: string
  archivedProjects: string
  archivedSessions: string
  archivedEmpty: string
  restoreProject: string
  restoreSession: string
  projectSessionCount: string
  newChat: string
  moreEntries: string
  runRecords: string
  showMore: string
  showLess: string
}

const zh: SidebarText = {
  projectMenu: '项目操作',
  archivedEntryCount: '已归档 · {n}',
  archivedBack: '返回会话',
  archivedProjects: '项目',
  archivedSessions: '会话',
  archivedEmpty: '没有归档的项目或会话',
  restoreProject: '恢复项目',
  restoreSession: '取消归档',
  projectSessionCount: '{n} 个会话',
  newChat: '新建对话',
  moreEntries: '更多',
  runRecords: '运行记录',
  showMore: '显示更多',
  showLess: '收起'
}

const en: SidebarText = {
  projectMenu: 'Project actions',
  archivedEntryCount: 'Archived · {n}',
  archivedBack: 'Back to chats',
  archivedProjects: 'Projects',
  archivedSessions: 'Chats',
  archivedEmpty: 'No archived projects or chats',
  restoreProject: 'Restore project',
  restoreSession: 'Unarchive',
  projectSessionCount: '{n} chats',
  newChat: 'New chat',
  moreEntries: 'More',
  runRecords: 'Run history',
  showMore: 'Show more',
  showLess: 'Show less'
}

export function sidebarText(lang: string): SidebarText {
  return lang === 'en-US' ? en : zh
}
