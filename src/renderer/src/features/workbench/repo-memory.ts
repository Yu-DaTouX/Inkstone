import type { GitRepoState } from '../../../../shared/git'

const REPO_MEMORY_MAX = 24
const memory = new Map<string, GitRepoState | null>()

export function knownRepo(cwd: string): GitRepoState | null | undefined {
  return memory.get(cwd)
}

export function rememberRepo(cwd: string, repo: GitRepoState | null): void {
  memory.delete(cwd)
  memory.set(cwd, repo)
  while (memory.size > REPO_MEMORY_MAX) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

export function prefetchRepos(cwds: readonly string[]): () => void {
  let cancelled = false
  let handle = 0
  const queue = [...new Set(cwds.filter((cwd) => cwd && !memory.has(cwd)))]
  const step = (): void => {
    const cwd = queue.shift()
    if (cancelled || cwd === undefined) return
    handle = window.requestIdleCallback(() => {
      const git = window.yan?.git
      if (!git || cancelled) return
      void git
        .state(cwd)
        .then((state) => rememberRepo(cwd, state.repo ?? null))
        .catch(() => undefined)
        .finally(step)
    }, { timeout: 5000 })
  }
  step()
  return () => {
    cancelled = true
    window.cancelIdleCallback(handle)
  }
}
