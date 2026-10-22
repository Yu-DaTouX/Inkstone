import { extname } from 'node:path'
import { getSettings } from '../settings'
import { readEditableFile, writeEditableFile } from '../file-editor'
import { pathKey } from '../file-path-gate'
import { patchHtmlAtOffset, type HtmlEditPatch } from '../../shared/html-edit-patch'
import {
  HTML_EDIT_APPLY_CHANNEL,
  HTML_EDIT_UNDO_CHANNEL,
  type HtmlEditError,
  type HtmlEditResult
} from '../../shared/ipc'
import type { FileContextResult } from './files-ipc'
import type { IpcRegistrar } from './registrar'

export interface HtmlEditIpcDeps {
  resolveFileContext(
    settings: Awaited<ReturnType<typeof getSettings>>,
    fallbackCwd: string,
    rawContext: unknown
  ): Promise<FileContextResult>
}

const HASH_PATTERN = /^[0-9a-f]{64}$/
const TAG_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/
const EDIT_MAX_BYTES = 1024 * 1024
const UNDO_LIMIT = 8

const undoEntries = new Map<string, { text: string; hash: string }>()

function failure(error: HtmlEditError, detail?: string): HtmlEditResult {
  return { ok: false, error, ...(detail ? { detail } : {}) }
}

function field(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function htmlPath(target: string): boolean {
  const extension = extname(target).toLowerCase()
  return extension === '.html' || extension === '.htm'
}

function readError(error: string | undefined): HtmlEditError {
  if (error === 'missing') return 'missing'
  if (error === 'too-large') return 'too-large'
  if (error === 'encoding' || error === 'binary') return 'encoding'
  if (error === 'denied' || error === 'permission') return 'denied'
  return 'failed'
}

function patchOf(value: unknown): HtmlEditPatch | null {
  if (!isRecord(value)) return null
  const patch: HtmlEditPatch = {}
  if (value.styles !== undefined) {
    if (!Array.isArray(value.styles)) return null
    const styles: Array<{ property: string; value: string | null }> = []
    for (const item of value.styles) {
      if (!isRecord(item)) return null
      if (typeof item.property !== 'string' || !item.property.trim()) return null
      if (item.value !== null && typeof item.value !== 'string') return null
      styles.push({ property: item.property.trim(), value: item.value })
    }
    patch.styles = styles
  }
  if (value.attributes !== undefined) {
    if (!Array.isArray(value.attributes)) return null
    const attributes: Array<{ name: string; value: string | null }> = []
    for (const item of value.attributes) {
      if (!isRecord(item)) return null
      if (typeof item.name !== 'string' || !item.name.trim()) return null
      if (item.value !== null && typeof item.value !== 'string') return null
      attributes.push({ name: item.name.trim(), value: item.value })
    }
    patch.attributes = attributes
  }
  if (value.text !== undefined) {
    if (value.text !== null && typeof value.text !== 'string') return null
    patch.text = value.text
  }
  return patch
}

export function frameHashProblem(frameHash: string, diskHash: string): HtmlEditError | null {
  if (!frameHash) return 'draft'
  if (frameHash !== diskHash) return 'conflict'
  return null
}

function rememberUndo(key: string, text: string, hash: string): void {
  undoEntries.delete(key)
  undoEntries.set(key, { text, hash })
  while (undoEntries.size > UNDO_LIMIT) {
    const oldest = undoEntries.keys().next()
    if (oldest.done) break
    undoEntries.delete(oldest.value)
  }
}

export function registerHtmlEditIpc(ipc: IpcRegistrar, deps: HtmlEditIpcDeps): void {
  const resolveCwd = async (requested: unknown): Promise<string | null> => {
    const settings = await getSettings()
    const fallback = field(requested) || settings.cwd
    const resolved = await deps.resolveFileContext(settings, settings.cwd, { cwd: fallback })
    return resolved.ok ? resolved.context.cwd : null
  }

  ipc.handle(HTML_EDIT_APPLY_CHANNEL, async (raw: unknown): Promise<HtmlEditResult> => {
    if (!isRecord(raw)) return failure('denied')
    const target = field(raw.path)
    const hash = field(raw.sha256)
    const frameHash = field(raw.frameHash)
    const tag = field(raw.tag)
    const offset = raw.sourceOffset
    if (!target || !HASH_PATTERN.test(hash) || !TAG_PATTERN.test(tag)) return failure('denied')
    if (frameHash && !HASH_PATTERN.test(frameHash)) return failure('denied')
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return failure('offset')
    if (!htmlPath(target)) return failure('not-html')
    const patch = patchOf(raw.patch)
    if (!patch) return failure('denied')

    const cwd = await resolveCwd(raw.cwd)
    if (!cwd) return failure('denied')
    const view = await readEditableFile(cwd, target)
    if (!view.ok) return failure(readError(view.error))
    if (view.hash !== hash) return failure('conflict')
    const stale = frameHashProblem(frameHash, view.hash)
    if (stale) return failure(stale)

    const patched = patchHtmlAtOffset(view.text, offset, tag, patch)
    if (!patched.ok) return failure(patched.error)
    if (Buffer.byteLength(patched.html, 'utf8') > EDIT_MAX_BYTES) return failure('too-large')

    const written = await writeEditableFile(cwd, target, patched.html, view.hash)
    if (written.status === 'conflict') return failure('conflict')
    if (written.status === 'denied') return failure('denied')
    if (written.status === 'failed' || !written.hash) return failure('failed', written.error)
    rememberUndo(pathKey(view.abs), view.text, written.hash)
    return { ok: true, sha256: written.hash }
  })

  ipc.handle(HTML_EDIT_UNDO_CHANNEL, async (raw: unknown): Promise<HtmlEditResult> => {
    if (!isRecord(raw)) return failure('denied')
    const target = field(raw.path)
    const hash = field(raw.sha256)
    if (!target || !HASH_PATTERN.test(hash)) return failure('denied')
    if (!htmlPath(target)) return failure('not-html')
    const cwd = await resolveCwd(raw.cwd)
    if (!cwd) return failure('denied')
    const view = await readEditableFile(cwd, target)
    if (!view.ok) return failure(readError(view.error))
    const key = pathKey(view.abs)
    const entry = undoEntries.get(key)
    if (!entry || entry.hash !== hash || view.hash !== hash) return failure('undo')
    const written = await writeEditableFile(cwd, target, entry.text, view.hash)
    if (written.status === 'conflict') return failure('conflict')
    if (written.status === 'denied') return failure('denied')
    if (written.status === 'failed' || !written.hash) return failure('failed', written.error)
    undoEntries.delete(key)
    return { ok: true, sha256: written.hash }
  })
}
