import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  GitActionExpected,
  GitActionRequest,
  GitActionResult,
  GitFailure,
  GitRepoState
} from '../../../../shared/ipc'

interface RequestGate {
  next: () => number
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

export interface RepoStateView {
  repo: GitRepoState | null
  expected: GitActionExpected | undefined
  error: string
  loading: boolean
  refresh: () => void
  apply: (state: GitRepoState) => void
}

export function useRepoState(cwd: string | undefined, deps: unknown[] = []): RepoStateView {
  const [repo, setRepo] = useState<GitRepoState | null>(null)
  const [expected, setExpected] = useState<GitActionExpected | undefined>(undefined)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const cwdRef = useRef(cwd)
  const [tick, setTick] = useState(0)
  const gate = useRequestGate()

  useEffect(() => {
    if (cwdRef.current !== cwd) {
      cwdRef.current = cwd
      setRepo(null)
      setExpected(undefined)
      setError('')
    }
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
        if (alive && gate.isCurrent(id)) setLoading(false)
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
  }, [])
  return { repo, expected, error, loading, refresh, apply }
}

export type GitWriteInput =
  | { kind: 'stage' | 'unstage'; paths: string[] }
  | { kind: 'stage-all' | 'unstage-all' }
  | { kind: 'commit'; message: string }
  | { kind: 'switch-branch'; branch: string }
  | { kind: 'create-branch'; branch: string; startPoint: string | null; checkout: boolean }
  | { kind: 'fetch'; remote?: string | null }
  | { kind: 'push'; remote: string | null; branch: string | null; setUpstream: boolean }

export interface GitWriteView {
  busy: string
  failure: GitFailure | null
  notice: string
  run: (input: GitWriteInput, expected: GitActionExpected) => Promise<GitActionResult>
  clear: () => void
}

export function useGitWrite(
  cwd: string | undefined,
  onDone?: (res: GitActionResult) => void
): GitWriteView {
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState<GitFailure | null>(null)
  const [notice, setNotice] = useState('')
  const busyCount = useRef(0)
  const generation = useRef(0)
  const cwdRef = useRef(cwd)
  useEffect(() => {
    if (cwdRef.current === cwd) return
    cwdRef.current = cwd
    generation.current += 1
    busyCount.current = 0
    setBusy('')
    setFailure(null)
    setNotice('')
  }, [cwd])

  const run = useCallback(
    async (input: GitWriteInput, expected: GitActionExpected): Promise<GitActionResult> => {
      if (busyCount.current > 0) return { ok: false, failure: { code: 'unknown', message: '已有 Git 操作正在进行', retrySafe: false } }
      const requestGeneration = generation.current
      busyCount.current += 1
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
        if (generation.current === requestGeneration) {
          if (res.ok) setNotice(res.summary ?? '')
          else setFailure(res.failure ?? { code: 'unknown', message: '操作失败', retrySafe: false })
          onDone?.(res)
        }
        return res
      } catch (e: unknown) {
        const f: GitFailure = {
          code: 'unknown',
          message: e instanceof Error ? e.message : String(e),
          retrySafe: false
        }
        if (generation.current === requestGeneration) setFailure(f)
        return { ok: false, failure: f }
      } finally {
        busyCount.current = Math.max(0, busyCount.current - 1)
        if (generation.current === requestGeneration && busyCount.current === 0) setBusy('')
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
