import type { IpcRegistrar } from './registrar'
import { readExpected, readRepoState, listRefs, resolveRepo } from '../git-service'
import { listRemotes, remoteWeb, runGitAction } from '../git-actions'
import { prStatus } from '../hosting'
import { createWorktree, listUntracked, listWorktrees, removeWorktree } from '../git-worktree'
import { readChanges, readFileDiff } from '../git-inspect'
import type { AuthorizeReadCwd } from '../git-inspect'
import type { WorktreeLinkStore } from '../worktree-links'

export interface GitIpcDeps {
  isCwdBusy(dir: string): boolean
  worktreeOrigins: WorktreeLinkStore
  authorizeReadCwd: AuthorizeReadCwd
}

export function registerGitIpc(ipc: IpcRegistrar, deps: GitIpcDeps): void {
  const { handle } = ipc
  const { isCwdBusy, worktreeOrigins, authorizeReadCwd } = deps
  handle('yan:git:state', async (cwd: string) => {
    try {
      const dir = String(cwd ?? '')
      const repo = await resolveRepo(dir)
      if (!repo) return { repo: null }
      const expected = await readExpected(repo.root)
      return { repo: await readRepoState(repo.root), expected }
    } catch (error) {
      return { repo: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
  handle('yan:git:refs', async (cwd: string) => {
    try {
      const repo = await readRepoState(String(cwd ?? ''), { withRefs: false })
      if (!repo) return { ok: false, refs: [], busyBranches: [], error: '这个目录不在 Git 仓库里' }
      const listing = await listRefs(repo.root)
      return { ok: true, refs: listing.refs, busyBranches: listing.busyBranches }
    } catch (error) {
      return {
        ok: false,
        refs: [],
        busyBranches: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  handle('yan:git:changes', async (cwd: string) => {
    try {
      return await readChanges(String(cwd ?? ''), authorizeReadCwd)
    } catch (error) {
      return {
        ok: false,
        root: null,
        scope: '.',
        branch: null,
        detached: false,
        unborn: false,
        head: null,
        files: [],
        truncated: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  handle('yan:git:diff', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    const cwd = String(raw.cwd ?? '')
    const path = String(raw.path ?? '')
    try {
      return await readFileDiff(cwd, path, authorizeReadCwd)
    } catch (error) {
      return {
        ok: false,
        path,
        patch: '',
        truncated: false,
        binary: false,
        staged: false,
        unstaged: false,
        untracked: false,
        bytes: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  handle('yan:git:action', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    const cwd = String(raw.cwd ?? '')
    const expected = (raw.expected ?? {}) as Record<string, unknown>
    const base = {
      requestId: String(raw.requestId ?? ''),
      cwd,
      expected: {
        head: typeof expected.head === 'string' ? expected.head : null,
        indexDigest: String(expected.indexDigest ?? ''),
        statusDigest: String(expected.statusDigest ?? '')
      }
    }
    const kind = String(raw.kind ?? '')
    const paths = Array.isArray(raw.paths) ? raw.paths.map((v) => String(v ?? '')) : []
    const message = typeof raw.message === 'string' ? raw.message : ''
    const branch = typeof raw.branch === 'string' ? raw.branch : ''
    const startPoint = typeof raw.startPoint === 'string' && raw.startPoint ? raw.startPoint : null
    const remote = typeof raw.remote === 'string' && raw.remote ? raw.remote : null

    let action: Parameters<typeof runGitAction>[0]
    switch (kind) {
      case 'stage':
      case 'unstage':
        action = { ...base, kind, paths }
        break
      case 'stage-all':
      case 'unstage-all':
        action = { ...base, kind }
        break
      case 'commit':
        action = { ...base, kind, message }
        break
      case 'switch-branch':
        action = { ...base, kind, branch }
        break
      case 'create-branch':
        action = { ...base, kind, branch, startPoint, checkout: !!raw.checkout }
        break
      case 'fetch':
        action = { requestId: base.requestId, cwd, kind, remote }
        break
      case 'push':
        action = {
          ...base,
          kind,
          remote,
          setUpstream: !!raw.setUpstream,
          branch: branch || null
        }
        break
      default:
        return {
          ok: false,
          failure: { code: 'unknown', message: `不支持的操作：${kind}`, retrySafe: false }
        }
    }
    try {
      return await runGitAction(action)
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: 'unknown',
          message: error instanceof Error ? error.message : String(error),
          retrySafe: false
        }
      }
    }
  })
  handle('yan:git:untracked', async (cwd: string) => listUntracked(String(cwd ?? '')))
  handle('yan:git:worktrees', async (cwd: string) => {
    try {
      return await listWorktrees(String(cwd ?? ''))
    } catch (error) {
      return {
        ok: false,
        repoRoot: '',
        worktrees: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  handle('yan:git:worktreeCreate', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return await createWorktree(
        {
          cwd: String(raw.cwd ?? ''),
          branch: String(raw.branch ?? ''),
          startPoint: typeof raw.startPoint === 'string' && raw.startPoint ? raw.startPoint : null,
          targetPath: typeof raw.targetPath === 'string' && raw.targetPath ? raw.targetPath : null,
          carry: (() => {
            const c = raw.carry as Record<string, unknown> | null | undefined
            if (!c || typeof c !== 'object') return null
            return {
              staged: c.staged === true,
              unstaged: c.unstaged === true,
              untracked: Array.isArray(c.untracked) ? c.untracked.filter((x): x is string => typeof x === 'string') : []
            }
          })()
        },
        isCwdBusy
      )
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: 'unknown',
          message: error instanceof Error ? error.message : String(error),
          retrySafe: false
        }
      }
    }
  })
  handle('yan:git:worktreeRemove', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return await removeWorktree(
        {
          cwd: String(raw.cwd ?? ''),
          path: String(raw.path ?? ''),
          deleteBranch: !!raw.deleteBranch
        },
        isCwdBusy
      )
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: 'unknown',
          message: error instanceof Error ? error.message : String(error),
          retrySafe: false
        }
      }
    }
  })

  handle('yan:git:worktreeLink', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      return await worktreeOrigins.link({
        sessionId: String(raw.sessionId ?? ''),
        sessionFile: typeof raw.sessionFile === 'string' ? raw.sessionFile : undefined,
        worktree: String(raw.worktree ?? ''),
        branch: typeof raw.branch === 'string' ? raw.branch : undefined,
        fromSessionId: typeof raw.fromSessionId === 'string' ? raw.fromSessionId : undefined,
        fromSessionFile: typeof raw.fromSessionFile === 'string' ? raw.fromSessionFile : undefined,
        fromCwd: typeof raw.fromCwd === 'string' ? raw.fromCwd : undefined
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  handle('yan:git:worktreeLinks', async () => {
    try {
      await worktreeOrigins.load()
      return worktreeOrigins.links()
    } catch {
      return []
    }
  })

  handle('yan:git:prStatus', async (cwd: string) => {
    try {
      const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || null
      return await prStatus(String(cwd ?? ''), token)
    } catch (error) {
      return {
        ok: false,
        state: 'none' as const,
        checks: 'none' as const,
        error: 'unknown' as const,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  handle('yan:git:remoteWeb', async (cwd: string) => {
    try {
      return await remoteWeb(String(cwd ?? ''))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:git:remotes', async (cwd: string) => {
    try {
      const repo = await resolveRepo(String(cwd ?? ''))
      return repo ? await listRemotes(repo.root) : []
    } catch {
      return []
    }
  })
}
