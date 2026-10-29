import type { Attachment } from '../../../../shared/ipc'

export const DRAFT_STORAGE_KEY = 'yan.composerDrafts.v1'
export const DRAFT_LIMIT = 20
export const DRAFT_ATTACHMENT_BUDGET = 1_000_000
export const DRAFT_STORE_BUDGET = 2_500_000

export interface StoredDraft {
  text: string
  attachments: Attachment[]
  at: number
}

export type DraftMap = Record<string, StoredDraft>

export function restoreDraft(cached: { draft: string; draftAttachments: Attachment[]; draftInitialized?: boolean; draftAttachmentsInitialized?: boolean } | undefined, persisted: StoredDraft | undefined): { text: string; attachments: Attachment[] } {
  return {
    text: cached?.draftInitialized || cached?.draft ? cached.draft : persisted?.text ?? '',
    attachments: cached?.draftAttachmentsInitialized || cached?.draftAttachments?.length ? cached.draftAttachments ?? [] : persisted?.attachments ?? []
  }
}

function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Attachment>
  if (typeof item.id !== 'string' || typeof item.name !== 'string') return false
  if (typeof item.mimeType !== 'string' || typeof item.size !== 'number') return false
  if (item.kind !== undefined && item.kind !== 'image' && item.kind !== 'file') return false
  if (item.kind === 'file') return typeof item.path === 'string' && item.path.length > 0
  return typeof item.data === 'string' && typeof item.preview === 'string'
}

export function trimDraftAttachments(attachments: readonly Attachment[], budget = DRAFT_ATTACHMENT_BUDGET): Attachment[] {
  if (attachments.length === 0) return []
  if (JSON.stringify(attachments).length <= budget) return attachments.map((item) => ({ ...item }))
  return attachments.filter((item) => item.kind === 'file').map((item) => ({ ...item }))
}

export function parseDrafts(raw: unknown): DraftMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: DraftMap = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== 'object') continue
    const entry = value as Partial<StoredDraft>
    if (typeof entry.text !== 'string') continue
    const attachments = Array.isArray(entry.attachments) ? entry.attachments.filter(isAttachment) : []
    if (!entry.text && attachments.length === 0) continue
    out[key] = {
      text: entry.text,
      attachments,
      at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0
    }
  }
  return out
}

function totalChars(map: DraftMap): number {
  return JSON.stringify(map).length
}

function evictOldest(map: DraftMap, protectKey: string, maxTotal: number): DraftMap {
  const next: DraftMap = { ...map }
  if (totalChars(next) <= maxTotal) return next
  const oldest = Object.entries(next)
    .filter(([key]) => key !== protectKey)
    .sort((a, b) => a[1].at - b[1].at)
  for (const [key] of oldest) {
    delete next[key]
    if (totalChars(next) <= maxTotal) break
  }
  return next
}

export function putDraft(map: DraftMap, key: string, draft: { text: string; attachments?: readonly Attachment[] }, now: number, options?: { limit?: number; maxTotal?: number }): DraftMap {
  if (!key) return map
  const limit = options?.limit ?? DRAFT_LIMIT
  const attachments = trimDraftAttachments(draft.attachments ?? [])
  const text = draft.text
  const next: DraftMap = { ...map }
  if (!text && attachments.length === 0) {
    delete next[key]
    return next
  }
  next[key] = { text, attachments, at: now }
  const keys = Object.keys(next)
  if (keys.length > limit) {
    const drop = keys
      .filter((item) => item !== key)
      .sort((a, b) => next[a].at - next[b].at)
      .slice(0, keys.length - limit)
    for (const item of drop) delete next[item]
  }
  return evictOldest(next, key, options?.maxTotal ?? DRAFT_STORE_BUDGET)
}

export function draftOf(map: DraftMap, key: string | null | undefined): StoredDraft | undefined {
  if (!key) return undefined
  return map[key]
}

let cache: DraftMap | null = null

function normalize(map: DraftMap): DraftMap {
  cache = map
  return map
}

export function readDrafts(): DraftMap {
  if (cache) return cache
  if (typeof localStorage === 'undefined') return normalize({})
  try {
    return normalize(parseDrafts(JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? 'null')))
  } catch {
    return normalize({})
  }
}

export function writeDrafts(map: DraftMap): void {
  normalize(map)
  if (typeof localStorage === 'undefined') return
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(DRAFT_STORAGE_KEY)
    else localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(map))
  } catch {
  }
}

export function saveDraft(key: string | null | undefined, draft: { text: string; attachments?: readonly Attachment[] }, now = Date.now()): void {
  if (!key) return
  writeDrafts(putDraft(readDrafts(), key, draft, now))
}

export function loadDraft(key: string | null | undefined): StoredDraft | undefined {
  return draftOf(readDrafts(), key)
}
