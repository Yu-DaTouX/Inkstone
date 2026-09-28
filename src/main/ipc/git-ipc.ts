/**
 * Git 审查、写操作、用户工作树与托管网页的 IPC 适配（`yan:git:*`）。
 *
 * 渲染端只能传 cwd / 范围 / 路径，不能传 git 命令：命令形状全部在主进程里固定，
 * 路径与 ref 在 git-service 里单独校验；写操作的防护在 git-actions.ts。
 */
import type { IpcRegistrar } from './registrar'
import type { GitScopeRequest } from '../../shared/ipc'
import { fileContent, filePatch, reviewSnapshot } from '../git-diff'
import { readExpected, readRepoState, listRefs, resolveRepo } from '../git-service'
import { listRemotes, remoteWeb, runGitAction } from '../git-actions'
import { prStatus } from '../hosting'
import { createWorktree, listWorktrees, removeWorktree } from '../git-worktree'
import type { WorktreeLinkStore } from '../worktree-links'

/**
 * 审查范围来自渲染端，一律当**不可信输入**校验。
 *
 * 参数数组已经挡住了 shell 注入，但 `--` 之前的**选项注入**还挡不住：
 * 一个形如 `--upload-pack=…` 的「ref」会被 git 当成选项。所以这里
 * 只放行 git ref 的合法字符集，并且**不以 `-` 开头**。
 * 任何不合法 / 缺失的范围都退回「工作区全部改动」—— 它是纯只读的，
 * 退到它不会造成任何破坏，而报错会让整个审查面板打不开。
 */
export function normalizeScope(raw: unknown): GitScopeRequest {
  const rec = (raw ?? {}) as Record<string, unknown>
  const clean = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s || s.startsWith('-') || s.length > 250) return undefined
    if (!/^[\w./@^~{}+-]+$/.test(s)) return undefined
    return s
  }
  if (rec.kind === 'working' || rec.kind === 'unstaged' || rec.kind === 'staged') return { kind: rec.kind }
  if (rec.kind === 'range') {
    const base = clean(rec.base)
    const target = clean(rec.target)
    if (base && target) return { kind: 'range', base, target }
  }
  return { kind: 'working' }
}

export interface GitIpcDeps {
  /** 这个目录有没有正在跑的任务（切分支、删工作树前必须问） */
  isCwdBusy(dir: string): boolean
  /** 「会话 ↔ 工作树」来源关系 */
  worktreeOrigins: WorktreeLinkStore
}

export function registerGitIpc(ipc: IpcRegistrar, deps: GitIpcDeps): void {
  const { handle } = ipc
  const { isCwdBusy, worktreeOrigins } = deps
  /*
   * ---- Git 审查（只读，方案 G1）----
   *
   * 渲染端只能传 cwd / 范围 / 路径，**不能传 git 命令**（方案 §11）：
   * 命令形状全部在主进程里固定，路径与 ref 在 git-service 里单独校验。
   * 每个响应带回 requestId，用户切项目后渲染端靠它丢弃迟到结果。
   */
  handle('yan:git:state', async (cwd: string) => {
    try {
      const dir = String(cwd ?? '')
      const repo = await resolveRepo(dir)
      if (!repo) return { repo: null }
      /*
       * 一起把「预期版本」带回去：环境菜单里的写操作（切分支 / 拉取 / 推送）
       * 同样要带上用户看到的那个版本，而菜单没有审查快照可用。
       * 两次读取与菜单显示的内容是**同一个时刻**的（差几毫秒），
       * 而且先读版本更安全（见 git-diff.ts 里 reviewSnapshot 的同一段说明）。
       */
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
  handle('yan:git:snapshot', async (req: { cwd?: string; scope?: unknown; requestId?: string }) =>
    reviewSnapshot({
      cwd: String(req?.cwd ?? ''),
      scope: normalizeScope(req?.scope),
      requestId: String(req?.requestId ?? '')
    })
  )
  handle(
    'yan:git:patch',
    async (req: {
      cwd?: string
      scope?: unknown
      requestId?: string
      path?: string
      oldPath?: string
      untracked?: boolean
    }) =>
      filePatch({
        cwd: String(req?.cwd ?? ''),
        scope: normalizeScope(req?.scope),
        requestId: String(req?.requestId ?? ''),
        path: String(req?.path ?? ''),
        oldPath: req?.oldPath ? String(req.oldPath) : undefined,
        untracked: !!req?.untracked
      })
  )
  handle(
    'yan:git:content',
    async (req: {
      cwd?: string
      scope?: unknown
      requestId?: string
      path?: string
      side?: string
    }) =>
      fileContent({
        cwd: String(req?.cwd ?? ''),
        scope: normalizeScope(req?.scope),
        requestId: String(req?.requestId ?? ''),
        path: String(req?.path ?? ''),
        /* side 只认 old / new，别的一律当 old（宁可少给一侧也不给错一侧） */
        side: req?.side === 'new' ? 'new' : 'old'
      })
  )

  /*
   * ---- Git 写操作（方案 §5，G2）----
   *
   * 这是整个应用里**唯一**会改用户 Git 状态的入口。防护在 git-actions.ts 里
   * （按仓库串行、执行前复核预期版本、不 stash/reset/force），这里只做三件事：
   *   · 剥掉渲染端不该决定的东西（命令形状一律由主进程构造）
   *   · 把「这个目录有没有在跑的任务」注入进去 —— 切分支前必须问（方案 §5.1）
   *   · 兜异常，保证渲染端**永远**能拿到一个结果（否则界面会一直转圈）
   */
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
  /*
   * ---- 用户工作树（方案 §6.2，W1）----
   *
   * 注意与子代理隔离工作树的区别：那条路径是「一次性容器 + --force 清理」，
   * 这里建的会被用户长期使用，所以删除前逐项检查，且**没有** force 入口。
   * 「有任务在跑」的判据与切分支同一个（注入的 runner 状态）。
   */
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
          /*
           * 携带未提交改动（W2a）。这里**逐字段取值**而不是把 raw 直接传下去：
           * 渲染端来的东西是不可信输入，多传一个字段就可能多一条能改用户仓库的路径。
           * untracked 只收字符串，且由主进程再跟 `git ls-files --others` 对一遍。
           */
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

  /*
   * 「会话 ↔ 工作树」的来源关系（实施-07 S2）。
   *
   * 登记发生在渲染端：「开新会话」是在**新目录**里开一条新会话，
   * 而主进程这边 `newSession` / `select` 并不知道用户是从哪个工作树按钮点过来的。
   * 读回是全量的 —— 界面要回答「这个会话从哪来」，而列表本身很小。
   */
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

  /*
   * remote 的托管网页地址（方案 §7 的托管网页比较，只读）。
   * 渲染端拿到的只是一个 https 链接 —— 它**不能**让主进程跑任意 git 命令，
   * 这条通道也一样（remote 名字由主进程自己挑）。
   */
  /*
   * 关联 PR 的状态（§7）。**只读** —— 不创建、不合并、不评论。
   *
   * token 只从环境变量读（GITHUB_TOKEN / GH_TOKEN）：不落盘、不进设置，
   * 也不去翻用户的 ~/.config/gh（那是 gh 自己的东西）。没有 token 时
   * GitHub 允许匿名读公开仓库，私有仓库会返回 404/403，那时界面如实显示
   * 「需要认证」—— 不编状态。
   */
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
