import type { Attachment } from '../../../../shared/ipc'
import { trimDraftAttachments } from './draft-store'

export const PROMPT_STASH_STORAGE_KEY = 'yan.promptStash.v1'
export const PROMPT_STASH_LIMIT = 50
export const PROMPT_STASH_SNIPPET_MAX = 90
export const PROMPT_STASH_OPEN_EVENT = 'yan:prompt-stash-open'
export const PROMPT_STASH_SAVE_EVENT = 'yan:prompt-stash-save'

export interface PromptStashEntry {
  id: string
  text: string
  attachments: Attachment[]
  createdAt: number
  sessionKey: string
}

export interface PromptStashInput {
  text: string
  attachments?: readonly Attachment[]
  sessionKey?: string
}

export type StashAge =
  | { unit: 'now' }
  | { unit: 'minute'; value: number }
  | { unit: 'hour'; value: number }
  | { unit: 'day'; value: number }
  | { unit: 'date' }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const DATE_AFTER_DAYS = 7

function isStashAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Attachment>
  if (typeof item.id !== 'string' || !item.id) return false
  if (typeof item.name !== 'string' || typeof item.mimeType !== 'string') return false
  if (typeof item.size !== 'number') return false
  if (item.kind !== undefined && item.kind !== 'image' && item.kind !== 'file') return false
  if (item.kind === 'file') return typeof item.path === 'string' && item.path.length > 0
  return typeof item.data === 'string' && typeof item.preview === 'string'
}

export function stashHasContent(text: string, attachments: readonly Attachment[] = []): boolean {
  return (text ?? '').trim().length > 0 || attachments.length > 0
}

export function stashSnippet(text: string, max = PROMPT_STASH_SNIPPET_MAX): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function stashImages(entry: PromptStashEntry): Attachment[] {
  return entry.attachments.filter((item) => item.kind !== 'file')
}

export function stashFiles(entry: PromptStashEntry): Attachment[] {
  return entry.attachments.filter((item) => item.kind === 'file')
}

let idSeed = 0

export function stashEntryId(now: number): string {
  idSeed += 1
  return `ps-${now.toString(36)}-${idSeed.toString(36)}`
}

export function parsePromptStash(raw: unknown, limit = PROMPT_STASH_LIMIT): PromptStashEntry[] {
  if (!Array.isArray(raw)) return []
  const out: PromptStashEntry[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const item = value as Partial<PromptStashEntry>
    if (typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue
    const text = typeof item.text === 'string' ? item.text : ''
    const attachments = Array.isArray(item.attachments) ? item.attachments.filter(isStashAttachment) : []
    if (!stashHasContent(text, attachments)) continue
    seen.add(item.id)
    out.push({
      id: item.id,
      text,
      attachments,
      createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
      sessionKey: typeof item.sessionKey === 'string' ? item.sessionKey : ''
    })
    if (out.length >= limit) break
  }
  return out
}

export function createPromptStashEntry(input: PromptStashInput, now: number, id?: string): PromptStashEntry | null {
  const attachments = trimDraftAttachments(input.attachments ?? [])
  if (!stashHasContent(input.text, attachments)) return null
  return {
    id: id ?? stashEntryId(now),
    text: input.text,
    attachments,
    createdAt: now,
    sessionKey: input.sessionKey ?? ''
  }
}

export function pushPromptStash(
  list: readonly PromptStashEntry[],
  entry: PromptStashEntry,
  limit = PROMPT_STASH_LIMIT
): PromptStashEntry[] {
  return [entry, ...list.filter((item) => item.id !== entry.id)].slice(0, Math.max(1, limit))
}

export function removePromptStash(list: readonly PromptStashEntry[], id: string): PromptStashEntry[] {
  return list.filter((item) => item.id !== id)
}

export interface PromptStashSwap {
  list: PromptStashEntry[]
  entry: PromptStashEntry | null
}

export function swapPromptStash(
  list: readonly PromptStashEntry[],
  id: string,
  current: PromptStashInput,
  now: number,
  options?: { limit?: number; swapId?: string }
): PromptStashSwap {
  const entry = list.find((item) => item.id === id) ?? null
  if (!entry) return { list: [...list], entry: null }
  const rest = removePromptStash(list, id)
  const swapped = stashHasContent(current.text, current.attachments ?? [])
    ? createPromptStashEntry(current, now, options?.swapId)
    : null
  return { list: swapped ? pushPromptStash(rest, swapped, options?.limit) : rest, entry }
}

export function stashAge(now: number, at: number): StashAge {
  const delta = now - at
  if (!Number.isFinite(delta) || delta < MINUTE_MS) return { unit: 'now' }
  if (delta < HOUR_MS) return { unit: 'minute', value: Math.floor(delta / MINUTE_MS) }
  if (delta < DAY_MS) return { unit: 'hour', value: Math.floor(delta / HOUR_MS) }
  const days = Math.floor(delta / DAY_MS)
  if (days < DATE_AFTER_DAYS) return { unit: 'day', value: days }
  return { unit: 'date' }
}

let cache: PromptStashEntry[] | null = null
const listeners = new Set<() => void>()

export function readPromptStash(): PromptStashEntry[] {
  if (cache) return cache
  if (typeof localStorage === 'undefined') {
    cache = []
    return cache
  }
  try {
    cache = parsePromptStash(JSON.parse(localStorage.getItem(PROMPT_STASH_STORAGE_KEY) ?? 'null'))
  } catch {
    cache = []
  }
  return cache
}

export function writePromptStash(list: readonly PromptStashEntry[]): PromptStashEntry[] {
  cache = [...list]
  if (typeof localStorage !== 'undefined') {
    try {
      if (cache.length === 0) localStorage.removeItem(PROMPT_STASH_STORAGE_KEY)
      else localStorage.setItem(PROMPT_STASH_STORAGE_KEY, JSON.stringify(cache))
    } catch {
    }
  }
  for (const listener of [...listeners]) listener()
  return cache
}

export function subscribePromptStash(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function stashPromptInput(input: PromptStashInput, now = Date.now()): PromptStashEntry | null {
  const entry = createPromptStashEntry(input, now)
  if (!entry) return null
  writePromptStash(pushPromptStash(readPromptStash(), entry))
  return entry
}

export function deletePromptStashEntry(id: string): void {
  writePromptStash(removePromptStash(readPromptStash(), id))
}

export function swapPromptStashInStore(id: string, current: PromptStashInput, now = Date.now()): PromptStashEntry | null {
  const { list, entry } = swapPromptStash(readPromptStash(), id, current, now)
  if (!entry) return null
  writePromptStash(list)
  return entry
}

function emitRequest(eventName: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(eventName))
}

export function requestPromptStashOpen(): void {
  emitRequest(PROMPT_STASH_OPEN_EVENT)
}

export function requestPromptStashSave(): void {
  emitRequest(PROMPT_STASH_SAVE_EVENT)
}

export function isPromptStashShortcut(event: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
}): boolean {
  if (event.isComposing) return false
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return false
  return event.key.toLowerCase() === 's'
}
