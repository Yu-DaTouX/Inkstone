import type { GitChangePatch, GitChangesScope } from '../../../../shared/git'

export type ChangesScopeKind = GitChangesScope['kind']

export interface ChangesScopeState {
  kind: ChangesScopeKind
  sha: string
}

export const WORKING_SCOPE: ChangesScopeState = { kind: 'working', sha: '' }

const SHA_PATTERN = /^[0-9a-f]{4,64}$/i
const IMAGE_PATTERN = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i

export function normalizeSha(input: string): string {
  return input.trim().toLowerCase()
}

export function isValidSha(input: string): boolean {
  return SHA_PATTERN.test(normalizeSha(input))
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

export function commitScope(sha: string | null | undefined): ChangesScopeState {
  return { kind: 'commit', sha: sha && isValidSha(sha) ? normalizeSha(sha) : '' }
}

export function scopeKey(scope: ChangesScopeState): string {
  return scope.kind === 'commit' ? `commit:${scope.sha}` : scope.kind
}

export function scopeToRequest(scope: ChangesScopeState): GitChangesScope | null {
  if (scope.kind === 'working') return { kind: 'working' }
  if (scope.kind === 'branch') return { kind: 'branch' }
  return isValidSha(scope.sha) ? { kind: 'commit', sha: normalizeSha(scope.sha) } : null
}

export function isImagePath(path: string): boolean {
  return IMAGE_PATTERN.test(path)
}

export type PatchSource =
  | { kind: 'image' }
  | { kind: 'inline'; patch: string }
  | { kind: 'binary' }
  | { kind: 'too-large' }
  | { kind: 'fetch' }

export function resolvePatchSource(path: string, entry: GitChangePatch | undefined): PatchSource {
  if (isImagePath(path)) return { kind: 'image' }
  if (!entry) return { kind: 'fetch' }
  if (entry.state === 'inline') return typeof entry.patch === 'string' ? { kind: 'inline', patch: entry.patch } : { kind: 'fetch' }
  if (entry.state === 'binary') return { kind: 'binary' }
  if (entry.state === 'too-large') return { kind: 'too-large' }
  return { kind: 'fetch' }
}

export function compareLabel(
  scope: ChangesScopeState,
  meta: { baseRef?: string | null; baseSha?: string | null; targetSha?: string | null }
): string {
  if (scope.kind === 'working') return ''
  if (meta.baseRef) return meta.baseRef
  if (meta.baseSha) return shortSha(meta.baseSha)
  return shortSha(meta.targetSha ?? scope.sha)
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
