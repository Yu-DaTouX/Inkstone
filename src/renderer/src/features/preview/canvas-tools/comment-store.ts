import type { CanvasElementRect, CanvasElementStyles } from '../../../../../shared/html-canvas-bridge'
import type { CanvasElementInfo } from './types'

export const COMMENT_STORE_PREFIX = 'yan.canvas.comments.v1'
export const COMMENT_LIMIT = 200
export const COMMENT_IMAGE_LIMIT = 4
export const COMMENT_HTML_CLIP = 400

export interface CanvasComment {
  id: string
  frameId: string
  element: CanvasElementInfo
  content: string
  createdAt: number
  sentAt: number | null
  invalid: boolean
  time: number | null
}

export type CommentResolutionState = 'valid' | 'missing' | 'unknown'

export interface CommentResolution {
  id: string
  state: CommentResolutionState
  rect?: CanvasElementRect
}

export interface CommentStatus {
  tone: 'info' | 'error'
  text: string
}

export interface CommentStoreSnapshot {
  comments: CanvasComment[]
  selected: string[]
  activeId: string | null
  status: CommentStatus | null
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface CommentAddInput {
  frameId: string
  element: CanvasElementInfo
  content: string
  createdAt?: number
  time?: number | null
}

export interface CommentStore {
  getSnapshot(): CommentStoreSnapshot
  subscribe(listener: () => void): () => void
  add(input: CommentAddInput): CanvasComment
  update(id: string, content: string): void
  remove(id: string): void
  toggleSelected(id: string): void
  selectAll(): void
  selectNone(): void
  setActive(id: string | null): void
  markSent(ids: readonly string[], at?: number): void
  clearSent(): void
  resolve(resolutions: readonly CommentResolution[]): void
  setStatus(status: CommentStatus | null): void
}

export interface CommentPromptEntry {
  index: number
  reference: string
  content: string
}

const EMPTY_STYLES: CanvasElementStyles = {
  color: '',
  backgroundColor: '',
  fontFamily: '',
  fontSize: '',
  fontWeight: '',
  lineHeight: '',
  letterSpacing: '',
  textAlign: '',
  padding: '',
  margin: '',
  borderRadius: '',
  display: '',
  width: '',
  height: ''
}

const STYLE_KEYS = Object.keys(EMPTY_STYLES) as (keyof CanvasElementStyles)[]

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function parseRect(value: unknown): CanvasElementRect | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (!finite(raw.x) || !finite(raw.y) || !finite(raw.w) || !finite(raw.h)) return null
  return { x: raw.x, y: raw.y, w: raw.w, h: raw.h }
}

export function parseStyles(value: unknown): CanvasElementStyles {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const styles = { ...EMPTY_STYLES }
  for (const key of STYLE_KEYS) styles[key] = str(raw[key])
  return styles
}

export function commentStorageKey(abs: string): string {
  return `${COMMENT_STORE_PREFIX}:${abs}`
}

export function snapshotElement(info: CanvasElementInfo): CanvasElementInfo {
  return {
    frameId: info.frameId,
    path: info.path,
    selector: info.selector,
    tag: info.tag,
    id: info.id,
    classes: [...info.classes],
    text: info.text,
    rect: { x: info.rect.x, y: info.rect.y, w: info.rect.w, h: info.rect.h },
    styles: { ...info.styles },
    outerHtml: info.outerHtml.slice(0, COMMENT_HTML_CLIP),
    ...(typeof info.sourceOffset === 'number' ? { sourceOffset: info.sourceOffset } : {})
  }
}

export function parseDomPath(path: string): number[] {
  const trimmed = path.trim()
  if (!trimmed) return []
  const steps: number[] = []
  for (const part of trimmed.split('.')) {
    if (!/^\d+$/.test(part)) return []
    const value = Number(part)
    if (!Number.isSafeInteger(value) || value < 0) return []
    steps.push(value)
  }
  return steps
}

export function isPlainTextHtml(outerHtml: string | undefined): boolean {
  const html = (outerHtml ?? '').trim()
  if (!html) return false
  const open = html.indexOf('>')
  if (open < 0) return false
  const rest = html.slice(open + 1)
  if (rest.startsWith('/')) return false
  const close = rest.lastIndexOf('</')
  const body = close >= 0 ? rest.slice(0, close) : rest.replace(/\/\s*$/, '')
  if (!body.trim()) return false
  return !body.includes('<')
}

export function plainTextNeedle(element: CanvasElementInfo): string {
  if (!isPlainTextHtml(element.outerHtml)) return ''
  const text = element.text.trim()
  return text.length >= 2 ? text : ''
}

function parseElement(value: unknown): CanvasElementInfo | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const rect = parseRect(raw.rect)
  const selector = str(raw.selector)
  const tag = str(raw.tag)
  if (!rect || !selector || !tag) return null
  const classes = Array.isArray(raw.classes) ? raw.classes.filter((token): token is string => typeof token === 'string') : []
  const element: CanvasElementInfo = {
    frameId: str(raw.frameId),
    path: str(raw.path),
    selector,
    tag,
    id: str(raw.id),
    classes,
    text: str(raw.text),
    rect,
    styles: parseStyles(raw.styles),
    outerHtml: str(raw.outerHtml)
  }
  if (finite(raw.sourceOffset)) element.sourceOffset = Math.max(0, Math.floor(raw.sourceOffset))
  return element
}

function parseComment(value: unknown): CanvasComment | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const element = parseElement(raw.element)
  const id = str(raw.id)
  if (!element || !id || typeof raw.content !== 'string' || !raw.content.trim()) return null
  return {
    id,
    frameId: str(raw.frameId) || element.frameId,
    element,
    content: raw.content,
    createdAt: finite(raw.createdAt) ? raw.createdAt : 0,
    sentAt: finite(raw.sentAt) ? raw.sentAt : null,
    invalid: raw.invalid === true,
    time: finite(raw.time) ? raw.time : null
  }
}

export function clampComments(list: readonly CanvasComment[]): CanvasComment[] {
  return list.length > COMMENT_LIMIT ? list.slice(list.length - COMMENT_LIMIT) : [...list]
}

export function parseComments(raw: string | null): CanvasComment[] {
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const parsed: CanvasComment[] = []
  for (const item of value) {
    const comment = parseComment(item)
    if (!comment || seen.has(comment.id)) continue
    seen.add(comment.id)
    parsed.push(comment)
  }
  parsed.sort((a, b) => a.createdAt - b.createdAt)
  return clampComments(parsed)
}

export function serializeComments(list: readonly CanvasComment[]): string {
  return JSON.stringify(
    list.map((comment) => ({
      id: comment.id,
      frameId: comment.frameId,
      element: comment.element,
      content: comment.content,
      createdAt: comment.createdAt,
      sentAt: comment.sentAt,
      invalid: comment.invalid,
      time: comment.time
    }))
  )
}

export function readComments(storage: StorageLike | null, abs: string): CanvasComment[] {
  try {
    return parseComments(storage?.getItem(commentStorageKey(abs)) ?? null)
  } catch {
    return []
  }
}

export function writeComments(storage: StorageLike | null, abs: string, list: readonly CanvasComment[]): void {
  try {
    storage?.setItem(commentStorageKey(abs), serializeComments(clampComments(list)))
  } catch {
  }
}

export function newCommentId(seed?: number): string {
  const stamp = (seed ?? Date.now()).toString(36)
  return `c-${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

export function commentNumber(list: readonly CanvasComment[], id: string): number {
  const index = list.findIndex((comment) => comment.id === id)
  return index < 0 ? 0 : index + 1
}

export function elementSummary(element: CanvasElementInfo): string {
  const tag = (element.tag || 'node').toLowerCase()
  const selector = element.selector || element.path || ''
  return selector ? `${tag} · ${selector}` : tag
}

export function commentTextPreview(content: string, limit = 96): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export function formatCommentTime(stamp: number, lang: 'zh-CN' | 'en-US'): string {
  if (!Number.isFinite(stamp) || stamp <= 0) return ''
  const date = new Date(stamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (sameDay) return clock
  const day = lang === 'en-US' ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getMonth() + 1}月${date.getDate()}日`
  return `${day} ${clock}`
}

export function applyResolutions(
  list: readonly CanvasComment[],
  resolutions: readonly CommentResolution[]
): { comments: CanvasComment[]; changed: boolean } {
  if (!resolutions.length) return { comments: [...list], changed: false }
  const next = new Map<string, CommentResolution>()
  for (const resolution of resolutions) next.set(resolution.id, resolution)
  let changed = false
  const comments = list.map((comment) => {
    const resolution = next.get(comment.id)
    if (!resolution || resolution.state === 'unknown') return comment
    if (resolution.state === 'missing') {
      if (comment.invalid) return comment
      changed = true
      return { ...comment, invalid: true }
    }
    const rect = resolution.rect
    if (comment.invalid) {
      changed = true
      return rect ? { ...comment, invalid: false, element: { ...comment.element, rect } } : { ...comment, invalid: false }
    }
    if (!rect) return comment
    const current = comment.element.rect
    if (current.x === rect.x && current.y === rect.y && current.w === rect.w && current.h === rect.h) return comment
    changed = true
    return { ...comment, element: { ...comment.element, rect } }
  })
  return changed ? { comments, changed } : { comments: [...list], changed: false }
}

export function composeCommentPrompt(options: {
  header: string
  commentLabel: string
  entries: readonly CommentPromptEntry[]
}): string {
  const blocks = options.entries.map((entry) => [`[${entry.index}] ${entry.reference}`, `${options.commentLabel}${entry.content}`].join('\n'))
  return [options.header, ...blocks].join('\n\n')
}

export function sameCommentStatus(a: CommentStatus | null, b: CommentStatus | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.tone === b.tone && a.text === b.text
}

export function createCommentStore(options: { storage: StorageLike | null; abs: string }): CommentStore {
  const { storage, abs } = options
  let current: CommentStoreSnapshot = {
    comments: readComments(storage, abs),
    selected: [],
    activeId: null,
    status: null
  }
  const listeners = new Set<() => void>()

  const publish = (next: Partial<CommentStoreSnapshot>): void => {
    const merged: CommentStoreSnapshot = { ...current, ...next }
    if (
      merged.comments === current.comments &&
      merged.selected === current.selected &&
      merged.activeId === current.activeId &&
      sameCommentStatus(merged.status, current.status)
    ) {
      return
    }
    current = merged
    for (const listener of [...listeners]) listener()
  }

  const commit = (comments: CanvasComment[], patch: Partial<CommentStoreSnapshot> = {}): void => {
    const kept = new Set(comments.map((comment) => comment.id))
    const selected = (patch.selected ?? current.selected).filter((id) => kept.has(id))
    writeComments(storage, abs, comments)
    publish({ ...patch, comments, selected })
  }

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    add(input) {
      const content = input.content.trim()
      const comment: CanvasComment = {
        id: newCommentId(input.createdAt),
        frameId: input.frameId,
        element: snapshotElement(input.element),
        content,
        createdAt: input.createdAt ?? Date.now(),
        sentAt: null,
        invalid: false,
        time: finite(input.time) ? input.time : null
      }
      const comments = clampComments([...current.comments, comment])
      commit(comments, { activeId: comment.id, selected: [...current.selected, comment.id] })
      return comment
    },
    update(id, content) {
      const trimmed = content.trim()
      if (!trimmed) return
      const comments = current.comments.map((comment) => (comment.id === id ? { ...comment, content: trimmed } : comment))
      commit(comments)
    },
    remove(id) {
      const comments = current.comments.filter((comment) => comment.id !== id)
      commit(comments, { activeId: current.activeId === id ? null : current.activeId })
    },
    toggleSelected(id) {
      const selected = current.selected.includes(id)
        ? current.selected.filter((item) => item !== id)
        : [...current.selected, id]
      publish({ selected })
    },
    selectAll() {
      publish({ selected: current.comments.map((comment) => comment.id) })
    },
    selectNone() {
      publish({ selected: [] })
    },
    setActive(id) {
      publish({ activeId: id })
    },
    markSent(ids, at) {
      if (!ids.length) return
      const stamp = at ?? Date.now()
      const wanted = new Set(ids)
      const comments = current.comments.map((comment) =>
        wanted.has(comment.id) ? { ...comment, sentAt: comment.sentAt ?? stamp } : comment
      )
      commit(comments)
    },
    clearSent() {
      const comments = current.comments.filter((comment) => comment.sentAt === null)
      if (comments.length === current.comments.length) return
      commit(comments)
    },
    resolve(resolutions) {
      const result = applyResolutions(current.comments, resolutions)
      if (!result.changed) return
      commit(result.comments)
    },
    setStatus(status) {
      publish({ status })
    }
  }
}
