import { pick } from '../shared/ui-lang'
import type { GitActionExpected } from '../shared/git-actions'
import type { GitChangesOptions, GitChangesResult, GitDiffResult, GitRefOption, GitRepoState } from '../shared/git'
import { listRefs, readRepoSnapshot, readRepoState, readRepoStatusState, resolveRepo } from './git-service'
import { listRemotes } from './git-actions'
import { readChanges, readFileDiff } from './git-inspect'
import type { AuthorizeReadCwd, FileDiffOptions } from './git-inspect'

export type GitReadRequest =
  | { op: 'state'; cwd: string; light: boolean }
  | { op: 'refs'; cwd: string }
  | { op: 'changes'; cwd: string; options: GitChangesOptions }
  | { op: 'diff'; cwd: string; path: string; options: FileDiffOptions }
  | { op: 'remotes'; cwd: string }

export interface GitReadReplies {
  state: { repo: GitRepoState | null; expected?: GitActionExpected }
  refs: { ok: boolean; refs: GitRefOption[]; busyBranches: string[]; error?: string }
  changes: GitChangesResult
  diff: GitDiffResult
  remotes: string[]
}

export type GitReadOp = GitReadRequest['op']
export type GitReadRequestOf<K extends GitReadOp> = Extract<GitReadRequest, { op: K }>

type GitReadHandlers = { [K in GitReadOp]: (request: GitReadRequestOf<K>, authorize: AuthorizeReadCwd) => Promise<GitReadReplies[K]> }

const handlers: GitReadHandlers = {
  async state({ cwd, light }) {
    const repo = await resolveRepo(cwd)
    if (!repo) return { repo: null }
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
