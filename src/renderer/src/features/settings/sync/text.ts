import type { Lang } from '../../../i18n'
import type { SyncNote, SyncNoteCode, SyncRecordKindView } from '../../../../../shared/sync'

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
  conflictsPendingOne: string
  conflictsReview: string
  conflictsHint: string
  localSide: string
  remoteSide: string
  noLocal: string
  keepLocal: string
  keepRemote: string
  keepBoth: string
  resolving: string
  resolved: string
  resolveFailed: string
  exportSession: string
  importSession: string
  exporting: string
  importing: string
  exportDone: string
  importDone: string
  cancelled: string
  note: Record<SyncNoteCode, string>
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
  conflictsPendingOne: '有 1 条冲突待处理。',
  conflictsReview: '处理冲突',
  conflictsHint: '两端都改了同一条时，双方版本都保留，由你逐条选择。',
  localSide: '本机',
  remoteSide: '来自 {device}',
  noLocal: '本机没有这一条',
  keepLocal: '保留本机',
  keepRemote: '保留他端',
  keepBoth: '两份都留',
  resolving: '处理中…',
  resolved: '已处理这条冲突。',
  resolveFailed: '处理冲突失败。',
  exportSession: '导出当前会话',
  importSession: '导入会话包',
  exporting: '正在导出…',
  importing: '正在导入…',
  exportDone: '已导出到 {path}',
  importDone: '已导入为新会话 {id}',
  cancelled: '已取消。',
  note: {
    'sync.raw': '{text}',
    'folder.missing': '同步文件夹不存在：{path}',
    'folder.unwritable': '同步文件夹不可写：{path}',
    'folder.uncreatable': '无法创建同步子目录：{path}（{reason}）',
    'config.missing': '还没有配置同步文件夹。',
    'mode.unknown': '未知的同步方式。',
    'resolution.unknown': '未知的冲突处理方式。',
    'conflict.missing': '冲突不存在或已经处理。',
    'conflict.unreadable': '无法完整读取两端的版本，这条旧冲突没有处理；请检查同步文件夹后重试。',
    'conflict.changed': '冲突产生后两端版本已变化，这次选择没有生效；请刷新冲突列表后重新选择。',
    'conflict.failed': '处理冲突失败：{reason}',
    'record.failed': '{key}：{reason}',
    'record.forbidden': '拒绝写出 {key}：含凭证字段 {fields}',
    'baseline.writeFailed': '同步基线写入失败：{reason}',
    'session.missing': '当前没有可导出的会话。',
    'session.cancelled': '已取消。',
    'session.exportFailed': '导出会话失败：{reason}',
    'session.importFailed': '导入会话失败：{reason}',
    unknown: '{reason}'
  },
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
  conflictsPendingOne: '1 conflict waiting.',
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
  resolved: 'Conflict resolved.',
  resolveFailed: 'Could not resolve the conflict.',
  exportSession: 'Export current session',
  importSession: 'Import session bundle',
  exporting: 'Exporting…',
  importing: 'Importing…',
  exportDone: 'Exported to {path}',
  importDone: 'Imported as new session {id}',
  cancelled: 'Cancelled.',
  note: {
    'sync.raw': '{text}',
    'folder.missing': 'Sync folder not found: {path}',
    'folder.unwritable': 'Sync folder is not writable: {path}',
    'folder.uncreatable': 'Could not create the sync subfolder: {path} ({reason})',
    'config.missing': 'No sync folder is configured yet.',
    'mode.unknown': 'Unknown sync mode.',
    'resolution.unknown': 'Unknown conflict resolution.',
    'conflict.missing': 'This conflict no longer exists or was already handled.',
    'conflict.unreadable': 'Both sides could not be read completely, so this old conflict was left untouched; check the sync folder and retry.',
    'conflict.changed': 'Both sides changed after this conflict was detected, so the choice was not applied; refresh the conflict list and pick again.',
    'conflict.failed': 'Could not resolve the conflict: {reason}',
    'record.failed': '{key}: {reason}',
    'record.forbidden': 'Refused to write {key}: it contains credential fields {fields}',
    'baseline.writeFailed': 'Could not write the sync baseline: {reason}',
    'session.missing': 'There is no current session to export.',
    'session.cancelled': 'Cancelled.',
    'session.exportFailed': 'Could not export the session: {reason}',
    'session.importFailed': 'Could not import the session: {reason}',
    unknown: '{reason}'
  },
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

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (values[key] !== undefined ? String(values[key]) : match))
}

export function syncNoteText(text: SyncText, note: SyncNote | undefined): string {
  if (!note) return ''
  const params: Record<string, string | number> = note.params ?? {}
  const template = text.note[note.code]
  if (!template) return String(params.reason ?? params.text ?? note.code)
  return fill(template, params)
}

export function conflictsPendingText(text: SyncText, count: number): string {
  return fill(count === 1 ? text.conflictsPendingOne : text.conflictsPending, { n: count })
}

export function conflictTitle(text: SyncText, key: string): string {
  const colon = key.indexOf(':')
  const rawKind = colon < 0 ? key : key.slice(0, colon)
  const name = colon < 0 ? '' : key.slice(colon + 1)
  const kind = rawKind in text.kinds ? text.kinds[rawKind as SyncRecordKindView] : rawKind
  return name ? `${kind} · ${name}` : kind
}
