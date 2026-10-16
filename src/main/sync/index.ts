/**
 * 跨设备同步（WP-53 A 阶段）核心模块入口。
 *
 * 只导出同步核心；IPC 与设置界面的接线不在这里（后续工单）。
 */
export { SyncService } from './service'
export type { SyncServiceOptions } from './service'
export { SyncFolder, SYNC_SUBDIR } from './sync-folder'
export { LocalStore, defaultSyncPaths, forbiddenFieldsInRecord, pickScheduleDefinition } from './local-store'
export { SyncConfigStore, SYNC_CONFIG_FILE } from './config'
export type { SyncConfig, SyncRunSummary } from './config'
export { buildConflictCopy, supportsConflictCopy } from './resolve'
export { SYNC_SETTINGS_WHITELIST, pickSyncSettings, findForbiddenFields } from './settings-whitelist'
export {
  exportSession,
  importSession,
  readSessionId,
  rewriteSessionId,
  SESSION_BUNDLE_KIND,
  SESSION_BUNDLE_VERSION
} from './session-transfer'
export type { SessionBundle, ExportSessionResult, ImportSessionResult } from './session-transfer'
export { canonicalJson, sha256Hex, shortHash } from './canonical'
export { atomicWriteFile } from './atomic'
export type {
  BaselineEntry,
  BaselineFile,
  ConflictRecord,
  RemoteRecord,
  SyncPaths,
  SyncRecord,
  SyncRecordKind,
  SyncReport
} from './types'
