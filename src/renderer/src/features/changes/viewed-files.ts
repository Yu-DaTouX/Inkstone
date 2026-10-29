import type { StorageLike } from './test-files'

export const VIEWED_FILES_KEY = 'inkstone.changes.viewedFiles.v1'

export type ViewedFiles = Record<string, string>

export interface ViewedCandidate {
  path: string
  hash: string | null
}

function localStorageOrNull(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function normalizeRoot(root: string): string {
  const slashed = root.replace(/\\/g, '/')
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function patchHash(patch: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < patch.length; index += 1) {
    hash ^= patch.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

export function viewedEntryKey(root: string, path: string): string {
  return `${normalizeRoot(root)}/${normalizePath(path)}`
}

export function parseViewedFiles(raw: string | null): ViewedFiles {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: ViewedFiles = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key && typeof value === 'string') out[key] = value
  }
  return out
}

export function serializeViewedFiles(state: ViewedFiles): string {
  return JSON.stringify(state)
}

export function isFileViewed(state: ViewedFiles, root: string, path: string, hash: string | null): boolean {
  const stored = state[viewedEntryKey(root, path)]
  if (stored === undefined) return false
  if (!stored || !hash) return true
  return stored === hash
}

export function withFileViewed(
  state: ViewedFiles,
  root: string,
  path: string,
  hash: string | null,
  viewed: boolean
): ViewedFiles {
  const key = viewedEntryKey(root, path)
  if (!viewed) {
    if (!(key in state)) return state
    const next = { ...state }
    delete next[key]
    return next
  }
  const value = hash ?? ''
  if (state[key] === value) return state
  return { ...state, [key]: value }
}

export function reconcileViewedFiles(
  state: ViewedFiles,
  root: string,
  candidates: readonly { path: string; hash: string }[]
): ViewedFiles {
  if (candidates.length === 0) return state
  const known = new Map(candidates.map((candidate) => [viewedEntryKey(root, candidate.path), candidate.hash]))
  let next: ViewedFiles | null = null
  for (const [key, stored] of Object.entries(state)) {
    const hash = known.get(key)
    if (hash === undefined) continue
    if (stored === hash) continue
    next ??= { ...state }
    if (!stored) next[key] = hash
    else delete next[key]
  }
  return next ?? state
}

export function viewedProgress(
  state: ViewedFiles,
  root: string,
  candidates: readonly ViewedCandidate[]
): { viewed: number; total: number } {
  let viewed = 0
  for (const candidate of candidates) {
    if (isFileViewed(state, root, candidate.path, candidate.hash)) viewed += 1
  }
  return { viewed, total: candidates.length }
}

export function viewedPathsOf(state: ViewedFiles, root: string, candidates: readonly ViewedCandidate[]): Set<string> {
  const paths = new Set<string>()
  for (const candidate of candidates) {
    if (isFileViewed(state, root, candidate.path, candidate.hash)) paths.add(candidate.path)
  }
  return paths
}

export function readViewedFiles(target: StorageLike | null = localStorageOrNull()): ViewedFiles {
  try {
    return parseViewedFiles(target?.getItem(VIEWED_FILES_KEY) ?? null)
  } catch {
    return {}
  }
}

export function writeViewedFiles(state: ViewedFiles, target: StorageLike | null = localStorageOrNull()): void {
  try {
    target?.setItem(VIEWED_FILES_KEY, serializeViewedFiles(state))
  } catch {
    return
  }
}
