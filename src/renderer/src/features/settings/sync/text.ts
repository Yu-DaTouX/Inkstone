import type { Lang } from '../../../i18n'
import type { SyncRecordKindView } from '../../../../../shared/sync'

export interface SyncText {
  bridgeMissing: string
  folder: string
  folderUnset: string
  folderPick: string
  folderClear: string
  folderRecommend: string
  modeTitle: string
  modeManual: string
  modeAuto: string
  modeManualHint: string
  modeAutoHint: string
  modeFailed: string
  modeNeedsFolder: string
  contentTitle: string
  contentList: string
  credentialNote: string
  syncNow: string
  syncing: string
  lastNever: string
  lastLine: string
  lastDone: string
  lastFailed: string
  resultPushed: string
  resultPulled: string
  resultConflicts: string
  resultSkipped: string
  syncFailed: string
  syncDone: string
  configureFailed: string
  loadFailed: string
  conflictsTitle: string
  conflictsNone: string
  conflictsPending: string
  conflictsReview: string
  conflictsHint: string
  localSide: string
  remoteSide: string
  noLocal: string
  keepLocal: string
  keepRemote: string
  keepBoth: string
  resolving: string
  resolveFailed: string
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
  bridgeMissing: '当前版本尚未接入同步。',
  folder: '同步文件夹',
  folderUnset: '尚未选择文件夹',
  folderPick: '选择文件夹',
  folderClear: '清除',
  folderRecommend: '在多台电脑间同步设置、技能等：两台电脑选同一个云盘文件夹即可，无需登录。',
  modeTitle: '同步方式',
  modeManual: '手动',
  modeAuto: '自动',
  modeManualHint: '只在点「立即同步」时同步。',
  modeAutoHint: '砚启动时同步一次，之后每 {hours} 小时同步一次。',
  modeFailed: '切换同步方式失败。',
  modeNeedsFolder: '先选择同步文件夹。',
  contentTitle: '同步哪些内容',
  contentList: '设置、提示词模板、技能、书签、定时任务；新设置默认不同步。',
  credentialNote: '模型凭证、路径、窗口位置和会话本体不同步。',
  syncNow: '立即同步',
  syncing: '正在同步…',
  lastNever: '还没有同步过。',
  lastLine: '上次同步 {time} · {result}',
  lastDone: '已完成',
  lastFailed: '未完成',
  resultPushed: '推送 {n}',
  resultPulled: '拉取 {n}',
  resultConflicts: '冲突 {n}',
  resultSkipped: '跳过 {n}',
  syncFailed: '同步失败',
  syncDone: '同步完成：推送 {pushed}，拉取 {pulled}，冲突 {conflicts}，跳过 {skipped}。',
  configureFailed: '设置同步文件夹失败。',
  loadFailed: '读取同步状态失败。',
  conflictsTitle: '同步冲突',
  conflictsNone: '没有待处理的冲突。',
  conflictsPending: '有 {n} 条冲突待处理。',
  conflictsReview: '处理冲突',
  conflictsHint: '两端都改了同一条时，双方版本都保留，由你逐条选择。',
  localSide: '本机',
  remoteSide: '来自 {device}',
  noLocal: '本机没有这一条',
  keepLocal: '保留本机',
  keepRemote: '保留他端',
  keepBoth: '两份都留',
  resolving: '处理中…',
  resolveFailed: '处理冲突失败。',
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
  bridgeMissing:
    'Sync is not available in this build.',
  folder: 'Sync folder',
  folderUnset: 'No folder selected yet',
  folderPick: 'Choose folder',
  folderClear: 'Clear',
  folderRecommend:
    'Sync settings, skills and more across computers: point both at the same cloud-drive folder; no sign-in.',
  modeTitle: 'Sync mode',
  modeManual: 'Manual',
  modeAuto: 'Automatic',
  modeManualHint: 'Syncs only when you press "Sync now".',
  modeAutoHint: 'Syncs once when Inkstone starts, then every {hours} h.',
  modeFailed: 'Could not change the sync mode.',
  modeNeedsFolder: 'Choose a sync folder first.',
  contentTitle: 'What gets synced',
  contentList:
    'Settings, prompts, skills, bookmarks, schedules; new settings are not synced by default.',
  credentialNote: 'Credentials, paths, window layout and sessions never sync.',
  syncNow: 'Sync now',
  syncing: 'Syncing…',
  lastNever: 'No sync has run yet.',
  lastLine: 'Last sync {time} · {result}',
  lastDone: 'Done',
  lastFailed: 'Incomplete',
  resultPushed: 'pushed {n}',
  resultPulled: 'pulled {n}',
  resultConflicts: 'conflicts {n}',
  resultSkipped: 'skipped {n}',
  syncFailed: 'Sync failed',
  syncDone: 'Sync done: pushed {pushed}, pulled {pulled}, conflicts {conflicts}, skipped {skipped}.',
  configureFailed: 'Could not set the sync folder.',
  loadFailed: 'Could not read sync status.',
  conflictsTitle: 'Sync conflicts',
  conflictsNone: 'No conflicts waiting.',
  conflictsPending: '{n} conflicts waiting.',
  conflictsReview: 'Resolve conflicts',
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
