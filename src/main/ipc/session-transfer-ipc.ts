import { basename } from 'node:path'
import type { IpcRegistrar } from './registrar'
import { exportSession, importSession, SESSION_TRANSFER_MAX_BYTES } from '../session-transfer'
import { atomicWriteFile } from '../atomic-write'
import { pick } from '../../shared/ui-lang'
import { sessionMarkdown } from '../../shared/session-markdown'
import type { UIMessage } from '../../shared/ui-message'
import { SESSION_EXPORT_EXTENSIONS, isSessionExportFormat } from '../../shared/session-transfer'
import type { SessionExportFormat, SessionExportResult, SessionImportResult, SessionMarkdownResult } from '../../shared/session-transfer'

export interface SessionTransferIpcDeps {
  sessionsDir: string
  pickExportPath(suggestedFileName: string, format: SessionExportFormat): Promise<string | null>
  pickImportFile(): Promise<string | null>
  currentSessionPath?(): string | undefined
  readMessages?(sessionPath: string): Promise<{ messages: UIMessage[]; cwd?: string } | null>
  reveal?(path: string): void
  now?: () => number
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const exportFailed = (reason: string): string => pick(`导出会话失败：${reason}`, `Could not export the session: ${reason}`)
const importFailed = (reason: string): string => pick(`导入会话失败：${reason}`, `Could not import the session: ${reason}`)
const unsupported = (): string => pick('当前环境不支持这种导出格式', 'This export format is not available here')

function fileStem(title: string): string {
  return title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .slice(0, 80)
    .trim()
}

function withExtension(path: string, extension: string): string {
  return path.toLowerCase().endsWith(extension) ? path : `${path}${extension}`
}

export function registerSessionTransferIpc(ipc: IpcRegistrar, deps: SessionTransferIpcDeps): void {
  const { handle } = ipc
  const now = deps.now ?? Date.now

  const markdownOf = async (source: string, title: string): Promise<string | null> => {
    const history = await deps.readMessages?.(source)
    if (!history) return null
    return sessionMarkdown(history.messages, { title, exportedAt: now(), ...(history.cwd ? { cwd: history.cwd } : {}) })
  }
  const unreadable = (): string => exportFailed(deps.readMessages ? pick('读不到这个会话的记录', 'Could not read this session') : unsupported())

  handle('yan:sessionTransfer:markdown', async (sessionPath: unknown, rawTitle?: unknown): Promise<SessionMarkdownResult> => {
    try {
      if (typeof sessionPath !== 'string' || !sessionPath) return { ok: false, error: unreadable() }
      const title = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
      const markdown = await markdownOf(sessionPath, title || basename(sessionPath).replace(/\.jsonl$/i, ''))
      return markdown === null ? { ok: false, error: unreadable() } : { ok: true, markdown }
    } catch (error) {
      return { ok: false, error: exportFailed(describe(error)) }
    }
  })

  handle('yan:sessionTransfer:export', async (sessionPath?: unknown, rawOptions?: unknown): Promise<SessionExportResult> => {
    try {
      const options = rawOptions && typeof rawOptions === 'object' ? (rawOptions as Record<string, unknown>) : {}
      const format = isSessionExportFormat(options.format) ? options.format : 'bundle'
      const title = typeof options.title === 'string' ? options.title.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
      const requested = typeof sessionPath === 'string' && sessionPath ? sessionPath : undefined
      const source = requested ?? deps.currentSessionPath?.()
      if (!source) return { ok: false, error: pick('当前没有可导出的会话。', 'There is no current session to export.') }
      const stem = fileStem(title) || basename(source).replace(/\.jsonl$/i, '')
      let text: string | null = null
      if (format === 'markdown') {
        text = await markdownOf(source, title || stem)
        if (text === null) return { ok: false, error: unreadable() }
      } else if (format === 'html') {
        if (typeof options.html !== 'string' || !options.html) return { ok: false, error: exportFailed(unsupported()) }
        if (Buffer.byteLength(options.html, 'utf8') > SESSION_TRANSFER_MAX_BYTES) return { ok: false, error: exportFailed(pick('会话过大，超过单次导出上限 64MB', 'Session is too large; exceeds the 64MB export limit')) }
        text = options.html
      }
      const target = await deps.pickExportPath(`${stem}${SESSION_EXPORT_EXTENSIONS[format]}`, format)
      if (!target) return { ok: false, cancelled: true }
      let done: SessionExportResult
      if (text !== null) {
        const file = withExtension(target, SESSION_EXPORT_EXTENSIONS[format])
        await atomicWriteFile(file, text)
        done = { ok: true, path: file, bytes: Buffer.byteLength(text, 'utf8') }
      } else {
        const result = await exportSession(source, target, { now })
        done = result.ok ? { ok: true, path: result.path, bytes: result.bytes } : { ok: false, error: exportFailed(result.error) }
      }
      if (done.ok && done.path && options.reveal === true) deps.reveal?.(done.path)
      return done
    } catch (error) {
      return { ok: false, error: exportFailed(describe(error)) }
    }
  })

  handle('yan:sessionTransfer:import', async (filePath?: unknown): Promise<SessionImportResult> => {
    try {
      if (filePath !== undefined && (typeof filePath !== 'string' || !/\.json$/i.test(filePath))) {
        return { ok: false, error: importFailed(pick('只能导入 .json 会话包', 'Only .json session bundles can be imported')) }
      }
      const bundle = typeof filePath === 'string' ? filePath : await deps.pickImportFile()
      if (!bundle) return { ok: false, cancelled: true }
      const result = await importSession(bundle, deps.sessionsDir)
      return result.ok ? { ok: true, path: result.path, sessionId: result.sessionId } : { ok: false, error: importFailed(result.error) }
    } catch (error) {
      return { ok: false, error: importFailed(describe(error)) }
    }
  })
}
