import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { gitRun, resolveRepo } from './git-service'
import type { GitPathScreen } from '../shared/git'

const MAX_PATHS = 500
const CHECK_IGNORE_TIMEOUT = 8000

interface ScreenEntry {
  raw: string
  abs: string
}

function repoRelative(root: string, abs: string): string | null {
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

async function isMissing(abs: string): Promise<boolean> {
  try {
    await stat(abs)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

async function ignoredEntries(cwd: string, entries: readonly ScreenEntry[]): Promise<string[]> {
  if (entries.length === 0) return []
  const repo = await resolveRepo(cwd).catch(() => null)
  if (!repo) return []
  const byRelative = new Map<string, string[]>()
  for (const entry of entries) {
    const rel = repoRelative(repo.root, entry.abs)
    if (!rel) continue
    byRelative.set(rel, [...(byRelative.get(rel) ?? []), entry.raw])
  }
  if (byRelative.size === 0) return []
  const res = await gitRun(repo.root, ['check-ignore', '--stdin', '-z'], {
    stdin: `${[...byRelative.keys()].join('\0')}\0`,
    allowFailure: true,
    timeout: CHECK_IGNORE_TIMEOUT
  })
  if (!res.stdout) return []
  return res.stdout.split('\0').filter(Boolean).flatMap((rel) => byRelative.get(rel) ?? [])
}

export async function screenPaths(cwd: string, paths: readonly unknown[]): Promise<GitPathScreen> {
  const unique = [...new Set(paths.filter((p): p is string => typeof p === 'string' && p.trim() !== ''))].slice(0, MAX_PATHS)
  const entries = unique.map((raw) => ({ raw, abs: resolve(cwd, raw) }))
  const missingFlags = await Promise.all(entries.map((entry) => isMissing(entry.abs)))
  const missing = entries.filter((_, i) => missingFlags[i]).map((entry) => entry.raw)
  const present = entries.filter((_, i) => !missingFlags[i])
  const ignored = await ignoredEntries(cwd, present).catch(() => [])
  return { ignored, missing }
}
