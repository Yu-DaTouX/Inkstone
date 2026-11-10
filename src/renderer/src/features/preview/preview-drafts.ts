export interface PreviewDraft {
  abs: string
  text: string
  original: string
  hash: string
  saving: boolean
  conflict: boolean
  failed: boolean
}

export type PreviewDrafts = ReadonlyMap<string, PreviewDraft>

export const EMPTY_PREVIEW_DRAFTS: PreviewDrafts = new Map()

export function draftIsDirty(draft: PreviewDraft | null | undefined): boolean {
  return !!draft && draft.text !== draft.original
}

export function loadedDraft(abs: string, text: string, hash: string): PreviewDraft {
  return { abs, text, original: text, hash, saving: false, conflict: false, failed: false }
}

export function failedDraft(abs: string): PreviewDraft {
  return { abs, text: '', original: '', hash: '', saving: false, conflict: false, failed: true }
}

export function putDraft(drafts: PreviewDrafts, draft: PreviewDraft): PreviewDrafts {
  const next = new Map(drafts)
  next.set(draft.abs, draft)
  return next
}

export function patchDraft(drafts: PreviewDrafts, abs: string, patch: (draft: PreviewDraft) => PreviewDraft): PreviewDrafts {
  const current = drafts.get(abs)
  if (!current) return drafts
  const updated = patch(current)
  if (updated === current) return drafts
  const next = new Map(drafts)
  next.set(abs, updated)
  return next
}

export function dropDraft(drafts: PreviewDrafts, abs: string): PreviewDrafts {
  if (!drafts.has(abs)) return drafts
  const next = new Map(drafts)
  next.delete(abs)
  return next
}

export function dropCleanDrafts(drafts: PreviewDrafts, keep: (abs: string) => boolean): PreviewDrafts {
  let next: Map<string, PreviewDraft> | null = null
  for (const [abs, draft] of drafts) {
    if (draftIsDirty(draft) || keep(abs)) continue
    next ??= new Map(drafts)
    next.delete(abs)
  }
  return next ?? drafts
}

export function unsavedDraftPaths(drafts: PreviewDrafts): string[] {
  const paths: string[] = []
  for (const [abs, draft] of drafts) if (draftIsDirty(draft)) paths.push(abs)
  return paths.sort()
}
