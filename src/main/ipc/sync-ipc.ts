import { basename } from 'node:path'
import type { IpcRegistrar } from './registrar'
import { SyncConfigStore } from '../sync/config'
import { exportSession, importSession } from '../sync/session-transfer'
import { validateSyncRoot } from '../sync/sync-folder'
import type { ConflictRecord, SyncReport } from '../sync/types'
import {
  AUTO_SYNC_INTERVAL_MS,
  isSyncMode,
  syncNote,
  type SyncConflictView,
  type SyncConfigureResult,
  type SyncExportSessionResult,
  type SyncImportSessionResult,
  type SyncNote,
  type SyncNowResult,
  type SyncResolution,
  type SyncResolveResult,
  type SyncSetModeResult,
  type SyncStatusView
} from '../../shared/sync'

export interface SyncServiceLike {
  sync(): Promise<SyncReport>
  listConflicts(): Promise<ConflictRecord[]>
  countConflicts(): Promise<number>
  resolveConflict(id: string, resolution: SyncResolution): Promise<{ ok: boolean; error?: SyncNote }>
}

export interface SyncIpcDeps {
  dataDir: string
  sessionsDir: string
  makeService(syncRoot: string): SyncServiceLike
  pickSyncFolder(): Promise<string | null>
  pickExportPath(suggestedFileName: string): Promise<string | null>
  pickImportFile(): Promise<string | null>
  currentSessionPath?(): string | undefined
  config?: SyncConfigStore
  now?: () => number
  autoIntervalMs?: number
  log?: (message: string, error?: unknown) => void
}

export interface SyncController {
  start(): void
  stop(): void
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
  errors: SyncNote[]
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

export async function runAutoSync(deps: SyncIpcDeps, injected?: SyncConfigStore): Promise<void> {
  const config = injected ?? deps.config ?? new SyncConfigStore(deps.dataDir)
  const log = deps.log ?? ((message: string, error?: unknown) => console.warn(message, error ?? ''))
  try {
    const current = await config.read()
    if (!current.syncRoot || current.mode !== 'auto') return
    const report = await deps.makeService(current.syncRoot).sync()
    await config.recordSync(summarize(report))
    if (!report.ok || report.errors.length) {
      log(`[sync] 自动同步未完成：${report.errors.map((note) => note.code).join('; ') || '同步目录不可用'}`, undefined)
    }
  } catch (error) {
    log('[sync] 自动同步失败', error)
  }
}

export function registerSyncIpc(ipc: IpcRegistrar, deps: SyncIpcDeps): SyncController {
  const { handle } = ipc
  const config = deps.config ?? new SyncConfigStore(deps.dataDir)
  const now = deps.now ?? Date.now
  const autoIntervalMs = deps.autoIntervalMs ?? AUTO_SYNC_INTERVAL_MS
  let queue: Promise<unknown> = Promise.resolve()
  let timer: ReturnType<typeof setInterval> | null = null

  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }
  const autoSync = (): Promise<void> => exclusive(() => runAutoSync(deps, config))

  const configuredService = async (): Promise<SyncServiceLike | null> => {
    const current = await config.read()
    return current.syncRoot ? deps.makeService(current.syncRoot) : null
  }

  handle('yan:sync:status', async (): Promise<SyncStatusView> => {
    try {
      const current = await config.read()
      const status: SyncStatusView = {
        configured: Boolean(current.syncRoot),
        mode: current.mode,
        autoIntervalMs,
        ...(current.syncRoot ? { syncRoot: current.syncRoot } : {}),
        ...(current.lastSync ? { lastSync: current.lastSync } : {}),
        conflictCount: 0
      }
      if (current.syncRoot) {
        try {
          status.conflictCount = await deps.makeService(current.syncRoot).countConflicts()
        } catch (error) {
          status.error = syncNote('unknown', { reason: describe(error) })
        }
      }
      return status
    } catch (error) {
      return { configured: false, mode: 'manual', autoIntervalMs, conflictCount: 0, error: syncNote('unknown', { reason: describe(error) }) }
    }
  })

  handle('yan:sync:setMode', async (mode?: unknown): Promise<SyncSetModeResult> => {
    if (!isSyncMode(mode)) return { ok: false, error: syncNote('mode.unknown') }
    try {
      const next = await config.setMode(mode)
      return { ok: true, mode: next.mode }
    } catch (error) {
      return { ok: false, error: syncNote('unknown', { reason: describe(error) }) }
    }
  })

  handle('yan:sync:configure', async (root?: unknown): Promise<SyncConfigureResult> => {
    try {
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
      const invalid = await validateSyncRoot(target)
      if (invalid) return { ok: false, error: invalid }
      const next = await config.setSyncRoot(target)
      return { ok: true, ...(next.syncRoot ? { syncRoot: next.syncRoot } : {}) }
    } catch (error) {
      return { ok: false, error: syncNote('unknown', { reason: describe(error) }) }
    }
  })

  handle('yan:sync:now', async (): Promise<SyncNowResult> => {
    const current = await config.read()
    if (!current.syncRoot) {
      return { ok: false, pushed: 0, pulled: 0, conflicts: 0, skipped: 0, errors: [], error: syncNote('config.missing') }
    }
    const syncRoot = current.syncRoot
    try {
      const report = await exclusive(async () => {
        const result = await deps.makeService(syncRoot).sync()
        await config.recordSync(summarize(result))
        return result
      })
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
      return { ok: false, pushed: 0, pulled: 0, conflicts: 0, skipped: 0, errors: [], error: syncNote('unknown', { reason: describe(error) }) }
    }
  })

  handle('yan:sync:conflicts', async (): Promise<SyncConflictView[]> => {
    try {
      const service = await configuredService()
      if (!service) return []
      return (await service.listConflicts()).map(toView)
    } catch {
      return []
    }
  })

  handle('yan:sync:resolve', async (id: unknown, resolution: unknown): Promise<SyncResolveResult> => {
    const conflictId = typeof id === 'string' ? id.trim() : ''
    if (!conflictId) return { ok: false, error: syncNote('conflict.missing') }
    if (!isResolution(resolution)) return { ok: false, error: syncNote('resolution.unknown') }
    try {
      return await exclusive(async () => {
        const service = await configuredService()
        if (!service) return { ok: false, error: syncNote('config.missing') }
        return service.resolveConflict(conflictId, resolution)
      })
    } catch (error) {
      return { ok: false, error: syncNote('unknown', { reason: describe(error) }) }
    }
  })

  handle('yan:sync:exportSession', async (sessionPath?: unknown): Promise<SyncExportSessionResult> => {
    try {
      const requested = typeof sessionPath === 'string' && sessionPath ? sessionPath : undefined
      const source = requested ?? deps.currentSessionPath?.()
      if (!source) return { ok: false, error: syncNote('session.missing') }
      const suggested = `${basename(source).replace(/\.jsonl$/i, '')}.inkstone-session.json`
      const target = await deps.pickExportPath(suggested)
      if (!target) return { ok: false, cancelled: true, error: syncNote('session.cancelled') }
      const result = await exportSession(source, target, { now })
      return result.ok
        ? { ok: true, path: result.path, bytes: result.bytes }
        : { ok: false, error: syncNote('session.exportFailed', { reason: result.error }) }
    } catch (error) {
      return { ok: false, error: syncNote('session.exportFailed', { reason: describe(error) }) }
    }
  })

  handle('yan:sync:importSession', async (): Promise<SyncImportSessionResult> => {
    try {
      const bundle = await deps.pickImportFile()
      if (!bundle) return { ok: false, cancelled: true, error: syncNote('session.cancelled') }
      const result = await importSession(bundle, deps.sessionsDir)
      return result.ok
        ? { ok: true, path: result.path, sessionId: result.sessionId }
        : { ok: false, error: syncNote('session.importFailed', { reason: result.error }) }
    } catch (error) {
      return { ok: false, error: syncNote('session.importFailed', { reason: describe(error) }) }
    }
  })

  return {
    start: () => {
      if (timer) return
      void autoSync()
      timer = setInterval(() => void autoSync(), autoIntervalMs)
      timer.unref?.()
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}
