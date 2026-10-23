import type { IpcRegistrar } from './registrar'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { getSettings } from '../settings'
import { completePath } from '../credentials'
import { listDir, searchFiles } from '../files'
import { searchFileContents } from '../file-content-search'
import { readEditableFile, writeEditableFile } from '../file-editor'
import { grantFiles, readGrantedText, readPreview, readPreviewBytes, statPreview } from '../file-refs'
import { filesWatcher } from '../files-watch'
import { unsavedFiles } from '../unsaved-files'
import { searchFileNames } from '../file-name-search'
import type { FileNameSearchRequest } from '../../shared/file-name-search'
import { attachmentsUsage, listSessionFiles, pruneAttachments, referencedAttachmentNames } from '../attachments'
import { clearSessionReadCache } from '../session-reader'
import { PI_AGENT_DIR, YAN_DIR } from '../paths'
import { htmlArtifactPreviews } from '../html-artifact-preview'
import type {
  FileContentSearchRequest,
  FileRequestContext,
  FileSearchRequest
} from '../../shared/ipc'

export type FileContextResult =
  | { ok: true; context: FileRequestContext }
  | { ok: false; context: FileRequestContext; error: string }


function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSearchRequest(value: unknown): value is Record<string, unknown> {
  return isObject(value) && typeof value.requestId === 'string' && typeof value.query === 'string'
}

function searchRequestFields(value: Record<string, unknown> | undefined): { requestId: string; query: string; limit?: number } {
  const requestId = value && typeof value.requestId === 'string' ? value.requestId : ''
  const query = value && typeof value.query === 'string' ? value.query : ''
  const limit = value && typeof value.limit === 'number' && Number.isFinite(value.limit) ? value.limit : undefined
  return { requestId, query, ...(limit !== undefined ? { limit } : {}) }
}

function contentSearchOptions(value: Record<string, unknown> | undefined): Pick<FileContentSearchRequest, 'matchCase' | 'wholeWord' | 'regexp'> {
  return {
    matchCase: value?.matchCase === true,
    wholeWord: value?.wholeWord === true,
    regexp: value?.regexp === true
  }
}

const watchIdsBySender = new Map<number, Set<string>>()
const unsavedSenders = new Set<number>()
const searchControllers = new Map<string, AbortController>()
const searchSenderIds = new Set<number>()
const PRUNE_FINGERPRINT_BATCH = 32

function searchAbortController(sender: Electron.WebContents, scope: string): AbortController {
  const key = `${sender.id}:${scope}`
  searchControllers.get(key)?.abort('superseded')
  const controller = new AbortController()
  searchControllers.set(key, controller)
  if (!searchSenderIds.has(sender.id)) {
    searchSenderIds.add(sender.id)
    sender.once('destroyed', () => {
      searchSenderIds.delete(sender.id)
      for (const [key, ctl] of searchControllers) {
        if (!key.startsWith(`${sender.id}:`)) continue
        searchControllers.delete(key)
        ctl.abort('disposed')
      }
    })
  }
  return controller
}

function releaseSearchController(sender: Electron.WebContents, scope: string, controller: AbortController): void {
  const key = `${sender.id}:${scope}`
  if (searchControllers.get(key) === controller) searchControllers.delete(key)
}

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
  handle('yan:prepareHtmlArtifact', async (path: string, requestedCwd?: string) => {
    if (typeof requestedCwd !== 'string' || !requestedCwd.trim()) return htmlArtifactPreviews.prepare(String(path ?? ''))
    const st = await getSettings()
    const resolved = await resolveFileContext(st, st.cwd, { cwd: requestedCwd })
    if (!resolved.ok) return { ok: false as const, error: 'read' as const }
    return htmlArtifactPreviews.prepareForWorkspace(String(path ?? ''), resolved.context.cwd)
  })
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
  handle('yan:readPreviewBytes', async (p: string, requestedCwd?: string) => {
    const s = await getSettings()
    const resolved = await resolveFileContext(s, s.cwd, { cwd: requestedCwd ?? s.cwd })
    if (!resolved.ok) {
      return { ok: false, abs: '', name: '', size: 0, error: resolved.error, issue: 'invalid' as const }
    }
    return readPreviewBytes(String(p ?? ''), resolved.context.cwd)
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

  rawHandle('yan:searchFiles', async (event, rawRequest: unknown) => {
    const s = await getSettings()
    const request = isObject(rawRequest) ? rawRequest : undefined
    const requestedCwd = request && typeof request.cwd === 'string' ? request.cwd : s.cwd
    const resolved = await resolveFileContext(s, requestedCwd, request)
    const finalRequest: FileSearchRequest = { ...resolved.context, ...searchRequestFields(request) }
    if (!resolved.ok || !isSearchRequest(request)) {
      return { request: finalRequest, entries: [], status: 'invalid' as const, truncated: false, scannedDirs: 0, skippedDirs: 0 }
    }
    const controller = searchAbortController(event.sender, 'names')
    try {
      return await searchFiles(finalRequest, controller.signal)
    } finally {
      releaseSearchController(event.sender, 'names', controller)
    }
  })

  rawHandle('yan:files:searchNames', async (event, rawRequest: unknown) => {
    const s = await getSettings()
    const request = isObject(rawRequest) ? rawRequest : undefined
    const requestedCwd = request && typeof request.cwd === 'string' ? request.cwd : s.cwd
    const resolved = await resolveFileContext(s, requestedCwd, request)
    const scope = request && typeof request.scope === 'string' ? request.scope.slice(0, 64) : 'default'
    const finalRequest: FileNameSearchRequest = { ...resolved.context, ...searchRequestFields(request), scope }
    if (!resolved.ok || !isSearchRequest(request)) {
      return { request: finalRequest, matches: [], truncated: false, source: 'none' as const, scanned: 0, error: { code: 'invalid' as const } }
    }
    return searchFileNames(`${event.sender.id}:${scope}`, finalRequest)
  })

  rawHandle('yan:searchFileContents',async (event, rawRequest: unknown) => {
    const s = await getSettings()
    const request = isObject(rawRequest) ? rawRequest : undefined
    const requestedCwd = request && typeof request.cwd === 'string' ? request.cwd : s.cwd
    const resolved = await resolveFileContext(s, requestedCwd, request)
    const finalRequest: FileContentSearchRequest = { ...resolved.context, ...searchRequestFields(request), ...contentSearchOptions(request) }
    if (!resolved.ok || !isSearchRequest(request)) {
      return { request: finalRequest, hits: [], status: 'invalid' as const, truncated: false, scannedFiles: 0, skippedFiles: 0 }
    }
    const controller = searchAbortController(event.sender, 'content')
    try {
      return await searchFileContents(finalRequest, { signal: controller.signal })
    } finally {
      releaseSearchController(event.sender, 'content', controller)
    }
  })

  handle('yan:readEditableFile', async (p: unknown, requestedCwd?: unknown) => {
    if (typeof p !== 'string' || !p.trim()) {
      return { ok: false as const, abs: '', name: '', text: '', hash: '', size: 0, mtimeMs: 0, error: 'denied' as const }
    }
    const s = await getSettings()
    const fallbackCwd = typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd : s.cwd
    const resolved = await resolveFileContext(s, s.cwd, { cwd: fallbackCwd })
    if (!resolved.ok) {
      return { ok: false as const, abs: '', name: '', text: '', hash: '', size: 0, mtimeMs: 0, error: 'denied' as const }
    }
    return readEditableFile(resolved.context.cwd, p)
  })

  handle('yan:writeEditableFile', async (p: unknown, text: unknown, expectedHash: unknown, requestedCwd?: unknown) => {
    const hashOk = expectedHash === null || (typeof expectedHash === 'string' && /^[0-9a-f]{64}$/.test(expectedHash))
    if (typeof p !== 'string' || !p.trim() || typeof text !== 'string' || !hashOk) return { status: 'denied' as const }
    const s = await getSettings()
    const fallbackCwd = typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd : s.cwd
    const resolved = await resolveFileContext(s, s.cwd, { cwd: fallbackCwd })
    if (!resolved.ok) return { status: 'denied' as const }
    return writeEditableFile(resolved.context.cwd, p, text, expectedHash as string | null)
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
      sender.send('yan:files-changed', { watchId, dir })
    })
  })

  rawHandle('yan:files:unsaved', (event, rawPaths: unknown) => {
    const sender = event.sender
    if (!unsavedSenders.has(sender.id)) {
      unsavedSenders.add(sender.id)
      sender.once('destroyed', () => {
        unsavedSenders.delete(sender.id)
        unsavedFiles.forget(sender.id)
      })
    }
    return unsavedFiles.report(sender.id, rawPaths)
  })

  handle('yan:attachments:usage',() => attachmentsUsage(join(YAN_DIR, 'attachments')))
  handle('yan:attachments:prune', async () => {
    if (deps.isSessionBusy()) throw new Error('会话正在运行，请结束后再清理附件')
    const before = Date.now()
    const sessionsDir = join(PI_AGENT_DIR, 'sessions')
    if (!existsSync(sessionsDir)) return { removed: 0, bytes: 0, kept: 0 }
    const fingerprint = async (): Promise<string> => {
      const files = listSessionFiles(sessionsDir).sort()
      const rows: Array<[string, number, number, number]> = []
      for (let start = 0; start < files.length; start += PRUNE_FINGERPRINT_BATCH) {
        const batch = files.slice(start, start + PRUNE_FINGERPRINT_BATCH)
        const stats = await Promise.all(
          batch.map((file) =>
            stat(file).then(
              (st) => st,
              (error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return null
                throw error
              }
            )
          )
        )
        stats.forEach((st, index) => {
          if (st) rows.push([batch[index], st.size, st.mtimeMs, st.ctimeMs])
        })
      }
      return JSON.stringify(rows)
    }
    const initial = await fingerprint()
    const referenced = await referencedAttachmentNames(listSessionFiles(sessionsDir))
    if (deps.isSessionBusy() || initial !== (await fingerprint())) throw new Error('会话在扫描期间发生变化，已停止附件清理，请稍后重试')
    const result = await pruneAttachments(join(YAN_DIR, 'attachments'), referenced, { before })
    clearSessionReadCache()
    return result
  })
}
