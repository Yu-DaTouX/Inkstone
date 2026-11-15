import { resolve } from 'node:path'
import { pick } from '../shared/ui-lang'
import type { GitActionExpected } from '../shared/git-actions'
import type { GitChangesOptions, GitChangesResult, GitDiffResult, GitRefOption, GitRepoState } from '../shared/git'
import { findGitMarker, forgetRepo, gitRun, listRefs, readRepoSnapshot, readRepoState, readRepoStatusState, resolveRepo } from './git-service'
import { listRemotes } from './git-actions'
import { readChanges, readFileDiff } from './git-inspect'
import type { AuthorizeReadCwd, FileDiffOptions } from './git-inspect'

export type GitReadRequest =
  | { op: 'state'; cwd: string; light: boolean; fresh?: boolean }
  | { op: 'refs'; cwd: string }
  | { op: 'changes'; cwd: string; options: GitChangesOptions }
  | { op: 'diff'; cwd: string; path: string; options: FileDiffOptions }
  | { op: 'remotes'; cwd: string }

export interface GitReadReplies {
  state: { repo: GitRepoState | null; expected?: GitActionExpected; error?: string }
  refs: { ok: boolean; refs: GitRefOption[]; busyBranches: string[]; error?: string }
  changes: GitChangesResult
  diff: GitDiffResult
  remotes: string[]
}

export type GitReadOp = GitReadRequest['op']
export type GitReadRequestOf<K extends GitReadOp> = Extract<GitReadRequest, { op: K }>

type GitReadHandlers = { [K in GitReadOp]: (request: GitReadRequestOf<K>, authorize: AuthorizeReadCwd) => Promise<GitReadReplies[K]> }

function describeUnreadableRepo(marker: string, output: string): string {
  const detail = (output.split(/\r?\n/).find((line) => line.trim()) ?? '').trim()
  const reason = detail ? `（${detail}）` : ''
  const reasonEn = detail ? ` (${detail})` : ''
  if (/dubious ownership|safe\.directory/i.test(output)) {
    return pick(`Git 拒绝读取 ${marker}：仓库目录的属主和当前用户不符${reason}`, `Git refused to read ${marker}: the repository is owned by a different user${reasonEn}`)
  }
  if (/permission denied/i.test(output)) {
    return pick(`没有权限读取 ${marker}${reason}`, `No permission to read ${marker}${reasonEn}`)
  }
  return pick(`无法读取 ${marker}${reason}`, `Cannot read ${marker}${reasonEn}`)
}

const UNREADABLE_TTL = 30_000
const UNREADABLE_LIMIT = 64
const unreadableCache = new Map<string, { at: number; value: string | null }>()

async function probeUnreadableRepo(cwd: string): Promise<string | null> {
  const marker = await findGitMarker(cwd)
  if (!marker) return null
  const res = await gitRun(cwd, ['rev-parse', '--git-dir'], { allowFailure: true, timeout: 8000 })
  if (res.ok) return null
  return describeUnreadableRepo(marker, res.error ?? '')
}

async function unreadableRepoError(cwd: string): Promise<string | null> {
  const key = resolve(cwd)
  const cached = unreadableCache.get(key)
  if (cached && Date.now() - cached.at < UNREADABLE_TTL) return cached.value
  const value = await probeUnreadableRepo(cwd)
  unreadableCache.delete(key)
  unreadableCache.set(key, { at: Date.now(), value })
  while (unreadableCache.size > UNREADABLE_LIMIT) {
    const oldest = unreadableCache.keys().next().value
    if (oldest === undefined) break
    unreadableCache.delete(oldest)
  }
  return value
}

const handlers: GitReadHandlers = {
  async state({ cwd, light, fresh }) {
    if (fresh) {
      forgetRepo(cwd)
      unreadableCache.delete(resolve(cwd))
    }
    const repo = await resolveRepo(cwd)
    if (!repo) {
      const error = await unreadableRepoError(cwd)
      return error ? { repo: null, error } : { repo: null }
    }
    if (light) return { repo: await readRepoStatusState(repo) }
    return await readRepoSnapshot(repo)
  },
  async refs({ cwd }) {
    const repo = await readRepoState(cwd, { withRefs: false })
    if (!repo) return { ok: false, refs: [], busyBranches: [], error: pick('这个目录不在 Git 仓库里', 'This folder is not in a Git repository') }
    const listing = await listRefs(repo.root)
    return { ok: true, refs: listing.refs, busyBranches: listing.busyBranches }
  },
  changes({ cwd, options }, authorize) {
    return readChanges(cwd, authorize, options)
  },
  diff({ cwd, path, options }, authorize) {
    return readFileDiff(cwd, path, authorize, options)
  },
  async remotes({ cwd }) {
    const repo = await resolveRepo(cwd)
    return repo ? await listRemotes(repo.root) : []
  }
}

export function runGitReadOp<K extends GitReadOp>(request: GitReadRequestOf<K>, authorize: AuthorizeReadCwd): Promise<GitReadReplies[K]> {
  const run = handlers[request.op] as (request: GitReadRequestOf<K>, authorize: AuthorizeReadCwd) => Promise<GitReadReplies[K]>
  return run(request, authorize)
}
