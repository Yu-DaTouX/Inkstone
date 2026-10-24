import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | null = null

export function packageRoot(): string {
  if (cached) return cached
  if (process.env.INKSTONE_MC_PACKAGE_ROOT) return (cached = process.env.INKSTONE_MC_PACKAGE_ROOT)
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, 'templates', 'fabric'))) return (cached = dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到 inkstone-minecraft 的 templates 目录，请设置 INKSTONE_MC_PACKAGE_ROOT')
}

export function templatesDir(): string {
  return join(packageRoot(), 'templates')
}

export function initScriptPath(): string {
  return join(templatesDir(), 'gradle', 'inkstone-dev.init.gradle')
}

export function companionModDir(subdir = ''): string {
  return join(packageRoot(), 'companion-mod', subdir)
}
