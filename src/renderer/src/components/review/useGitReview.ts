/**
 * Git 审查的数据钩子（渲染端）。
 *
 * 为什么不把这些状态放进全局 store：审查的数据是**视图级**的
 *（跟着范围、跟着打开/关闭走），而 store 里已有 40 多个字段；
 * 再塞四个大对象（快照 / 每个文件的 patch / 已查看 / 仓库状态）进去，
 * 每次推送都会让订阅它的组件重算。这里用组件级 state + 一个小缓存。
 *
 * 唯一进 store 的是「面板开着吗」与「当前范围」—— 因为环境菜单、右栏、
 * 审查面板三个组件都要读它。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  GitActionExpected,
  GitActionRequest,
  GitActionResult,
  GitChangedFile,
  GitFailure,
  GitFileContent,
  GitFilePatch,
  GitRepoState,
  GitReviewSnapshot,
  GitScopeRequest
} from '../../../../shared/ipc'
import { scopeIdentity, viewedKey } from '../../../../shared/git'

/**
 * 请求闸门：迟到响应靠它丢弃（方案 §11）。
 *
 * ⚠️ 必须**分成“领号”与“对号”两步**。
 * 曾经写成单个 `gate()` —— 它调用一次就自增一次，于是 `.then` 里的
 * `gate() !== id` **永远成立**（每次调用都产生新号），所有响应都被当成
 * 迟到丢弃。表现是「点了菜单什么也没有，界面停在未使用 Git」，
 * 而主进程其实已经把正确的数据返回了。
 */
interface RequestGate {
  /** 领一个号（自增） */
  next: () => number
  /** 我领的号还是当前最新的吗 */
  isCurrent: (id: number) => boolean
}

function useRequestGate(): RequestGate {
  const seq = useRef(0)
  const next = useCallback(() => {
    seq.current += 1
    return seq.current
  }, [])
  const isCurrent = useCallback((id: number) => seq.current === id, [])
  return useMemo(() => ({ next, isCurrent }), [next, isCurrent])
}

/* ── 仓库状态（环境菜单） ───────────────────────────────── */

export interface RepoStateView {
  repo: GitRepoState | null
  /** 读到这份状态时的仓库版本（环境菜单的写操作要用它复核） */
  expected: GitActionExpected | undefined
  error: string
  loading: boolean
  refresh: () => void
  /**
   * 用一个**刚回来的**状态就地更新（写操作成功后用）。
   *
   * 为什么需要它：写操作的响应里带着动作之后的状态，而完整刷新要再走一个
   * 往返。中间那段时间里，用户紧接着点的下一步会带着**过期的 HEAD** 被主进程
   * 拒成 stale —— 真实运行里就是这样：切回 main 后马上新建分支，创建请求
   * 里的 expected.head 还是 feature 的提交。
   *
   * ⚠️ 索引与工作区的摘要**故意置空**：它们在这条路径上没有真实来源，
   * 而空摘要永远匹配不上实际值 —— 于是任何需要「全比」的动作（只有 commit）
   * 会照常被拒（安全方向），只用 HEAD 的动作则立刻可用。
   */
  apply: (state: GitRepoState) => void
}

/**
 * 拉一次仓库状态。
 *
 * 刷新时机（方案 §4.3 的「轻量监听 + 防抖」）：cwd 变化、手动刷新、
 * 窗口重新获焦（用户在终端里提交完回来，数字必须是对的）。
 * 刻意**不**做文件系统监听：那是递归 watch 整个仓库，代价远大于收益。
 */
export function useRepoState(cwd: string | undefined, deps: unknown[] = []): RepoStateView {
  const [repo, setRepo] = useState<GitRepoState | null>(null)
  const [expected, setExpected] = useState<GitActionExpected | undefined>(undefined)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const gate = useRequestGate()

  useEffect(() => {
    if (!cwd) {
      setRepo(null)
      setError('')
      return
    }
    let alive = true
    const id = gate.next()
    setLoading(true)
    void window.yan.git
      .state(cwd)
      .then((res) => {
        if (!alive || !gate.isCurrent(id)) return
        setRepo(res.repo)
        setExpected(res.expected)
        setError(res.error ?? '')
      })
      .catch((e: unknown) => {
        if (!alive || !gate.isCurrent(id)) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, tick, ...deps])

  useEffect(() => {
    let at = 0
    const onFocus = (): void => {
      const now = Date.now()
      /* 防抖 2s：获焦可能在短时间内触发多次（切窗口、点托盘） */
      if (now - at < 2000) return
      at = now
      setTick((v) => v + 1)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const refresh = useCallback(() => setTick((v) => v + 1), [])
  const apply = useCallback((state: GitRepoState) => {
    setRepo(state)
    setExpected({ head: state.head, indexDigest: '', statusDigest: '' })
  }, [])
  return { repo, expected, error, loading, refresh, apply }
}

/* ── 变更清单 ───────────────────────────────────────────── */

export interface ReviewSnapshotView {
  snapshot: GitReviewSnapshot | null
  loading: boolean
  error: string
  refresh: () => void
  /** 只有仓库身份变化时才换的键（用于「已查看」的作用域） */
  identity: { repoId: string; worktreeId: string; scope: string } | null
}

export function useReviewSnapshot(
  cwd: string | undefined,
  scope: GitScopeRequest,
  enabled: boolean,
  /** 额外的刷新触发器（例如「任务结束」） */
  bump = 0
): ReviewSnapshotView {
  const [snapshot, setSnapshot] = useState<GitReviewSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const gate = useRequestGate()
  const scopeKey = scopeIdentity(scope)

  useEffect(() => {
    if (!enabled || !cwd) return
    let alive = true
    const id = gate.next()
    setLoading(true)
    void window.yan.git
      .snapshot({ cwd, scope, requestId: `g${id}` })
      .then((snap) => {
        /* 迟到的响应：号对不上就丢掉（用户已经切了范围/项目） */
        if (!alive || !gate.isCurrent(id)) return
        setSnapshot(snap)
        setError(snap.ok ? '' : (snap.error ?? '读取失败'))
      })
      .catch((e: unknown) => {
        if (!alive || !gate.isCurrent(id)) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, scopeKey, scope.base, scope.target, scope.kind, enabled, tick, bump])

  useEffect(() => {
    if (!enabled) return
    let at = 0
    const onFocus = (): void => {
      const now = Date.now()
      if (now - at < 2000) return
      at = now
      setTick((v) => v + 1)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled])

  const refresh = useCallback(() => setTick((v) => v + 1), [])
  const identity = useMemo(
    () =>
      snapshot?.repo
        ? { repoId: snapshot.repo.repoId, worktreeId: snapshot.repo.worktreeId, scope: scopeKey }
        : null,
    [snapshot?.repo?.repoId, snapshot?.repo?.worktreeId, scopeKey]
  )
  return { snapshot, loading, error, refresh, identity }
}

/* ── 单文件 patch（懒加载 + 缓存） ─────────────────────── */

export type PatchState = { status: 'loading' } | { status: 'ready'; patch: GitFilePatch } | { status: 'error'; error: string }

export interface PatchStore {
  /** 已加载的 patch（key 是文件路径） */
  patches: Record<string, PatchState>
  /** 保证某个文件被加载（已有缓存就不重复请求） */
  ensure: (file: GitChangedFile) => void
  /** 丢掉某个文件的缓存（外部改动后要重读） */
  invalidate: (path: string) => void
  clear: () => void
}

/**
 * 按文件懒加载 patch。
 *
 * 为什么必须懒加载：一个工程级改动可能有上千个文件、单个 diff 几 MB。
 * 一次性全拉进内存会（a）慢，（b）让「已查看」的失效判断变复杂，
 * （c）在 IPC 上搬一堆用户还没看的字节。
 * 只加载**用户真的展开/滚到**的那些文件。
 */
export function usePatchStore(cwd: string | undefined, scope: GitScopeRequest, requestId: string): PatchStore {
  const [patches, setPatches] = useState<Record<string, PatchState>>({})
  const inflight = useRef(new Set<string>())
  const scopeKey = scopeIdentity(scope)

  /* 范围或请求身份一变，旧缓存全部作废（不同范围的同一个文件内容不同） */
  useEffect(() => {
    setPatches({})
    inflight.current.clear()
  }, [cwd, scopeKey, scope.base, scope.target, requestId])

  const ensure = useCallback(
    (file: GitChangedFile) => {
      const key = patchKeyOf(file)
      /*
       * 副作用（发 IPC）必须在 setState 的 updater **外面**：
       * StrictMode 下 updater 会被调两次，写在里面会发两个请求，
       * 而且第二次调用会把第一次的 loading 状态丢掉。
       */
      if (inflight.current.has(key)) return
      inflight.current.add(key)
      setPatches((prev) => (prev[key]?.status === 'ready' ? prev : { ...prev, [key]: { status: 'loading' } }))
      void window.yan.git
        .patch({
          cwd: cwd ?? '',
          scope,
          requestId,
          path: file.path,
          oldPath: file.oldPath,
          untracked: file.untracked
        })
        .then((patch) => {
          setPatches((p) => ({ ...p, [key]: { status: 'ready', patch } }))
        })
        .catch((e: unknown) => {
          setPatches((p) => ({
            ...p,
            [key]: { status: 'error', error: e instanceof Error ? e.message : String(e) }
          }))
        })
        .finally(() => {
          inflight.current.delete(key)
        })
    },
    [cwd, scope, requestId]
  )

  const invalidate = useCallback((path: string) => {
    setPatches((prev) => {
      const next = { ...prev }
      for (const k of Object.keys(next)) if (k.startsWith(`${path}|`)) delete next[k]
      return next
    })
  }, [])

  const clear = useCallback(() => setPatches({}), [])
  return { patches, ensure, invalidate, clear }
}

/** patch 缓存的键：rename 的旧路径也算进去（同一次比较里可能有两条同名） */
export function patchKeyOf(file: Pick<GitChangedFile, 'path' | 'oldPath'>): string {
  return `${file.path}|${file.oldPath ?? ''}`
}

/* ── 两侧内容（图片 / 缺失侧） ─────────────────────────── */

export function useSideContent(
  cwd: string | undefined,
  scope: GitScopeRequest,
  open: boolean
): {
  load: (path: string, side: 'old' | 'new') => Promise<GitFileContent>
  cache: Record<string, GitFileContent | 'loading'>
} {
  const [cache, setCache] = useState<Record<string, GitFileContent | 'loading'>>({})
  const scopeKey = scopeIdentity(scope)
  useEffect(() => {
    setCache({})
  }, [cwd, scopeKey, scope.base, scope.target])

  const load = useCallback(
    async (path: string, side: 'old' | 'new'): Promise<GitFileContent> => {
      const key = `${side}|${path}`
      setCache((p) => ({ ...p, [key]: 'loading' }))
      try {
        const res = await window.yan.git.content({
          cwd: cwd ?? '',
          scope,
          requestId: `c-${Date.now().toString(36)}`,
          path,
          side
        })
        setCache((p) => ({ ...p, [key]: res }))
        return res
      } catch (e) {
        const failure: GitFileContent = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          path,
          side,
          kind: 'text',
          missing: false,
          bytes: 0,
          truncated: false,
          requestId: ''
        }
        setCache((p) => ({ ...p, [key]: failure }))
        return failure
      }
    },
    [cwd, scope, open]
  )

  return { load, cache }
}

/* ── 已查看（持久化） ───────────────────────────────────── */

const VIEWED_STORE = 'yan.git.viewed'
/** 上限：超了按「最近使用」淘汰（数组头部是最新） */
const VIEWED_MAX = 4000

function readViewed(): string[] {
  try {
    const raw = localStorage.getItem(VIEWED_STORE)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function writeViewed(list: string[]): void {
  try {
    localStorage.setItem(VIEWED_STORE, JSON.stringify(list.slice(0, VIEWED_MAX)))
  } catch {
    /* 配额满 / file:// 下 localStorage 不可用：静默降级为「本次运行有效」 */
  }
}

export interface ViewedStore {
  /** 某个文件在这一身份下是否已标记 */
  isViewed: (file: GitChangedFile, identity: { repoId: string; worktreeId: string; scope: string } | null) => boolean
  mark: (file: GitChangedFile, identity: { repoId: string; worktreeId: string; scope: string } | null) => void
  unmark: (file: GitChangedFile, identity: { repoId: string; worktreeId: string; scope: string } | null) => void
  markAll: (files: GitChangedFile[], identity: { repoId: string; worktreeId: string; scope: string } | null) => void
  clearTrack: () => void
  count: number
}

/**
 * 「已查看」标记。
 *
 * 键由 `viewedKey()` 算（仓库 + 工作树 + 范围 + 两侧路径 + 两侧指纹）——
 * 内容是**指纹**参与身份的，所以文件一改，旧标记自动失效，而其它文件的
 * 标记不动（方案 §4.3）。这不是「滚动经过就算看过」：必须用户明确点。
 */
export function useViewedStore(): ViewedStore {
  const [list, setList] = useState<string[]>(() => (typeof localStorage === 'undefined' ? [] : readViewed()))

  const commit = useCallback((next: string[]) => {
    setList(next)
    writeViewed(next)
  }, [])

  const keyOf = useCallback(
    (
      file: GitChangedFile,
      identity: { repoId: string; worktreeId: string; scope: string } | null
    ): string =>
      identity
        ? viewedKey({
            repoId: identity.repoId,
            worktreeId: identity.worktreeId,
            scope: identity.scope,
            path: file.path,
            oldPath: file.oldPath,
            oldFingerprint: file.oldFingerprint,
            newFingerprint: file.newFingerprint
          })
        : '',
    []
  )

  /* 用 Set 做 O(1) 查询 —— 列表可能上千条，每行都 includes 是 O(n²) */
  const set = useMemo(() => new Set(list), [list])

  return {
    isViewed: (file, identity) => {
      const k = keyOf(file, identity)
      return !!k && set.has(k)
    },
    mark: (file, identity) => {
      const k = keyOf(file, identity)
      if (!k) return
      commit([k, ...list.filter((x) => x !== k)])
    },
    unmark: (file, identity) => {
      const k = keyOf(file, identity)
      if (!k) return
      commit(list.filter((x) => x !== k))
    },
    markAll: (files, identity) => {
      const keys = files.map((f) => keyOf(f, identity)).filter(Boolean)
      if (!keys.length) return
      const drop = new Set(keys)
      commit([...keys, ...list.filter((x) => !drop.has(x))])
    },
    clearTrack: () => commit([]),
    count: set.size
  }
}

/* ── 写操作（方案 §5，G2） ──────────────────────────────── */

/**
 * 写操作的**输入**（不含 requestId / cwd / expected —— 那三样由 hook 填）。
 *
 * 手写一份而不是 `Omit<GitActionRequest, …>`：`Omit` 作用在联合类型上会把
 * 各分支揉成一个，`kind` 与字段的对应关系就丢了 —— 那正是这里最需要
 * 编译器帮忙的地方（`push` 必须有 remote，`stage` 必须有 paths）。
 */
export type GitWriteInput =
  | { kind: 'stage' | 'unstage'; paths: string[] }
  | { kind: 'stage-all' | 'unstage-all' }
  | { kind: 'commit'; message: string }
  | { kind: 'switch-branch'; branch: string }
  | { kind: 'create-branch'; branch: string; startPoint: string | null; checkout: boolean }
  | { kind: 'fetch'; remote?: string | null }
  | { kind: 'push'; remote: string | null; branch: string | null; setUpstream: boolean }

export interface GitWriteView {
  /** 正在跑的动作（'' = 空闲）。界面靠它禁用按钮，避免重复点击 */
  busy: string
  /** 最近一次失败（结构化，带分类与原文） */
  failure: GitFailure | null
  /** 最近一次成功的摘要行 */
  notice: string
  run: (input: GitWriteInput, expected: GitActionExpected) => Promise<GitActionResult>
  clear: () => void
}

/**
 * 发一个写操作。
 *
 * `expected` 必须来自**当前显示的那份快照**（`snapshot.expected`）——
 * 主进程拿它复核「用户看到的」与「将被改动的」是不是同一份（方案 §5.4）。
 * 这里不自己再读一次状态：那会让复核变成比两份不同时刻的数据。
 *
 * 结束时**无论成败**都回调 `onDone`：失败也可能是「其实成功了」（超时），
 * 界面必须刷新看真实状态，而不是停在旧数字上。
 */
export function useGitWrite(
  cwd: string | undefined,
  onDone?: (res: GitActionResult) => void
): GitWriteView {
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState<GitFailure | null>(null)
  const [notice, setNotice] = useState('')

  const run = useCallback(
    async (input: GitWriteInput, expected: GitActionExpected): Promise<GitActionResult> => {
      setBusy(input.kind)
      setFailure(null)
      setNotice('')
      try {
        const res = await window.yan.git.action({
          ...input,
          cwd: cwd ?? '',
          requestId: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          expected
        } as GitActionRequest)
        if (res.ok) setNotice(res.summary ?? '')
        else setFailure(res.failure ?? { code: 'unknown', message: '操作失败', retrySafe: false })
        onDone?.(res)
        return res
      } catch (e: unknown) {
        const f: GitFailure = {
          code: 'unknown',
          message: e instanceof Error ? e.message : String(e),
          retrySafe: false
        }
        setFailure(f)
        return { ok: false, failure: f }
      } finally {
        setBusy('')
      }
    },
    [cwd, onDone]
  )

  const clear = useCallback(() => {
    setFailure(null)
    setNotice('')
  }, [])

  return { busy, failure, notice, run, clear }
}
