/**
 * 跨设备同步的 IPC 适配（`yan:sync:*`，WP-53 接线层）。
 *
 * 分工：
 *   · 同步算法全在 `src/main/sync/**`（SyncService）；本文件只把它接到 registrar 上，
 *     并把需要宿主能力的部分（目录 / 文件对话框、当前会话路径、启动时机）作为窄接口注入。
 *   · 本文件不 import Electron、不 import 主进程入口：可以用假 SyncService + 假对话框
 *     直接单测（见 scripts/test-v3-sync-ipc.mjs）。
 *
 * 约定：
 *   · 同步目录配置存在数据目录的 `sync-config.json`（SyncConfigStore），**不参与同步**；
 *   · 任何单项失败都返回可读错误，不让 IPC 抛异常到渲染端；
 *   · `runStartupSync()` 只记日志，不阻塞启动、不弹窗。
 */
import { basename } from 'node:path'
import type { IpcRegistrar } from './registrar'
import { SyncConfigStore } from '../sync/config'
import { exportSession, importSession } from '../sync/session-transfer'
import type { ConflictRecord, SyncReport } from '../sync/types'
import type {
  SyncConflictView,
  SyncConfigureResult,
  SyncExportSessionResult,
  SyncImportSessionResult,
  SyncNowResult,
  SyncResolution,
  SyncResolveResult,
  SyncStatusView
} from '../../shared/sync'

/** 接线层用到的同步核心窄接口；真实 `SyncService` 结构上满足它。 */
export interface SyncServiceLike {
  sync(): Promise<SyncReport>
  listConflicts(): Promise<ConflictRecord[]>
  resolveConflict(id: string, resolution: SyncResolution): Promise<{ ok: boolean; error?: string }>
}

export interface SyncIpcDeps {
  /** 本机数据目录（`YAN_DIR`）。 */
  dataDir: string
  /** pi 的会话目录；导入会话的落点。 */
  sessionsDir: string
  /** 为给定同步目录构造同步服务；测试可注入假实现。 */
  makeService(syncRoot: string): SyncServiceLike
  /** 弹出「选择同步文件夹」对话框；取消返回 null。 */
  pickSyncFolder(): Promise<string | null>
  /** 弹出「把会话导出到」对话框；取消返回 null。 */
  pickExportPath(suggestedFileName: string): Promise<string | null>
  /** 弹出「选择会话包」对话框；取消返回 null。 */
  pickImportFile(): Promise<string | null>
  /** 当前活动会话文件；没有时返回 undefined。 */
  currentSessionPath?(): string | undefined
  /** 配置存储；缺省按 dataDir 创建。 */
  config?: SyncConfigStore
  now?: () => number
  /** 启动同步的日志出口；缺省 console.warn。 */
  log?: (message: string, error?: unknown) => void
}

/** 注册后返回的句柄：`runStartupSync()` 由主进程在就绪后调用。 */
export interface SyncController {
  runStartupSync(): Promise<void>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function summarize(report: SyncReport): {
  at: number
  ok: boolean
  pushed: number
  pulled: number
  conflicts: number
  skipped: number
  errors: string[]
} {
  return {
    at: report.at,
    ok: report.ok,
    pushed: report.pushed.length,
    pulled: report.pulled.length,
    conflicts: report.conflicts.length,
    skipped: report.skipped.length,
    errors: report.errors
  }
}

/** 冲突内容短预览：压平空白并截断，避免把整段提示词 / 设置塞进界面。 */
function preview(payload: string | undefined): string | undefined {
  if (typeof payload !== 'string') return undefined
  const flat = payload.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

function toView(conflict: ConflictRecord): SyncConflictView {
  const localPreview = preview(conflict.localPayload)
  const remotePreview = preview(conflict.remotePayload)
  return {
    id: conflict.id,
    key: conflict.key,
    kind: conflict.kind,
    detectedAt: conflict.detectedAt,
    ...(conflict.localDeviceName ? { localDeviceName: conflict.localDeviceName } : {}),
    remoteDeviceName: conflict.remoteDeviceName,
    ...(conflict.localModifiedAt !== undefined ? { localModifiedAt: conflict.localModifiedAt } : {}),
    remoteModifiedAt: conflict.remoteModifiedAt,
    suffix: conflict.suffix,
    ...(localPreview ? { localPreview } : {}),
    ...(remotePreview ? { remotePreview } : {})
  }
}

function isResolution(value: unknown): value is SyncResolution {
  return value === 'local' || value === 'remote' || value === 'both'
}

/**
 * 启动时同步一次：只在已配置同步目录时动作，失败只记日志。
 * 供主进程在窗口 / 设置就绪后调用，不得阻塞正常启动。
 */
export async function runStartupSync(deps: SyncIpcDeps, injected?: SyncConfigStore): Promise<void> {
  const config = injected ?? deps.config ?? new SyncConfigStore(deps.dataDir)
  const log = deps.log ?? ((message: string, error?: unknown) => console.warn(message, error ?? ''))
  try {
    const current = await config.read()
    if (!current.syncRoot) return
    const report = await deps.makeService(current.syncRoot).sync()
    await config.recordSync(summarize(report))
    if (!report.ok || report.errors.length) {
      log(`[sync] 启动同步未完成：${report.errors.join('；') || '同步目录不可用'}`, undefined)
    }
  } catch (error) {
    log('[sync] 启动同步失败', error)
  }
}

/**
 * 注册 `yan:sync:*`。返回的控制器带 `runStartupSync()`，与注册共用同一份配置存储。
 */
export function registerSyncIpc(ipc: IpcRegistrar, deps: SyncIpcDeps): SyncController {
  const { handle } = ipc
  const config = deps.config ?? new SyncConfigStore(deps.dataDir)
  const now = deps.now ?? Date.now

  const configuredService = async (): Promise<SyncServiceLike | null> => {
    const current = await config.read()
    return current.syncRoot ? deps.makeService(current.syncRoot) : null
  }

  handle('yan:sync:status', async (): Promise<SyncStatusView> => {
    try {
      const current = await config.read()
      const status: SyncStatusView = {
        configured: Boolean(current.syncRoot),
        ...(current.syncRoot ? { syncRoot: current.syncRoot } : {}),
        ...(current.lastSync ? { lastSync: current.lastSync } : {}),
        conflictCount: 0
      }
      if (current.syncRoot) {
        try {
          status.conflictCount = (await deps.makeService(current.syncRoot).listConflicts()).length
        } catch (error) {
          status.error = describe(error)
        }
      }
      return status
    } catch (error) {
      return { configured: false, conflictCount: 0, error: describe(error) }
    }
  })

  handle('yan:sync:configure', async (root?: unknown): Promise<SyncConfigureResult> => {
    try {
      /* null = 清除；字符串 = 直接设置；其它 / 缺省 = 弹目录对话框。 */
      if (root === null) {
        const next = await config.setSyncRoot(undefined)
        return { ok: true, ...(next.syncRoot ? { syncRoot: next.syncRoot } : {}) }
      }
      let target = typeof root === 'string' ? root.trim() : ''
      if (!target) {
        const picked = await deps.pickSyncFolder()
        if (!picked) return { ok: false, cancelled: true }
        target = picked
      }
      const next = await config.setSyncRoot(target)
      return { ok: true, ...(next.syncRoot ? { syncRoot: next.syncRoot } : {}) }
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  })

  handle('yan:sync:now', async (): Promise<SyncNowResult> => {
    const current = await config.read()
    if (!current.syncRoot) {
      return { ok: false, pushed: 0, pulled: 0, conflicts: 0, skipped: 0, errors: [], error: '还没有配置同步文件夹' }
    }
    try {
      const report = await deps.makeService(current.syncRoot).sync()
      await config.recordSync(summarize(report))
      return {
        ok: report.ok,
        pushed: report.pushed.length,
        pulled: report.pulled.length,
        conflicts: report.conflicts.length,
        skipped: report.skipped.length,
        errors: report.errors,
        at: report.at
      }
    } catch (error) {
      return { ok: false, pushed: 0, pulled: 0, conflicts: 0, skipped: 0, errors: [], error: describe(error) }
    }
  })

  handle('yan:sync:conflicts', async (): Promise<SyncConflictView[]> => {
    try {
      const service = await configuredService()
      if (!service) return []
      return (await service.listConflicts()).map(toView)
    } catch {
      /* 列冲突失败不炸页面：返回空表，状态区会看到错误。 */
      return []
    }
  })

  handle('yan:sync:resolve', async (id: unknown, resolution: unknown): Promise<SyncResolveResult> => {
    const conflictId = typeof id === 'string' ? id.trim() : ''
    if (!conflictId) return { ok: false, error: '缺少冲突编号' }
    if (!isResolution(resolution)) return { ok: false, error: '未知的处理方式' }
    try {
      const service = await configuredService()
      if (!service) return { ok: false, error: '还没有配置同步文件夹' }
      return await service.resolveConflict(conflictId, resolution)
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  })

  handle('yan:sync:exportSession', async (sessionPath?: unknown): Promise<SyncExportSessionResult> => {
    try {
      const requested = typeof sessionPath === 'string' && sessionPath ? sessionPath : undefined
      const source = requested ?? deps.currentSessionPath?.()
      if (!source) return { ok: false, error: '当前没有可导出的会话' }
      const suggested = `${basename(source).replace(/\.jsonl$/i, '')}.inkstone-session.json`
      const target = await deps.pickExportPath(suggested)
      if (!target) return { ok: false, cancelled: true, error: '已取消导出' }
      const result = await exportSession(source, target, { now })
      return result.ok ? { ok: true, path: result.path, bytes: result.bytes } : { ok: false, error: result.error }
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  })

  handle('yan:sync:importSession', async (): Promise<SyncImportSessionResult> => {
    try {
      const bundle = await deps.pickImportFile()
      if (!bundle) return { ok: false, cancelled: true, error: '已取消导入' }
      const result = await importSession(bundle, deps.sessionsDir)
      return result.ok
        ? { ok: true, path: result.path, sessionId: result.sessionId }
        : { ok: false, error: result.error }
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  })

  return { runStartupSync: () => runStartupSync(deps, config) }
}
