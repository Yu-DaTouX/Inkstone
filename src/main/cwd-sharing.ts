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
  return !!cwd
}

export const sharedCwdNotice = (cwd: string): string => {
  const shared = pick(
    '这个文件夹里还有会话在运行，改到同一个文件时后写的会覆盖先写的。',
    'Another session is running in this folder. If both edit the same file, the later write overwrites the earlier one.'
  )
  if (!insideGitWorkTree(cwd)) return shared
  return shared + pick('要分开改，新会话打开「工作树」。', ' To keep them apart, turn on Worktree in a new session.')
}
