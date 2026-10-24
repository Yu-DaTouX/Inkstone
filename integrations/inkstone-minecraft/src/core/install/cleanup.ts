import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const SCAN_ROOTS = ['libraries', 'assets', 'versions']
const MAX_DEPTH = 8

export interface CleanupReport {
  removedParts: number
  removedDirs: number
  cleaned: number
}

async function collectParts(dir: string, out: string[], depth: number): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0) await collectParts(path, out, depth - 1)
    } else if (entry.name.toLowerCase().endsWith('.part')) {
      out.push(path)
    }
  }
}

export function partRoots(folder: string): string[] {
  return SCAN_ROOTS.map((name) => join(folder, name))
}

export async function cleanupCancelledInstall(options: { folder: string; name?: string | null }): Promise<CleanupReport> {
  const parts: string[] = []
  for (const root of partRoots(options.folder)) await collectParts(root, parts, MAX_DEPTH)
  let removedParts = 0
  for (const path of parts) {
    await rm(path, { force: true }).catch(() => undefined)
    removedParts += 1
  }
  let removedDirs = 0
  const name = (options.name ?? '').trim()
  if (name && !/[\\/]/.test(name) && name !== '.' && name !== '..') {
    const dir = join(options.folder, 'versions', name)
    if (existsSync(dir) && !existsSync(join(dir, `${name}.json`))) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      removedDirs += 1
    }
  }
  return { removedParts, removedDirs, cleaned: removedParts + removedDirs }
}
