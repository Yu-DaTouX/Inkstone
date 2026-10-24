import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { javaFromHome } from './java.ts'

export const JBR_RELEASES_API = 'https://api.github.com/repos/JetBrains/JetBrainsRuntime/releases?per_page=100'

export interface JbrPackage {
  version: string
  build: string
  url: string
  checksumUrl: string
}

type Fetch = typeof fetch

export function jbrPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux'
  return `${os}-${arch === 'arm64' ? 'aarch64' : 'x64'}`
}

function numbers(text: string): number[] {
  return text.split(/[.b]/).filter(Boolean).map(Number)
}

function compareNumbers(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff) return diff
  }
  return 0
}

export function pickJbrPackage(releases: unknown, major: number, platform = jbrPlatform()): JbrPackage | null {
  if (!Array.isArray(releases)) return null
  const pattern = new RegExp(`\\((https://[^)\\s]*/jbr-(${major}(?:\\.[0-9]+)*)-${platform}-(b[0-9.]+)\\.tar\\.gz)\\)`)
  const found: JbrPackage[] = []
  for (const release of releases as Array<{ body?: unknown; prerelease?: unknown; draft?: unknown }>) {
    if (release.prerelease === true || release.draft === true || typeof release.body !== 'string') continue
    const match = release.body.match(pattern)
    if (match) found.push({ url: match[1], version: match[2], build: match[3], checksumUrl: `${match[1]}.checksum` })
  }
  found.sort((a, b) => compareNumbers(numbers(b.version), numbers(a.version)) || compareNumbers(numbers(b.build), numbers(a.build)))
  return found[0] ?? null
}

function systemTar(): string {
  const windowsTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return process.platform === 'win32' && existsSync(windowsTar) ? windowsTar : 'tar'
}

function extract(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(systemTar(), ['-xzf', archive, '-C', into], { windowsHide: true, timeout: 600_000 }, (error, _stdout, stderr) => (error ? reject(new Error(`解压 JBR 失败：${stderr || error.message}`)) : resolve()))
  })
}

async function findHome(dir: string): Promise<string | null> {
  if (existsSync(javaFromHome(dir))) return dir
  if (existsSync(javaFromHome(join(dir, 'Contents', 'Home')))) return dir
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const home = await findHome(join(dir, entry.name))
    if (home) return home
  }
  return null
}

async function sha512(path: string): Promise<string> {
  return createHash('sha512').update(await readFile(path)).digest('hex')
}

const pending = new Map<string, Promise<string>>()

export function downloadJbr(major: number, runtimesDir: string, log: (line: string) => void = () => undefined, fetchImpl: Fetch = fetch): Promise<string> {
  const key = `${runtimesDir.toLowerCase()}|${major}`
  const running = pending.get(key)
  if (running) return running
  const task = downloadJbrNow(major, runtimesDir, log, fetchImpl).finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

async function downloadJbrNow(major: number, runtimesDir: string, log: (line: string) => void, fetchImpl: Fetch): Promise<string> {
  const listing = await fetchImpl(JBR_RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'inkstone-minecraft' } })
  if (!listing.ok) throw new Error(`读取 JBR 发布列表失败：HTTP ${listing.status}`)
  const pkg = pickJbrPackage(await listing.json(), major)
  if (!pkg) throw new Error(`JetBrains 发布列表里没有适合本机（${jbrPlatform()}）的 JBR ${major}`)
  const target = join(runtimesDir, `jbr-${pkg.version}-${pkg.build}`)
  const existing = existsSync(target) ? await findHome(target) : null
  if (existing) return javaFromHome(existing)
  await mkdir(runtimesDir, { recursive: true })
  const work = join(runtimesDir, `.download-${randomBytes(4).toString('hex')}`)
  await mkdir(work, { recursive: true })
  try {
    const archive = join(work, 'jbr.tar.gz')
    log(`[inkstone] 正在下载 JBR ${pkg.version}（${pkg.build}）：${pkg.url}`)
    const response = await fetchImpl(pkg.url)
    if (!response.ok || !response.body) throw new Error(`下载 JBR 失败：HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? 0)
    let received = 0
    let reported = 0
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (total && received - reported >= total / 5) {
        reported = received
        log(`[inkstone] JBR 下载 ${Math.round((received / total) * 100)}%`)
      }
    })
    await pipeline(body, createWriteStream(archive))
    const checksum = await fetchImpl(pkg.checksumUrl)
    if (checksum.ok) {
      const expected = (await checksum.text()).trim().split(/\s+/)[0]?.toLowerCase()
      if (expected && /^[0-9a-f]{128}$/.test(expected) && expected !== (await sha512(archive))) throw new Error('JBR 下载文件校验失败（sha512 不一致），已丢弃')
    }
    const unpacked = join(work, 'unpacked')
    await mkdir(unpacked, { recursive: true })
    await extract(archive, unpacked)
    const home = await findHome(unpacked)
    if (!home) throw new Error('JBR 压缩包里没有找到 bin/java')
    await rename(home, target)
    log(`[inkstone] JBR ${pkg.version} 已安装到 ${target}`)
    const installed = await findHome(target)
    if (!installed) throw new Error(`JBR 安装后找不到 java：${target}`)
    return javaFromHome(installed)
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}
