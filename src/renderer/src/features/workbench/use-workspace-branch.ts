import { useEffect, useState } from 'react'

const BRANCH_REFRESH_MS = 10_000

export function useWorkspaceBranch(cwd: string | null, enabled: boolean): string | null {
  const [branch, setBranch] = useState<string | null>(null)
  useEffect(() => {
    const git = typeof window === 'undefined' ? undefined : window.yan?.git
    if (!cwd || !enabled || !git) {
      setBranch(null)
      return undefined
    }
    let alive = true
    const read = (): void => {
      git
        .state(cwd)
        .then((state) => {
          if (alive) setBranch(state.repo?.branch ?? null)
        })
        .catch(() => {
          if (alive) setBranch(null)
        })
    }
    read()
    const timer = window.setInterval(read, BRANCH_REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [cwd, enabled])
  return branch
}

export function useWorkspaceHasChanges(cwd: string | null, enabled: boolean): boolean {
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    const git = typeof window === 'undefined' ? undefined : window.yan?.git
    if (!cwd || !enabled || !git) {
      setDirty(false)
      return undefined
    }
    let alive = true
    const read = (): void => {
      git
        .state(cwd)
        .then((state) => {
          if (alive) setDirty((state.repo?.changedCount ?? 0) > 0)
        })
        .catch(() => {
          if (alive) setDirty(false)
        })
    }
    read()
    const timer = window.setInterval(read, BRANCH_REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [cwd, enabled])
  return dirty
}
