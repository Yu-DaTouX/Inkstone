import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export function subagentWorktreeRoot(cwd: string): string | undefined {
  let dir = resolve(cwd)
  let found: string | undefined
  for (;;) {
    if (basename(dir) === 'worktree' && basename(dirname(dir)).startsWith('yan-subagent-')) {
      if (existsSync(join(dir, '.git'))) return dir
      found ??= dir
    }
    const parent = dirname(dir)
    if (parent === dir) return found
    dir = parent
  }
}
