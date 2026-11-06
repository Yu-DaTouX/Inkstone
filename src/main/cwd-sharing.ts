import { pick } from '../shared/ui-lang'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function insideGitWorkTree(cwd: string): boolean {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(resolve(dir, '.git'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

export function allowsConcurrentSessions(cwd: string): boolean {
  return !!cwd && !insideGitWorkTree(cwd)
}

export const sharedCwdNotice = (): string =>
  pick(
    '同一文件夹里还有会话在运行。这个文件夹不是 Git 仓库，砚不做隔离：两个会话改同一个文件时，后写的会覆盖先写的。',
    'Another session is running in this folder. It is not a Git repository, so Inkstone does not isolate sessions: if two sessions edit the same file, the later write overwrites the earlier one.'
  )
