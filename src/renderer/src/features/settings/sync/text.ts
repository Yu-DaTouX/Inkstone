/**
 * 设置 → 同步 的短文案（中英同步）。
 *
 * 与 `settings-text.ts` 分开：这一页的文案只在同步分区用到，避免动到
 * 多个并行工单都会碰的共享文案文件；只有导航标签 `sectionSync` 放进 settings-text。
 */
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
  note: '同步文件夹把设置、提示词模板、技能、书签与定时任务定义在几台电脑之间保持一致。文件夹由你选择：放在 OneDrive、坚果云或 Syncthing 管理的目录里，传输交给它们，砚只按文件读写。',
  bridgeMissing: '当前构建还没有接入同步（preload 未暴露 window.yan.sync）。这里只说明限制，不显示假状态。',
  folder: '同步文件夹',
  folderUnset: '尚未选择文件夹',
  folderPick: '选择文件夹',
  folderClear: '清除',
  folderRecommend: '推荐放在云盘（OneDrive / 坚果云）或 Syncthing 管理的目录里；两端指向同一个文件夹即可，不需要登录任何账号。',
  contentTitle: '同步哪些内容',
  contentList: '设置（仅跨设备有意义的偏好）、提示词模板、技能、书签、定时任务定义。新增设置字段默认不同步，逐个显式放行。',
  credentialNote: '模型凭证（pi 的 auth.json）、路径、窗口几何、会话本体都不参与同步。',
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
  conflictsHint: '两端自上次同步后都改过同一条时，双方版本都保留，等待你逐条选择。',
  localSide: '本机',
  remoteSide: '来自 {device}',
  noLocal: '本机没有这一条',
  keepLocal: '保留本机',
  keepRemote: '保留他端',
  keepBoth: '两份都留',
  resolving: '处理中…',
  resolveFailed: '处理冲突失败。',
  sessionTitle: '会话导出 / 导入',
  sessionNote: '会话本体体积大、含本机路径，不参与同步。需要搬运时导出成会话包，在另一台电脑导入；导入会生成新会话，不覆盖同名。',
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
  note: 'A sync folder keeps settings, prompt templates, skills, bookmarks and scheduled-task definitions aligned across computers. You choose the folder: put it in a directory managed by OneDrive, Nutstore or Syncthing — they handle transfer, Inkstone only reads and writes files.',
  bridgeMissing:
    'This build has not wired sync yet (preload does not expose window.yan.sync). This page only states the limitation instead of showing a fake status.',
  folder: 'Sync folder',
  folderUnset: 'No folder selected yet',
  folderPick: 'Choose folder',
  folderClear: 'Clear',
  folderRecommend:
    'Put it in a folder managed by a cloud drive (OneDrive / Nutstore) or Syncthing; point both machines at the same folder — no account sign-in required.',
  contentTitle: 'What gets synced',
  contentList:
    'Settings (only device-independent preferences), prompt templates, skills, bookmarks and scheduled-task definitions. New settings keys stay out until explicitly allow-listed.',
  credentialNote: 'Model credentials (pi auth.json), paths, window geometry and session bodies never sync.',
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
    'When both machines changed the same item since the last sync, both versions are kept until you choose per item.',
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
    'Session bodies are large and contain local paths, so they never sync. Export a session bundle to move one, then import it on the other machine; import creates a new session and never overwrites an existing name.',
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
