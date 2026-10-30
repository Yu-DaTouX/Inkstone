import { useCallback, useRef, useState } from 'react'
import type { GitActionExpected, GitActionKind, GitActionRequest, GitActionResult } from '../../../../shared/git-actions'
import { failureView, type FailureView } from './git-flow'

type WithoutContext<T> = T extends unknown ? Omit<T, 'requestId' | 'cwd' | 'expected'> : never

export type GitActionInput = WithoutContext<GitActionRequest>

export interface GitActionFailure {
  input: GitActionInput
  view: FailureView
}

export interface GitActionDone {
  kind: GitActionKind
  summary: string
  commit: string | null
  branch: string | null
}

export interface GitActionRunner {
  busy: GitActionKind | null
  failure: GitActionFailure | null
  done: GitActionDone | null
  run: (input: GitActionInput) => Promise<GitActionResult | null>
  clear: () => void
}

const EMPTY_EXPECTED: GitActionExpected = { head: null, indexDigest: '', statusDigest: '' }

let requestSeq = 0

export function useGitAction(cwd: string, expected: GitActionExpected | undefined, onRefresh: () => void): GitActionRunner {
  const [busy, setBusy] = useState<GitActionKind | null>(null)
  const [failure, setFailure] = useState<GitActionFailure | null>(null)
  const [done, setDone] = useState<GitActionDone | null>(null)
  const busyRef = useRef(false)
  const expectedRef = useRef(expected)
  expectedRef.current = expected
  const refreshRef = useRef(onRefresh)
  refreshRef.current = onRefresh

  const run = useCallback(
    async (input: GitActionInput): Promise<GitActionResult | null> => {
      const git = typeof window === 'undefined' ? undefined : window.yan?.git
      if (!git?.action || busyRef.current) return null
      const current = expectedRef.current
      if (!current && input.kind !== 'fetch') return null
      busyRef.current = true
      setBusy(input.kind)
      setFailure(null)
      setDone(null)
      try {
        const requestId = `gitflow-${input.kind}-${Date.now()}-${++requestSeq}`
        const res = await git.action({ ...input, requestId, cwd, expected: current ?? EMPTY_EXPECTED } as GitActionRequest)
        if (!res.ok) {
          setFailure({ input, view: failureView(res) })
          if (res.failure?.code === 'stale' || res.committed) refreshRef.current()
          return res
        }
        setDone({
          kind: input.kind,
          summary: res.summary ?? '',
          commit: res.commit ?? null,
          branch: 'branch' in input && typeof input.branch === 'string' ? input.branch : res.state?.branch ?? null
        })
        refreshRef.current()
        return res
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setFailure({ input, view: failureView({ failure: { code: 'unknown', message, retrySafe: false } }) })
        return null
      } finally {
        busyRef.current = false
        setBusy(null)
      }
    },
    [cwd]
  )

  const clear = useCallback((): void => {
    setFailure(null)
    setDone(null)
  }, [])

  return { busy, failure, done, run, clear }
}
