import { useEffect, useState } from 'react'

const gitFolders = new Set<string>()

export function useGitFolder(cwd: string | undefined, enabled = true): boolean {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!cwd || !enabled || gitFolders.has(cwd)) return undefined
    let live = true
    void window.yan.git.worktrees(cwd).then((res) => res.ok, () => false).then((ok) => {
      if (!ok) return
      gitFolders.add(cwd)
      if (live) bump((n) => n + 1)
    })
    return () => {
      live = false
    }
  }, [cwd, enabled])
  return !!cwd && enabled && gitFolders.has(cwd)
}
