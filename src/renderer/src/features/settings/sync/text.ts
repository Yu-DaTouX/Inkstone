import type { Lang } from '../../../i18n'
import type { SyncRecordKindView } from '../../../../../shared/sync'

export interface SyncText {
  note: string
  bridgeMissing: string
  folder: string
  folderUnset: string
  folderPick: string
  folderClear: string
  folderRecommend: string
  contentTitle: string
  contentList: string
  credentialNote: string
  syncNow: string
  syncing: string
  refresh: string
  lastTitle: string
  lastNever: string
  lastAt: string
  lastOk: string
  lastFailed: string
  resultPushed: string
  resultPulled: string
  resultConflicts: string
  resultSkipped: string
  resultErrors: string
  syncFailed: string
  syncDone: string
  configureFailed: string
  loadFailed: string
  conflictsTitle: string
  conflictsNone: string
  conflictsHint: string
  localSide: string
  remoteSide: string
  noLocal: string
  keepLocal: string
  keepRemote: string
  keepBoth: string
  resolving: string
  resolveFailed: string
  sessionTitle: string
  sessionNote: string
  exportSession: string
  importSession: string
  exporting: string
  importing: string
  exportDone: string
  importDone: string
  cancelled: string
  kinds: Record<SyncRecordKindView, string>
}

const ZH: SyncText = {
  note: '选一个文件夹，在多台电脑间同步设置、技能等。',
  bridgeMissing: '当前版本尚未接入同步。',
  folder: '同步文件夹',
  folderUnset: '尚未选择文件夹',
  folderPick: '选择文件夹',
  folderClear: '清除',
  folderRecommend: '两台电脑选同一个云盘文件夹即可，无需登录。',
  contentTitle: '同步哪些内容',
  contentList: '设置、提示词模板、技能、书签、定时任务；新设置默认不同步。',
  credentialNote: '模型凭证、路径、窗口位置和会话本体不同步。',
  syncNow: '立即同步',
  syncing: '正在同步…',
  refresh: '刷新',
  lastTitle: '上次同步',
  lastNever: '还没有同步过。',
  lastAt: '时间',
  lastOk: '结果',
  lastFailed: '未完成',
  resultPushed: '推送 {n}',
  resultPulled: '拉取 {n}',
  resultConflicts: '冲突 {n}',
  resultSkipped: '跳过 {n}',
  resultErrors: '错误',
  syncFailed: '同步失败',
  syncDone: '同步完成：推送 {pushed}，拉取 {pulled}，冲突 {conflicts}，跳过 {skipped}。',
  configureFailed: '设置同步文件夹失败。',
  loadFailed: '读取同步状态失败。',
  conflictsTitle: '冲突',
  conflictsNone: '没有待处理的冲突。',
  conflictsHint: '两端都改了同一条时，双方版本都保留，由你逐条选择。',
  localSide: '本机',
  remoteSide: '来自 {device}',
  noLocal: '本机没有这一条',
  keepLocal: '保留本机',
  keepRemote: '保留他端',
  keepBoth: '两份都留',
  resolving: '处理中…',
  resolveFailed: '处理冲突失败。',
  sessionTitle: '会话导出 / 导入',
  sessionNote: '会话体积大且含本机路径，不同步；请导出会话包，在另一台导入（生成新会话）。',
  exportSession: '导出当前会话',
  importSession: '导入会话包',
  exporting: '正在导出…',
  importing: '正在导入…',
  exportDone: '已导出到 {path}',
  importDone: '已导入为新会话 {id}',
  cancelled: '已取消。',
  kinds: {
    settings: '设置',
    prompt: '提示词',
    skill: '技能',
    bookmark: '书签',
    schedule: '定时任务'
  }
}

const EN: SyncText = {
  note: 'Pick a folder to sync settings, skills and more across computers.',
  bridgeMissing:
    'Sync is not available in this build.',
  folder: 'Sync folder',
  folderUnset: 'No folder selected yet',
  folderPick: 'Choose folder',
  folderClear: 'Clear',
  folderRecommend:
    'Point both computers at the same cloud-drive folder; no sign-in.',
  contentTitle: 'What gets synced',
  contentList:
    'Settings, prompts, skills, bookmarks, schedules; new settings are not synced by default.',
  credentialNote: 'Credentials, paths, window layout and sessions never sync.',
  syncNow: 'Sync now',
  syncing: 'Syncing…',
  refresh: 'Refresh',
  lastTitle: 'Last sync',
  lastNever: 'No sync has run yet.',
  lastAt: 'Time',
  lastOk: 'Result',
  lastFailed: 'Incomplete',
  resultPushed: 'pushed {n}',
  resultPulled: 'pulled {n}',
  resultConflicts: 'conflicts {n}',
  resultSkipped: 'skipped {n}',
  resultErrors: 'Errors',
  syncFailed: 'Sync failed',
  syncDone: 'Sync done: pushed {pushed}, pulled {pulled}, conflicts {conflicts}, skipped {skipped}.',
  configureFailed: 'Could not set the sync folder.',
  loadFailed: 'Could not read sync status.',
  conflictsTitle: 'Conflicts',
  conflictsNone: 'No conflicts waiting.',
  conflictsHint:
    'If both sides changed an item, both versions are kept for you to pick.',
  localSide: 'This device',
  remoteSide: 'From {device}',
  noLocal: 'No local copy',
  keepLocal: 'Keep this device',
  keepRemote: 'Keep the other side',
  keepBoth: 'Keep both',
  resolving: 'Resolving…',
  resolveFailed: 'Could not resolve the conflict.',
  sessionTitle: 'Session export / import',
  sessionNote:
    'Sessions are not synced; export a bundle and import it elsewhere as a new session.',
  exportSession: 'Export current session',
  importSession: 'Import session bundle',
  exporting: 'Exporting…',
  importing: 'Importing…',
  exportDone: 'Exported to {path}',
  importDone: 'Imported as new session {id}',
  cancelled: 'Cancelled.',
  kinds: {
    settings: 'Settings',
    prompt: 'Prompt',
    skill: 'Skill',
    bookmark: 'Bookmark',
    schedule: 'Schedule'
  }
}

export function syncText(lang: Lang): SyncText {
  return lang === 'en-US' ? EN : ZH
}
