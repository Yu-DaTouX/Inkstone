import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { listSessionFiles } from './session-search'

export type UsageSourceKind = 'main' | 'subagent'

export interface UsageFileRef {
  path: string
  size: number
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
  const files: UsageFileRef[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(path, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const info = await stat(path)
          if (info.isFile()) files.push({ path, size: info.size })
        } catch {
        }
      }
    }
  }
  await walk(root, 0)
  return files
}

export async function listMainUsageFiles(): Promise<UsageFileRef[]> {
  return (await listSessionFiles()).map((file) => ({ path: file.path, size: file.size }))
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
