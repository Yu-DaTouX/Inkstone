import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

export function bundledSearchToolsDir(
  candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'search-tools') : '',
    join(HERE, '..', '..', 'resources', 'search-tools'),
    join(process.cwd(), 'resources', 'search-tools')
  ],
  platform = process.platform
): string | undefined {
  const rg = platform === 'win32' ? 'rg.exe' : 'rg'
  return candidates.find((dir) => !!dir && existsSync(join(dir, rg)))
}

export function withSearchToolsOnPath(path: string, dir: string | undefined): string {
  if (!dir) return path
  const entries = path.split(delimiter).filter(Boolean)
  const same = (entry: string): boolean => entry.replace(/[\\/]+$/, '').toLowerCase() === dir.replace(/[\\/]+$/, '').toLowerCase()
  return entries.some(same) ? path : [dir, ...entries].join(delimiter)
}

export function applyBundledSearchTools(): void {
  process.env.PATH = withSearchToolsOnPath(process.env.PATH ?? process.env.Path ?? '', bundledSearchToolsDir())
}
