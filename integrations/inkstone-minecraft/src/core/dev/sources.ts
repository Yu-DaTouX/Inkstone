import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { gradleUserHome } from './gradle.ts'
import { ZipReader } from './zip.ts'

export type SourceScope = 'minecraft' | 'deps' | 'project'

export interface SourceRoot {
  scope: SourceScope
  dir: string
  label: string
  jar?: string
  javap?: string
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

export function entryTarget(root: string, entry: string, suffix = ''): string | null {
  const parts = entry.split(/[\\/]/)
  if (!entry || isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || parts.some((part) => part === '..')) return null
  const target = join(root, ...parts) + suffix
  const rel = relative(root, target)
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) ? target : null
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
      const target = entryTarget(outDir, name)
      if (!target) return
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

export async function sourceRoots(projectDir: string, cacheDir: string, minecraft: string | null, projectSourceDirs: string[], scopes: SourceScope[] = ['minecraft', 'deps', 'project'], binaries?: { classpath: string[]; javaPath: string | null }): Promise<SourceRoot[]> {
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
    const classpath = binaries?.classpath.filter((file) => file.endsWith('.jar') && !/[\\/]net[\\/]minecraft[\\/]|[\\/]org[\\/]lwjgl[\\/]/.test(file))
    const sourceJars = (await findDependencySourceJars(projectDir)).filter((file) => !classpath || classpath.some((binary) => basename(binary, '.jar') === basename(file, '-sources.jar')))
    for (const jar of sourceJars) {
      roots.push({ scope: 'deps', dir: await extractSources(jar, join(cacheDir, 'deps', basename(jar, '.jar'))), label: basename(jar, '-sources.jar') })
    }
    const javap = binaries?.javaPath ? join(dirname(binaries.javaPath), process.platform === 'win32' ? 'javap.exe' : 'javap') : undefined
    for (const jar of classpath ?? []) {
      if (sourceJars.some((source) => basename(source, '-sources.jar') === basename(jar, '.jar')) || !existsSync(jar)) continue
      roots.push({ scope: 'deps', dir: join(cacheDir, 'bytecode'), label: `${basename(jar)} [javap 公共 API 签名]`, jar, javap })
    }
  }
  return roots
}

async function binaryClasses(root: SourceRoot): Promise<string[]> {
  const zip = await ZipReader.open(root.jar!)
  return [...zip.entries.keys()].filter((name) => name.endsWith('.class') && !name.startsWith('META-INF/') && !name.endsWith('module-info.class') && !name.endsWith('package-info.class'))
}

async function readBytecode(root: SourceRoot, file: string): Promise<string> {
  if (!root.javap || !existsSync(root.javap)) throw new Error(`依赖 ${root.label} 没有 sources.jar，且当前 Java 缺少 javap；请使用同版本 JDK 或提供此依赖的源码包`)
  const info = await stat(root.jar!)
  const key = createHash('sha256').update(`${root.jar}|${info.size}|${info.mtimeMs}`).digest('hex').slice(0, 20)
  const cached = entryTarget(join(root.dir, key), file, '.javap')
  if (!cached) throw new Error(`jar 条目路径不合法：${file}`)
  if (existsSync(cached)) return readFile(cached, 'utf8')
  const result = await promisify(execFile)(root.javap, ['-J-Dstdout.encoding=UTF-8', '-J-Dstderr.encoding=UTF-8', '-public', '-classpath', root.jar!, file.slice(0, -6).replaceAll('/', '.')], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })
  const text = `字节码公共 API 签名（javap），不是反编译源码；来源 ${basename(root.jar!)}\n${result.stdout}`
  await mkdir(dirname(cached), { recursive: true })
  await writeFile(cached, text, 'utf8')
  return text
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
  const filter = options.pathFilter?.replaceAll('\\', '/').replace(/\.(java|kt)$/i, '')
  const pathFilter = filter ? (filter.includes('/') ? filter : filter.replaceAll('.', '/')).toLowerCase() : null
  const absoluteFilter = !!filter && isAbsolute(filter)
  const limit = options.limit ?? 50
  const matches: SourceMatch[] = []
  let filesScanned = 0
  let binaryScanned = 0
  let binaryTruncated = false
  const inventories = new Map<SourceRoot, string[]>()
  const classQuery = !options.regex && /(?:^|[./])[A-Z][\w$]*$/.test(query) ? query.replaceAll('.', '/').toLowerCase() : null
  const classMatches = (file: string) => file.toLowerCase() === `${classQuery}.class` || file.toLowerCase().endsWith(`/${classQuery}.class`)
  let namedClass = false
  if (classQuery) {
    for (const root of roots.filter((root) => root.jar)) {
      const files = await binaryClasses(root)
      inventories.set(root, files)
      if (files.some(classMatches)) namedClass = true
    }
  }
  for (const root of roots) {
    if (root.jar) {
      const candidates = (inventories.get(root) ?? await binaryClasses(root)).filter((file) => (!pathFilter || file.toLowerCase().includes(pathFilter)) && (!namedClass || classMatches(file)))
      candidates.sort((a, b) => Number(pattern.test(b)) - Number(pattern.test(a)))
      for (const file of candidates) {
        if (binaryScanned >= 25) { binaryTruncated = true; break }
        binaryScanned++
        filesScanned++
        const lines = (await readBytecode(root, file)).split(/\r?\n/)
        for (let index = 0; index < lines.length; index++) {
          if (!pattern.test(lines[index])) continue
          matches.push({ scope: root.scope, file: `${root.label}:${file}`, line: index + 1, text: lines[index].trim().slice(0, 240) })
          if (matches.length >= limit) return { matches, truncated: true, filesScanned }
        }
      }
      continue
    }
    const files = await findFiles(root.dir, (name) => name.endsWith('.java') || name.endsWith('.kt'), 40)
    for (const file of files) {
      const rel = relative(root.dir, file).split(sep).join('/')
      if (pathFilter && !(absoluteFilter ? file.split(sep).join('/').toLowerCase() : rel.toLowerCase()).includes(pathFilter)) continue
      filesScanned += 1
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
      for (let index = 0; index < lines.length; index++) {
        if (!pattern.test(lines[index])) continue
        matches.push({ scope: root.scope, file: `${root.scope === 'deps' ? `${root.label}:` : ''}${rel}`, line: index + 1, text: lines[index].trim().slice(0, 240) })
        if (matches.length >= limit) return { matches, truncated: true, filesScanned }
      }
    }
  }
  return { matches, truncated: binaryTruncated, filesScanned }
}

export async function readSource(roots: SourceRoot[], target: string, options: { start?: number; lines?: number } = {}): Promise<{ file: string; scope: SourceScope; start: number; end: number; total: number; text: string } | null> {
  const cleaned = target.replace(/^[^:]+:(?=[\w/])/, '').replaceAll('\\', '/').replace(/\.(java|kt|class)$/, '')
  const asPath = cleaned.includes('/') ? cleaned : cleaned.replaceAll('.', '/')
  const outer = asPath.replace(/\$.*$/, '')
  for (const root of roots) {
    if (root.jar) {
      const classes = await binaryClasses(root)
      const file = classes.find((file) => file === `${asPath}.class` || file === `${outer}.class` || (!asPath.includes('/') && file.split('/').at(-1) === `${asPath}.class`))
      if (!file) continue
      const all = (await readBytecode(root, file)).split(/\r?\n/)
      const start = Math.max(1, options.start ?? 1)
      const end = Math.min(all.length, start - 1 + (options.lines ?? 200))
      return { file: `${root.label}:${file}`, scope: root.scope, start, end, total: all.length, text: all.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(5)}  ${line}`).join('\n') }
    }
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
