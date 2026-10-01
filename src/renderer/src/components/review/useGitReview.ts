/**
 * Git 仓库状态与写操作的数据钩子（渲染端）。
 *
 * 状态是**视图级**的（跟着项目走），用组件级 state，不进全局 store，
 * 免得每次推送都让订阅 store 的组件重算。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  GitActionExpected,
  GitActionRequest,
  GitActionResult,
  GitFailure,
  GitRepoState
} from '../../../../shared/ipc'

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
