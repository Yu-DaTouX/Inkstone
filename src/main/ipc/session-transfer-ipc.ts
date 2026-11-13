import { basename } from 'node:path'
import type { IpcRegistrar } from './registrar'
import { exportSession, importSession } from '../session-transfer'
import { pick } from '../../shared/ui-lang'
import type { SessionExportResult, SessionImportResult } from '../../shared/session-transfer'

export interface SessionTransferIpcDeps {
  sessionsDir: string
  pickExportPath(suggestedFileName: string): Promise<string | null>
  pickImportFile(): Promise<string | null>
  currentSessionPath?(): string | undefined
  now?: () => number
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const exportFailed = (reason: string): string => pick(`导出会话失败：${reason}`, `Could not export the session: ${reason}`)
const importFailed = (reason: string): string => pick(`导入会话失败：${reason}`, `Could not import the session: ${reason}`)

export function registerSessionTransferIpc(ipc: IpcRegistrar, deps: SessionTransferIpcDeps): void {
  const { handle } = ipc
  const now = deps.now ?? Date.now

  handle('yan:sessionTransfer:export', async (sessionPath?: unknown): Promise<SessionExportResult> => {
    try {
      const requested = typeof sessionPath === 'string' && sessionPath ? sessionPath : undefined
      const source = requested ?? deps.currentSessionPath?.()
      if (!source) return { ok: false, error: pick('当前没有可导出的会话。', 'There is no current session to export.') }
      const suggested = `${basename(source).replace(/\.jsonl$/i, '')}.inkstone-session.json`
      const target = await deps.pickExportPath(suggested)
      if (!target) return { ok: false, cancelled: true }
      const result = await exportSession(source, target, { now })
      return result.ok ? { ok: true, path: result.path, bytes: result.bytes } : { ok: false, error: exportFailed(result.error) }
    } catch (error) {
      return { ok: false, error: exportFailed(describe(error)) }
    }
  })

  handle('yan:sessionTransfer:import', async (): Promise<SessionImportResult> => {
    try {
      const bundle = await deps.pickImportFile()
      if (!bundle) return { ok: false, cancelled: true }
      const result = await importSession(bundle, deps.sessionsDir)
      return result.ok ? { ok: true, path: result.path, sessionId: result.sessionId } : { ok: false, error: importFailed(result.error) }
    } catch (error) {
      return { ok: false, error: importFailed(describe(error)) }
    }
  })
}
