import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { gradleUserHome } from './gradle.ts'
import { ZipReader } from './zip.ts'

export type SourceScope = 'minecraft' | 'deps' | 'project'

export interface SourceRoot {
  scope: SourceScope
  dir: string
  label: string
}

export interface SourceMatch {
  scope: SourceScope
  file: string
  line: number
  text: string
}

async function findFiles(dir: string, test: (name: string) => boolean, depth: number, out: string[] = []): Promise<string[]> {
  if (depth < 0) return out
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await findFiles(full, test, depth - 1, out)
    else if (test(entry.name)) out.push(full)
  }
  return out
}

export async function findMinecraftSourceJars(projectDir: string, minecraft: string | null, userHome = gradleUserHome()): Promise<string[]> {
  const roots = [join(projectDir, '.gradle', 'loom-cache', 'minecraftMaven'), join(userHome, 'caches', 'fabric-loom', 'minecraftMaven')]
  const jars: Array<{ path: string; mtime: number }> = []
  for (const root of roots) {
    for (const file of await findFiles(root, (name) => /^minecraft-.*-sources\.jar$/.test(name), 8)) {
      if (minecraft && !file.includes(`${sep}${minecraft}-`) && !basename(file).includes(`-${minecraft}-`)) continue
      jars.push({ path: file, mtime: (await stat(file)).mtimeMs })
    }
  }
  return jars.sort((a, b) => b.mtime - a.mtime).map((jar) => jar.path)
}

export async function findDependencySourceJars(projectDir: string): Promise<string[]> {
  return findFiles(join(projectDir, '.gradle', 'loom-cache', 'remapped_mods'), (name) => name.endsWith('-sources.jar'), 10)
}

export async function extractSources(jar: string, outDir: string): Promise<string> {
  const marker = join(outDir, '.extracted')
  const info = await stat(jar)
  const signature = `${jar}|${info.size}|${info.mtimeMs}`
  if (existsSync(marker) && (await readFile(marker, 'utf8')) === signature) return outDir
  const zip = await ZipReader.open(jar)
  await zip.readAll(
    (name) => name.endsWith('.java') || name.endsWith('.kt'),
    async (name, data) => {
      const target = join(outDir, ...name.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data)
    }
  )
  await writeFile(marker, signature)
  return outDir
}

export function sourceJarKind(jar: string): string {
  return basename(jar).match(/^minecraft-([A-Za-z]+)/)?.[1] ?? 'minecraft'
}

export function pickMinecraftSourceJars(jarsNewestFirst: string[]): string[] {
  const newest = jarsNewestFirst[0]
  if (!newest) return []
  const cacheRoot = (jar: string) => jar.slice(0, jar.indexOf('minecraftMaven'))
  const picked = new Map<string, string>()
  for (const jar of jarsNewestFirst) {
    if (cacheRoot(jar) !== cacheRoot(newest)) continue
    const kind = sourceJarKind(jar)
    if (!picked.has(kind)) picked.set(kind, jar)
  }
  return [...picked.values()]
}

export async function sourceRoots(projectDir: string, cacheDir: string, minecraft: string | null, projectSourceDirs: string[], scopes: SourceScope[] = ['minecraft', 'deps', 'project']): Promise<SourceRoot[]> {
  const roots: SourceRoot[] = []
  if (scopes.includes('project')) for (const dir of projectSourceDirs) if (existsSync(dir)) roots.push({ scope: 'project', dir, label: relative(projectDir, dir) || dir })
  if (scopes.includes('minecraft')) {
    const jars = pickMinecraftSourceJars(await findMinecraftSourceJars(projectDir, minecraft))
    for (const jar of jars) {
      const kind = sourceJarKind(jar)
      roots.push({ scope: 'minecraft', dir: await extractSources(jar, join(cacheDir, 'minecraft', basename(jar, '.jar'))), label: `minecraft ${minecraft ?? ''}${jars.length > 1 ? ` ${kind}` : ''}`.trim() })
    }
  }
  if (scopes.includes('deps')) {
    for (const jar of await findDependencySourceJars(projectDir)) {
      roots.push({ scope: 'deps', dir: await extractSources(jar, join(cacheDir, 'deps', basename(jar, '.jar'))), label: basename(jar, '-sources.jar') })
    }
  }
  return roots
}

export function compilePattern(query: string, regex: boolean): RegExp {
  if (regex) {
    try {
      return new RegExp(query, 'i')
    } catch (error) {
      throw new Error(`正则无效：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

export async function searchSources(roots: SourceRoot[], query: string, options: { regex?: boolean; pathFilter?: string; limit?: number } = {}): Promise<{ matches: SourceMatch[]; truncated: boolean; filesScanned: number }> {
  const pattern = compilePattern(query, options.regex ?? false)
  const pathFilter = options.pathFilter ? options.pathFilter.replaceAll('.', '/').toLowerCase() : null
  const limit = options.limit ?? 50
  const matches: SourceMatch[] = []
  let filesScanned = 0
  for (const root of roots) {
    const files = await findFiles(root.dir, (name) => name.endsWith('.java') || name.endsWith('.kt'), 40)
    for (const file of files) {
      const rel = relative(root.dir, file).split(sep).join('/')
      if (pathFilter && !rel.toLowerCase().includes(pathFilter)) continue
      filesScanned += 1
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
      for (let index = 0; index < lines.length; index++) {
        if (!pattern.test(lines[index])) continue
        matches.push({ scope: root.scope, file: `${root.scope === 'deps' ? `${root.label}:` : ''}${rel}`, line: index + 1, text: lines[index].trim().slice(0, 240) })
        if (matches.length >= limit) return { matches, truncated: true, filesScanned }
      }
    }
  }
  return { matches, truncated: false, filesScanned }
}

export async function readSource(roots: SourceRoot[], target: string, options: { start?: number; lines?: number } = {}): Promise<{ file: string; scope: SourceScope; start: number; end: number; total: number; text: string } | null> {
  const cleaned = target.replace(/^[^:]+:(?=[\w/])/, '').replace(/\.(java|kt)$/, '')
  const asPath = cleaned.includes('/') ? cleaned : cleaned.replaceAll('.', '/')
  const outer = asPath.replace(/\$.*$/, '')
  for (const root of roots) {
    for (const ext of ['.java', '.kt']) {
      const file = join(root.dir, ...`${outer}${ext}`.split('/'))
      if (!existsSync(file)) continue
      const all = (await readFile(file, 'utf8')).split(/\r?\n/)
      const start = Math.max(1, options.start ?? 1)
      const end = Math.min(all.length, start - 1 + (options.lines ?? 200))
      return { file: `${outer}${ext}`, scope: root.scope, start, end, total: all.length, text: all.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(5)}  ${line}`).join('\n') }
    }
  }
  if (!cleaned.includes('/') && !cleaned.includes('.')) {
    for (const root of roots) {
      const hit = (await findFiles(root.dir, (name) => name === `${cleaned}.java` || name === `${cleaned}.kt`, 40))[0]
      if (hit) return readSource([root], relative(root.dir, hit).split(sep).join('/'), options)
    }
  }
  return null
}
