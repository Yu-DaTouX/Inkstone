import type { GitRefOption } from '../../../../shared/git'
import type { GitActionResult, GitFailure, GitFailureCode } from '../../../../shared/git-actions'

export interface SyncFacts {
  stagedCount: number
  changedCount: number
  branch: string | null
  detached: boolean
  unborn: boolean
  upstream: string | null
  ahead: number
  behind: number
  hasRemote: boolean
  hasMessage: boolean
}

export type PrimaryKind = 'commit' | 'push' | 'publish' | 'up-to-date' | 'behind'

export type DisabledReason =
  | 'need-message'
  | 'nothing-staged'
  | 'synced'
  | 'no-remote'
  | 'detached'
  | 'unborn'
  | 'diverged'
  | 'behind'

export interface PrimaryAction {
  kind: PrimaryKind
  reason: DisabledReason | null
  commitAndPush: boolean
  commitPushReason: DisabledReason | null
}

export function commitPushReason(facts: SyncFacts): DisabledReason | null {
  if (facts.stagedCount === 0) return 'nothing-staged'
  if (!facts.hasMessage) return 'need-message'
  if (!facts.hasRemote) return 'no-remote'
  if (facts.detached || !facts.branch) return 'detached'
  if (facts.upstream && facts.behind > 0) return facts.ahead > 0 ? 'diverged' : 'behind'
  return null
}

export function primaryAction(facts: SyncFacts): PrimaryAction {
  const pushReason = commitPushReason(facts)
  const result = (kind: PrimaryKind, reason: DisabledReason | null): PrimaryAction => ({
    kind,
    reason,
    commitAndPush: pushReason === null,
    commitPushReason: pushReason
  })
  if (facts.stagedCount > 0) return result('commit', facts.hasMessage ? null : 'need-message')
  const dirty = facts.changedCount > 0
  const idle = (reason: DisabledReason): PrimaryAction => (dirty ? result('commit', 'nothing-staged') : result('up-to-date', reason))
  if (facts.unborn) return idle('unborn')
  if (!facts.hasRemote) return idle('no-remote')
  if (facts.detached || !facts.branch) return idle('detached')
  if (!facts.upstream) return result('publish', null)
  if (facts.ahead > 0 && facts.behind > 0) return result('push', 'diverged')
  if (facts.ahead > 0) return result('push', null)
  if (dirty) return result('commit', 'nothing-staged')
  if (facts.behind > 0) return result('behind', 'behind')
  return result('up-to-date', 'synced')
}

export const DEFAULT_BRANCHES: readonly string[] = ['main', 'master']

export function isDefaultBranch(branch: string | null | undefined): boolean {
  return !!branch && DEFAULT_BRANCHES.includes(branch)
}

export function needsDefaultBranchConfirm(kind: 'push' | 'publish' | 'commit-push', branch: string | null | undefined): boolean {
  return isDefaultBranch(branch) && (kind === 'push' || kind === 'publish' || kind === 'commit-push')
}

export type BranchBlock = 'current' | 'worktree' | 'running'

export type BranchPick =
  | { kind: 'switch'; branch: string }
  | { kind: 'track'; branch: string; startPoint: string }

export interface BranchOption {
  id: string
  name: string
  ref: string
  group: 'local' | 'remote'
  current: boolean
  block: BranchBlock | null
  pick: BranchPick
}

export interface BranchListInput {
  refs: readonly GitRefOption[]
  busyBranches: readonly string[]
  currentBranch: string | null
  query: string
  running: boolean
}

export interface BranchList {
  local: BranchOption[]
  remote: BranchOption[]
  exact: boolean
}

export function remoteLocalName(ref: string): string {
  const slash = ref.indexOf('/')
  return slash > 0 ? ref.slice(slash + 1) : ref
}

function matches(name: string, query: string): boolean {
  if (!query) return true
  return name.toLowerCase().includes(query)
}

export function buildBranchList(input: BranchListInput): BranchList {
  const query = input.query.trim().toLowerCase()
  const busy = new Set(input.busyBranches)
  const localNames = new Set<string>()
  const local: BranchOption[] = []
  for (const ref of input.refs) {
    if (ref.kind !== 'local' && ref.kind !== 'head') continue
    if (localNames.has(ref.ref)) continue
    localNames.add(ref.ref)
    const current = ref.current || ref.ref === input.currentBranch
    const block: BranchBlock | null = current ? 'current' : busy.has(ref.ref) ? 'worktree' : input.running ? 'running' : null
    if (!matches(ref.ref, query)) continue
    local.push({ id: `local:${ref.ref}`, name: ref.ref, ref: ref.ref, group: 'local', current, block, pick: { kind: 'switch', branch: ref.ref } })
  }
  local.sort((a, b) => Number(b.current) - Number(a.current))
  const remote: BranchOption[] = []
  for (const ref of input.refs) {
    if (ref.kind !== 'remote' || ref.label.endsWith('/HEAD') || !ref.ref.includes('/')) continue
    const name = remoteLocalName(ref.ref)
    if (!name || name === 'HEAD' || localNames.has(name)) continue
    if (!matches(ref.ref, query)) continue
    remote.push({
      id: `remote:${ref.ref}`,
      name,
      ref: ref.ref,
      group: 'remote',
      current: false,
      block: input.running ? 'running' : null,
      pick: { kind: 'track', branch: name, startPoint: ref.ref }
    })
  }
  const exact = !!query && [...local, ...remote].some((option) => option.name.toLowerCase() === query || option.ref.toLowerCase() === query)
  return { local, remote, exact }
}

export type BranchNameIssue =
  | 'empty'
  | 'too-long'
  | 'leading-dash'
  | 'slash-edge'
  | 'dot-end'
  | 'double-dot'
  | 'double-slash'
  | 'at-brace'
  | 'bad-char'
  | 'control'
  | 'exists'

export function branchNameIssue(name: string, existing: readonly string[] = []): BranchNameIssue | null {
  const s = String(name ?? '').trim()
  if (!s) return 'empty'
  if (s.length > 200) return 'too-long'
  if (s.startsWith('-')) return 'leading-dash'
  if (s.startsWith('/') || s.endsWith('/')) return 'slash-edge'
  if (s.endsWith('.') || s.endsWith('.lock')) return 'dot-end'
  if (s.includes('..')) return 'double-dot'
  if (s.includes('//')) return 'double-slash'
  if (s.includes('@{')) return 'at-brace'
  if (/[\s~^:?*[\\]/.test(s)) return 'bad-char'
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return 'control'
  }
  if (existing.some((branch) => branch.toLowerCase() === s.toLowerCase())) return 'exists'
  return null
}

export type FailureNext = 'fetch' | 'publish' | null

export interface FailureView {
  code: GitFailureCode
  message: string
  hint: string | null
  raw: string | null
  files: string[]
  moreFiles: number
  committed: boolean
  retry: 'retry' | 'refresh'
  next: FailureNext
}

const NEVER_RETRY: ReadonlySet<GitFailureCode> = new Set(['stale', 'timeout', 'cancelled', 'unknown'])

function splitFiles(detail: string): { files: string[]; more: number } {
  const files: string[] = []
  let more = 0
  for (const line of detail.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const rest = /^…\D*(\d+)/.exec(trimmed)
    if (rest) {
      more = Number(rest[1])
      continue
    }
    files.push(trimmed)
  }
  return { files, more }
}

export function failureView(result: Pick<GitActionResult, 'failure' | 'committed'>, fallbackMessage = ''): FailureView {
  const failure: GitFailure = result.failure ?? { code: 'unknown', message: fallbackMessage, retrySafe: false }
  const committed = result.committed === true
  const detail = (failure.detail ?? '').trim()
  const listed = failure.code === 'dirty-blocks-switch' && detail ? splitFiles(detail) : null
  const unknownOutcome = committed || failure.code === 'timeout'
  const next: FailureNext =
    failure.code === 'non-fast-forward' ? 'fetch' : failure.code === 'no-upstream' ? 'publish' : null
  return {
    code: failure.code,
    message: failure.message,
    hint: failure.hint ?? null,
    raw: listed ? null : detail || null,
    files: listed?.files ?? [],
    moreFiles: listed?.more ?? 0,
    committed,
    retry: !failure.retrySafe || unknownOutcome || NEVER_RETRY.has(failure.code) ? 'refresh' : 'retry',
    next
  }
}

export interface StageGroups<T> {
  staged: T[]
  unstaged: T[]
}

export interface StageFacts {
  path: string
  status: string
  untracked: boolean
  staged?: boolean
  unstaged?: boolean
}

function flag(char: string | undefined): boolean {
  return !!char && char !== '.' && char !== ' ' && char !== '?' && char !== '!'
}

export function stageState(item: StageFacts): { staged: boolean; unstaged: boolean } {
  if (item.untracked) return { staged: false, unstaged: true }
  const unmerged = /U/.test(item.status) || item.status === 'AA' || item.status === 'DD'
  const staged = item.staged ?? (unmerged || flag(item.status[0]))
  const unstaged = item.unstaged ?? (unmerged || flag(item.status[1]))
  return { staged, unstaged: unstaged || (!staged && !unstaged) }
}

export function groupByStage<T extends StageFacts>(items: readonly T[]): StageGroups<T> {
  const staged: T[] = []
  const unstaged: T[] = []
  for (const item of items) {
    const state = stageState(item)
    if (state.staged) staged.push(item)
    if (state.unstaged) unstaged.push(item)
  }
  return { staged, unstaged }
}

export function unstagePaths(item: { path: string; origPath?: string }): string[] {
  return item.origPath && item.origPath !== item.path ? [item.path, item.origPath] : [item.path]
}

export function stagedTotals<T extends { added?: number; removed?: number }>(items: readonly T[]): { files: number; added: number; removed: number; known: boolean } {
  let added = 0
  let removed = 0
  let known = false
  for (const item of items) {
    if (item.added === undefined && item.removed === undefined) continue
    known = true
    added += item.added ?? 0
    removed += item.removed ?? 0
  }
  return { files: items.length, added, removed, known }
}

export function canonicalPath(path: string): string {
  const slashed = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-zA-Z]:/.test(slashed) ? slashed.toLowerCase() : slashed
}

export function cwdBusy(runners: readonly { cwd: string; running: boolean }[], root: string | null | undefined): boolean {
  if (!root) return false
  const key = canonicalPath(root)
  return runners.some((runner) => runner.running && canonicalPath(runner.cwd) === key)
}
