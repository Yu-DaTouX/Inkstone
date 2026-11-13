import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { listSessionFiles } from './session-search'

export type UsageSourceKind = 'main' | 'subagent'

export interface UsageFileRef {
  path: string
  size: number
  mtimeMs?: number
}

export interface UsageSources {
  listMain(): Promise<UsageFileRef[]>
  listSubagents(): Promise<UsageFileRef[]>
  cacheFile: string
}

export function subagentArchiveDir(): string {
  return join(YAN_DIR, 'subagents')
}

export function subagentSessionsRoot(archiveDir = subagentArchiveDir()): string {
  return join(archiveDir, 'sessions')
}

export async function listRawSessionFiles(root: string, maxDepth = 1): Promise<UsageFileRef[]> {
  const walk = async (dir: string, depth: number): Promise<UsageFileRef[]> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const found = await Promise.all(entries.map(async (entry): Promise<UsageFileRef[]> => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return depth < maxDepth ? walk(path, depth + 1) : []
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return []
      try {
        const info = await stat(path)
        return info.isFile() ? [{ path, size: info.size, mtimeMs: info.mtimeMs }] : []
      } catch {
        return []
      }
    }))
    return found.flat()
  }
  return walk(root, 0)
}

export async function listMainUsageFiles(): Promise<UsageFileRef[]> {
  return (await listSessionFiles()).map((file) => ({ path: file.path, size: file.size, mtimeMs: file.mtimeMs }))
}

export function defaultUsageSources(): UsageSources {
  return {
    listMain: listMainUsageFiles,
    listSubagents: () => listRawSessionFiles(subagentSessionsRoot()),
    cacheFile: join(YAN_DIR, 'usage-stats.json')
  }
}

export async function canonicalUsagePath(path: string): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(path)
  } catch {
    return ''
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
