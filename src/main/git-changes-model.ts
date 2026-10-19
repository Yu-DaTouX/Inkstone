import { extname } from 'node:path'
import type { GitChangePatch, GitChangesScope } from '../shared/git'

export const PATCH_PREFILL_BYTES = 1024 * 1024
export const PATCH_PREFILL_FILES = 300
export const PATCH_SINGLE_FILE_BYTES = 5 * 1024 * 1024
export const IMAGE_SIDE_BYTES = 10 * 1024 * 1024
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}

export function imageMimeOf(path: string): string | null {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? null
}

function refNameSafe(value: string): boolean {
  return value.length > 0 && value.length <= 250 && !value.startsWith('-') && /^[\w./@^~{}+-]+$/.test(value) && !value.includes('..')
}

export function normalizeChangesScope(raw: unknown): GitChangesScope | null {
  if (raw === undefined || raw === null) return { kind: 'working' }
  if (typeof raw === 'string') {
    if (raw === 'working' || raw === '') return { kind: 'working' }
    if (raw === 'branch') return { kind: 'branch' }
    if (raw.startsWith('commit:')) return normalizeChangesScope({ kind: 'commit', sha: raw.slice('commit:'.length) })
    return null
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (value.kind === 'working') return { kind: 'working' }
  if (value.kind === 'branch') {
    if (value.base === undefined || value.base === null || value.base === '') return { kind: 'branch' }
    const base = String(value.base).trim()
    return refNameSafe(base) ? { kind: 'branch', base } : null
  }
  if (value.kind === 'commit') {
    const sha = String(value.sha ?? '').trim()
    return /^[0-9a-fA-F]{4,64}$/.test(sha) ? { kind: 'commit', sha: sha.toLowerCase() } : null
  }
  return null
}

export function baseCandidates(explicit: string | undefined, originHead: string | null): string[] {
  const out: string[] = []
  const push = (value: string | null | undefined): void => {
    if (value && refNameSafe(value) && !out.includes(value)) out.push(value)
  }
  push(explicit)
  if (explicit) return out
  push(originHead)
  for (const name of ['origin/main', 'origin/master', 'main', 'master']) push(name)
  return out
}

export interface NameStatusEntry {
  status: string
  path: string
}

export function parseNameStatus(stdout: string): NameStatusEntry[] {
  const parts = stdout.split('\0')
  const out: NameStatusEntry[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i].replace(/^\n+/, '').trim()
    const path = parts[i + 1]
    if (!status || !path) continue
    out.push({ status: status[0], path })
  }
  return out
}

export function splitPatch(raw: string): string[] {
  if (!raw) return []
  const chunks: string[] = []
  let start = raw.startsWith('diff --git ') ? 0 : raw.indexOf('\ndiff --git ')
  if (start < 0) return []
  if (start > 0) start += 1
  for (;;) {
    const next = raw.indexOf('\ndiff --git ', start)
    if (next < 0) {
      chunks.push(raw.slice(start))
      break
    }
    chunks.push(raw.slice(start, next + 1))
    start = next + 1
  }
  return chunks
}

export function isBinaryPatch(patch: string): boolean {
  return /(^|\n)(Binary files .+? differ|GIT binary patch)\s*(\n|$)/.test(patch)
}

export interface PatchBudget {
  totalBytes: number
  maxFiles: number
  singleFileBytes: number
}

export const DEFAULT_PATCH_BUDGET: PatchBudget = {
  totalBytes: PATCH_PREFILL_BYTES,
  maxFiles: PATCH_PREFILL_FILES,
  singleFileBytes: PATCH_SINGLE_FILE_BYTES
}

export function allocatePatches(
  order: readonly string[],
  available: ReadonlyMap<string, string>,
  budget: PatchBudget = DEFAULT_PATCH_BUDGET
): { patches: Record<string, GitChangePatch>; inlined: number; bytes: number; deferred: number } {
  const patches: Record<string, GitChangePatch> = {}
  let inlined = 0
  let bytes = 0
  let deferred = 0
  for (const path of order) {
    const patch = available.get(path)
    if (patch === undefined) {
      patches[path] = { state: 'deferred' }
      deferred += 1
      continue
    }
    const size = Buffer.byteLength(patch, 'utf8')
    if (isBinaryPatch(patch)) {
      patches[path] = { state: 'binary', bytes: size }
      continue
    }
    if (size > budget.singleFileBytes) {
      patches[path] = { state: 'too-large', bytes: size }
      continue
    }
    if (inlined >= budget.maxFiles || bytes + size > budget.totalBytes) {
      patches[path] = { state: 'deferred', bytes: size }
      deferred += 1
      continue
    }
    patches[path] = { state: 'inline', patch, bytes: size }
    inlined += 1
    bytes += size
  }
  return { patches, inlined, bytes, deferred }
}
