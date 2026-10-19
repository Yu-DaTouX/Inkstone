import type { IpcRegistrar } from './registrar'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { getSettings } from '../settings'
import { completePath } from '../credentials'
import { listDir } from '../files'
import { grantFiles, readGrantedText, readPreview, statPreview } from '../file-refs'
import { filesWatcher } from '../files-watch'
import { attachmentsUsage, listSessionFiles, pruneAttachments, referencedAttachmentNames } from '../attachments'
import { PI_AGENT_DIR, YAN_DIR } from '../paths'
import { htmlArtifactPreviews } from '../html-artifact-preview'
import type { FileRequestContext } from '../../shared/ipc'

export type FileContextResult =
  | { ok: true; context: FileRequestContext }
  | { ok: false; context: FileRequestContext; error: string }


function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const watchIdsBySender = new Map<number, Set<string>>()

function watchIdsFor(sender: Electron.WebContents): Set<string> {
  const existing = watchIdsBySender.get(sender.id)
  if (existing) return existing
  const ids = new Set<string>()
  watchIdsBySender.set(sender.id, ids)
  sender.once('destroyed', () => {
    watchIdsBySender.delete(sender.id)
    for (const id of ids) filesWatcher.release(id)
  })
  return ids
}

export interface FilesIpcDeps {
  isSessionBusy(): boolean
  resolveFileContext(settings: Awaited<ReturnType<typeof getSettings>>, fallbackCwd: string, rawContext: unknown): Promise<FileContextResult>
}

export function registerFilesIpc(ipc: IpcRegistrar, deps: FilesIpcDeps): void {
  const { handle, rawHandle } = ipc
  const { resolveFileContext } = deps
  handle('yan:completePath', async (prefix: string, requestedCwd?: string, rawContext?: unknown) => {
    const st = await getSettings()
    const resolved = await resolveFileContext(st, typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd : st.cwd, rawContext)
    if (!resolved.ok) {
      return { paths: [], truncated: false, status: 'invalid' as const, request: resolved.context }
    }
    return completePath(resolved.context.cwd, String(prefix ?? ''), resolved.context)
  })

  handle('yan:describeFiles', async (paths: string[]) => grantFiles(paths))
  handle('yan:readFileText', async (p: string) => readGrantedText(String(p ?? '')))
  handle('yan:prepareHtmlArtifact', (path: string) => htmlArtifactPreviews.prepare(path))
  handle('yan:prepareHtmlWidget', (html: unknown) => htmlArtifactPreviews.prepareInline(html))
  handle('yan:releaseHtmlArtifact', (url: string) => htmlArtifactPreviews.release(String(url ?? '')))
  handle('yan:readPreview', async (p: string, line?: number, requestedCwd?: string, lineEnd?: number) => {
    const s = await getSettings()
    const resolved = await resolveFileContext(s, s.cwd, { cwd: requestedCwd ?? s.cwd })
    if (!resolved.ok) {
      return { ok: false, path: String(p ?? ''), abs: '', name: '', size: 0, kind: 'other' as const, error: resolved.error }
    }
    return readPreview(
      String(p ?? ''),
      resolved.context.cwd,
      typeof line === 'number' ? line : undefined,
      typeof lineEnd === 'number' ? lineEnd : undefined
    )
  })
  handle('yan:statPreview', async (p: string, requestedCwd?: string) => {
    const s = await getSettings()
    const resolved = await resolveFileContext(s, s.cwd, { cwd: requestedCwd ?? s.cwd })
    if (!resolved.ok) return { ok: false, abs: '', mtimeMs: 0, size: 0, error: resolved.error }
    return statPreview(String(p ?? ''), resolved.context.cwd)
  })

  rawHandle('yan:listDir', async (_e, rel: unknown, showHidden: unknown, rawContext: unknown) => {
    const s = await getSettings()
    const context = isObject(rawContext) ? rawContext : undefined
    const requestedCwd = context && typeof context.cwd === 'string' ? context.cwd : s.cwd
    const resolved = await resolveFileContext(s, requestedCwd, context)
    if (!resolved.ok) {
      return {
        path: typeof rel === 'string' ? rel : '',
        abs: '',
        entries: [],
        skipped: [],
        truncated: false,
        status: 'invalid' as const,
        error: resolved.error,
        request: resolved.context
      }
    }
    return listDir(resolved.context.cwd, typeof rel === 'string' ? rel : '', showHidden === true, resolved.context)
  })

  rawHandle('yan:files:watch', async (event, rawId: unknown, rawDirs: unknown, rawContext: unknown) => {
    const watchId = typeof rawId === 'string' ? rawId : ''
    if (!watchId) return { dirs: [], dropped: [] }
    const s = await getSettings()
    const context = isObject(rawContext) ? rawContext : undefined
    const requestedCwd = context && typeof context.cwd === 'string' ? context.cwd : s.cwd
    const resolved = await resolveFileContext(s, requestedCwd, context)
    if (!resolved.ok) {
      filesWatcher.release(watchId)
      return { dirs: [], dropped: [] }
    }
    const dirs = Array.isArray(rawDirs) ? rawDirs.filter((dir): dir is string => typeof dir === 'string') : []
    const sender = event.sender
    watchIdsFor(sender).add(watchId)
    return filesWatcher.set(watchId, resolved.context.cwd, dirs, (dir) => {
      if (sender.isDestroyed()) return
      sender.send('yan:push', { ch: 'files-changed', payload: { watchId, dir } })
    })
  })

  handle('yan:attachments:usage', () => attachmentsUsage(join(YAN_DIR, 'attachments')))
  handle('yan:attachments:prune', async () => {
    if (deps.isSessionBusy()) throw new Error('会话正在运行，请结束后再清理附件')
    const before = Date.now()
    const sessionsDir = join(PI_AGENT_DIR, 'sessions')
    if (!existsSync(sessionsDir)) return { removed: 0, bytes: 0, kept: 0 }
    const fingerprint = (): string => JSON.stringify(listSessionFiles(sessionsDir).sort().flatMap((path) => {
      try {
        const st = statSync(path)
        return [[path, st.size, st.mtimeMs, st.ctimeMs]]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    }))
    const initial = fingerprint()
    const referenced = await referencedAttachmentNames(listSessionFiles(sessionsDir))
    if (deps.isSessionBusy() || initial !== fingerprint()) throw new Error('会话在扫描期间发生变化，已停止附件清理，请稍后重试')
    return pruneAttachments(join(YAN_DIR, 'attachments'), referenced, { before })
  })
}
