/**
 * 跨设备同步（WP-53）的渲染端 / 接线层共享类型。
 *
 * 这里只放 IPC 与 preload 边界上的**数据形状**，不依赖 Electron、也不导入
 * `src/main/sync/**` 的实现类型：主进程与渲染端各按同一份契约说话，
 * 测试可以拿这份类型直接构造假实现（见 scripts/test-v3-sync-ipc.mjs）。
 *
 * 权威实现仍在 `src/main/sync/**`（SyncService）；接口层不复制同步算法。
 */

/** 冲突处理方式：保留本机 / 保留他端 / 两份都留。 */
export type SyncResolution = 'local' | 'remote' | 'both'

/** 参与同步的类别（与会话本体无关；会话只导出 / 导入）。 */
export type SyncRecordKindView = 'settings' | 'prompt' | 'skill' | 'bookmark' | 'schedule'

/** 最近一次同步的摘要；`at` 为毫秒时间戳。 */
export interface SyncLastSummary {
  at: number
  ok: boolean
  pushed: number
  pulled: number
  conflicts: number
  skipped: number
  errors: string[]
}

/** `yan:sync:status` 的返回：是否已配置、同步目录、上次结果与待处理冲突数。 */
export interface SyncStatusView {
  configured: boolean
  syncRoot?: string
  lastSync?: SyncLastSummary
  conflictCount: number
  /** 读取状态本身失败时的可读原因；不吞掉。 */
  error?: string
}

/** `yan:sync:now` 的返回：只报计数与错误，不抛异常。 */
export interface SyncNowResult {
  ok: boolean
  pushed: number
  pulled: number
  conflicts: number
  skipped: number
  errors: string[]
  at?: number
  error?: string
}

/** 冲突在界面上的只读投影；两份内容都带短预览，供人工判断。 */
export interface SyncConflictView {
  id: string
  key: string
  kind: SyncRecordKindView
  detectedAt: number
  localDeviceName?: string
  remoteDeviceName: string
  localModifiedAt?: number
  remoteModifiedAt: number
  /** 人类可读的他端后缀，例如「来自 DESKTOP-B · 2026-10-15 12-00-00」。 */
  suffix: string
  localPreview?: string
  remotePreview?: string
}

/** `yan:sync:resolve` 的返回。 */
export interface SyncResolveResult {
  ok: boolean
  error?: string
}

/** `yan:sync:configure` 的返回；`cancelled` 表示用户在目录对话框里取消。 */
export interface SyncConfigureResult {
  ok: boolean
  cancelled?: boolean
  syncRoot?: string
  error?: string
}

/** `yan:sync:exportSession` 的返回。 */
export interface SyncExportSessionResult {
  ok: boolean
  path?: string
  bytes?: number
  /** 用户在对话框里取消；不是错误。 */
  cancelled?: boolean
  error?: string
}

/** `yan:sync:importSession` 的返回；导入总是生成新会话 id。 */
export interface SyncImportSessionResult {
  ok: boolean
  path?: string
  sessionId?: string
  /** 用户在对话框里取消；不是错误。 */
  cancelled?: boolean
  error?: string
}

/**
 * preload 暴露的 `window.yan.sync` 形状。
 *
 * 渲染端在热点 preload 接线前用局部类型守卫读它（见 settings/sync/bridge.ts），
 * 拿到 null 时如实提示「尚未接线」，而不是假装同步可用。
 */
export interface SyncBridge {
  status(): Promise<SyncStatusView>
  /** 不传参数 = 弹出目录对话框；传 null = 清除配置。 */
  configure(root?: string | null): Promise<SyncConfigureResult>
  now(): Promise<SyncNowResult>
  conflicts(): Promise<SyncConflictView[]>
  resolve(id: string, resolution: SyncResolution): Promise<SyncResolveResult>
  exportSession(sessionPath?: string): Promise<SyncExportSessionResult>
  importSession(): Promise<SyncImportSessionResult>
}
