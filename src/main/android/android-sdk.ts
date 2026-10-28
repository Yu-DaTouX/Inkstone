import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, net } from 'electron'
import {
  ANDROID_DEFAULT_AVD,
  ANDROID_SYSTEM_IMAGE_API,
  type AndroidComponentId,
  type AndroidComponentStatus,
  type AndroidInstallProgress,
  type AndroidSdkStatus
} from '../../shared/android-sdk'
import { YAN_DIR } from '../paths'
import { abi, adbPath, avdHome, emulatorPath, exe, installedSystemImage, javaOnPath, listAvds, MANAGED_JDK, resolveJavaHome, resolveSdkRoot, systemImageDir, WIN } from './android-paths'

const REPO = 'https://dl.google.com/android/repository/'
const SYS_IMG_REPO = `${REPO}sys-img/google_apis/`
const ADOPTIUM = 'https://api.adoptium.net/v3/assets/latest/21/hotspot'
const SDK_LICENSES: Record<string, string[]> = {
  'android-sdk-license': ['24333f8a63b6825ea9c5514f83c2829b004d1fee', 'd56f5187479451eabf01fb78af6dfcb131a6481e', '8933bad161af4178b1185d1a37fbf41ea5269c55'],
  'android-sdk-preview-license': ['84831b9409646a918e30573bab4c9c91346d8abd']
}

interface RemoteArchive { url: string; size: number; checksum: string; algorithm: 'sha1' | 'sha256'; hostOs?: string; hostArch?: string }
interface RemotePackage { path: string; channel: number; revision: number[]; archives: RemoteArchive[] }
interface DownloadPlan { url: string; size: number; checksum: string; algorithm: 'sha1' | 'sha256'; destination: string }

const hostOs = (): string => (WIN ? 'windows' : process.platform === 'darwin' ? 'macosx' : 'linux')
const hostArch = (): string => (process.arch === 'arm64' ? 'aarch64' : 'x64')

function revisionOf(block: string): number[] {
  const rev = /<revision>([\s\S]*?)<\/revision>/.exec(block)?.[1] ?? ''
  return ['major', 'minor', 'micro'].map((key) => Number(new RegExp(`<${key}>(\\d+)</${key}>`).exec(rev)?.[1] ?? 0))
}

export function parseRepository(xml: string): RemotePackage[] {
  const out: RemotePackage[] = []
  for (const match of xml.matchAll(/<remotePackage path="([^"]+)">([\s\S]*?)<\/remotePackage>/g)) {
    const block = match[2]
    const archives: RemoteArchive[] = []
    for (const archive of block.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
      const body = archive[1]
      const url = /<url>([^<]+)<\/url>/.exec(body)?.[1]
      const checksum = /<checksum[^>]*>([0-9a-f]+)<\/checksum>/i.exec(body)?.[1]
      if (!url || !checksum) continue
      archives.push({
        url,
        size: Number(/<size>(\d+)<\/size>/.exec(body)?.[1] ?? 0),
        checksum: checksum.toLowerCase(),
        algorithm: 'sha1',
        hostOs: /<host-os>([^<]+)<\/host-os>/.exec(body)?.[1],
        hostArch: /<host-arch>([^<]+)<\/host-arch>/.exec(body)?.[1]
      })
    }
    out.push({ path: match[1], channel: Number(/<channelRef ref="channel-(\d+)"/.exec(block)?.[1] ?? 0), revision: revisionOf(block), archives })
  }
  return out
}

export function pickArchive(packages: RemotePackage[], path: string, os = hostOs(), arch = hostArch()): RemoteArchive | null {
  const stable = packages
    .filter((pkg) => pkg.path === path && pkg.channel === 0)
    .sort((a, b) => b.revision[0] - a.revision[0] || b.revision[1] - a.revision[1] || b.revision[2] - a.revision[2])
  for (const pkg of stable) {
    const forHost = pkg.archives.filter((item) => !item.hostOs || item.hostOs === os)
    const archive = forHost.find((item) => item.hostArch === arch) ?? forHost.find((item) => !item.hostArch)
    if (archive) return archive
  }
  return null
}

async function fetchText(url: string): Promise<string> {
  const response = await net.fetch(url)
  if (!response.ok) throw new Error(`读取 ${url} 失败：HTTP ${response.status}`)
  return response.text()
}

async function sdkArchive(xmlUrl: string, path: string, base: string): Promise<{ url: string; size: number; checksum: string }> {
  const archive = pickArchive(parseRepository(await fetchText(xmlUrl)), path)
  if (!archive) throw new Error(`官方仓库里没有适合本机的 ${path}`)
  return { url: new URL(archive.url, base).href, size: archive.size, checksum: archive.checksum }
}

async function jdkArchive(): Promise<{ url: string; size: number; checksum: string }> {
  const os = WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  const response = await net.fetch(`${ADOPTIUM}?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`)
  if (!response.ok) throw new Error(`读取 JDK 版本失败：HTTP ${response.status}`)
  const list = (await response.json()) as Array<{ binary?: { package?: { link?: string; size?: number; checksum?: string } } }>
  const pkg = list[0]?.binary?.package
  if (!pkg?.link || !pkg.checksum) throw new Error('没有找到适合本机的 JDK 21')
  return { url: pkg.link, size: pkg.size ?? 0, checksum: pkg.checksum.toLowerCase() }
}

function extract(archive: string, into: string, signal: AbortSignal): Promise<void> {
  const useUnzip = process.platform === 'linux' && archive.endsWith('.zip')
  const [command, args] = useUnzip ? ['unzip', ['-q', archive, '-d', into]] : ['tar', ['-xf', archive, '-C', into]]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000) })
    const abort = (): void => { child.kill() }
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', reject)
    child.on('exit', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(new Error('已取消'))
      else if (code === 0) resolve()
      else reject(new Error(`解压失败（${code}）：${stderr.trim()}`))
    })
  })
}

async function contentRoot(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.length === 1 && entries[0].isDirectory() ? join(dir, entries[0].name) : dir
}

function runElevated(file: string, cwd: string): Promise<number> {
  const script = `$p = Start-Process -FilePath '${file.replace(/'/g, "''")}' -WorkingDirectory '${cwd.replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

export class AndroidSdkService {
  private progress: AndroidInstallProgress | null = null
  private abort: AbortController | null = null
  private accelCache: { at: number; status: AndroidComponentStatus } | null = null

  constructor() {
    app.on('before-quit', () => this.abort?.abort())
  }

  private accelStatus(root: string): AndroidComponentStatus {
    const emulator = emulatorPath(root)
    if (!emulator) return { id: 'accel', state: 'unknown', detail: 'needs-emulator' }
    if (this.accelCache && Date.now() - this.accelCache.at < 30_000) return this.accelCache.status
    const check = join(root, 'emulator', exe('emulator-check'))
    const result = spawnSync(existsSync(check) ? check : emulator, existsSync(check) ? ['accel'] : ['-accel-check'], { windowsHide: true, timeout: 15_000, encoding: 'utf8' })
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== 'accel:' && line !== 'accel')
    const status: AndroidComponentStatus = result.status === 0
      ? { id: 'accel', state: 'installed', detail: text[1] ?? text[0] }
      : { id: 'accel', state: WIN ? 'missing' : 'unsupported', detail: text.find((line) => !/^\d+$/.test(line)) }
    this.accelCache = { at: Date.now(), status }
    return status
  }

  async status(): Promise<AndroidSdkStatus> {
    const { root, source } = resolveSdkRoot()
    const image = installedSystemImage(root)
    const javaHome = resolveJavaHome()
    const components: AndroidComponentStatus[] = [
      adbPath(root) ? { id: 'platformTools', state: 'installed', path: adbPath(root)! } : { id: 'platformTools', state: 'missing' },
      emulatorPath(root) ? { id: 'emulator', state: 'installed', path: join(root, 'emulator') } : { id: 'emulator', state: 'missing' },
      image ? { id: 'systemImage', state: 'installed', path: image } : { id: 'systemImage', state: 'missing' },
      javaHome ? { id: 'jdk', state: 'installed', path: javaHome } : javaOnPath() ? { id: 'jdk', state: 'installed', detail: 'path' } : { id: 'jdk', state: 'missing' },
      this.accelStatus(root)
    ]
    return { sdkRoot: root, sdkSource: source, components, avds: listAvds(), install: this.progress }
  }

  async install(ids: AndroidComponentId[]): Promise<{ ok: boolean; error?: string }> {
    if (this.progress?.state === 'running') return { ok: false, error: '已有安装在进行' }
    const queue = [...new Set(ids)].filter((id) => id !== 'accel' || WIN)
    if (!queue.length) return { ok: false, error: '没有需要安装的组件' }
    this.abort = new AbortController()
    this.progress = { queue, current: null, phase: 'idle', received: 0, total: 0, done: [], state: 'running' }
    void this.runQueue(queue, this.abort.signal)
    return { ok: true }
  }

  cancel(): void {
    this.abort?.abort()
  }

  private async runQueue(queue: AndroidComponentId[], signal: AbortSignal): Promise<void> {
    const progress = this.progress!
    try {
      const { root } = resolveSdkRoot()
      for (const id of queue) {
        signal.throwIfAborted()
        progress.current = id
        progress.received = 0
        progress.total = 0
        await this.installOne(id, root, signal)
        progress.done.push(id)
      }
      progress.state = 'done'
    } catch (error) {
      progress.state = signal.aborted ? 'cancelled' : 'failed'
      progress.error = signal.aborted ? undefined : error instanceof Error ? error.message : String(error)
    } finally {
      progress.current = null
      progress.phase = 'idle'
      this.abort = null
      this.accelCache = null
    }
  }

  private async installOne(id: AndroidComponentId, root: string, signal: AbortSignal): Promise<void> {
    const progress = this.progress!
    progress.phase = 'download'
    const plan = await this.plan(id, root)
    await this.writeLicenses(root)
    const work = join(id === 'jdk' ? YAN_DIR : root, `.inkstone-download-${randomUUID()}`)
    await mkdir(work, { recursive: true })
    try {
      const archive = join(work, plan.url.endsWith('.tar.gz') ? 'package.tar.gz' : 'package.zip')
      await this.download(plan, archive, signal)
      progress.phase = 'extract'
      const unpacked = join(work, 'unpacked')
      await mkdir(unpacked)
      await extract(archive, unpacked, signal)
      const source = await contentRoot(unpacked)
      await rm(plan.destination, { recursive: true, force: true })
      await mkdir(join(plan.destination, '..'), { recursive: true })
      await rename(source, plan.destination)
      progress.phase = 'setup'
      if (id === 'systemImage' && !listAvds().includes(ANDROID_DEFAULT_AVD)) await this.createAvd()
      if (id === 'accel') await this.installAccel(plan.destination)
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async plan(id: AndroidComponentId, root: string): Promise<DownloadPlan> {
    if (id === 'jdk') {
      const archive = await jdkArchive()
      return { ...archive, algorithm: 'sha256', destination: join(MANAGED_JDK, 'jdk-21') }
    }
    const spec: Record<Exclude<AndroidComponentId, 'jdk'>, { xml: string; path: string; base: string; destination: string }> = {
      platformTools: { xml: `${REPO}repository2-3.xml`, path: 'platform-tools', base: REPO, destination: join(root, 'platform-tools') },
      emulator: { xml: `${REPO}repository2-3.xml`, path: 'emulator', base: REPO, destination: join(root, 'emulator') },
      systemImage: { xml: `${SYS_IMG_REPO}sys-img2-3.xml`, path: `system-images;android-${ANDROID_SYSTEM_IMAGE_API};google_apis;${abi()}`, base: SYS_IMG_REPO, destination: systemImageDir(root) },
      accel: { xml: `${REPO}addon2-3.xml`, path: 'extras;google;Android_Emulator_Hypervisor_Driver', base: REPO, destination: join(root, 'extras', 'google', 'Android_Emulator_Hypervisor_Driver') }
    }
    const item = spec[id]
    return { ...(await sdkArchive(item.xml, item.path, item.base)), algorithm: 'sha1', destination: item.destination }
  }

  private async download(plan: DownloadPlan, target: string, signal: AbortSignal): Promise<void> {
    const progress = this.progress!
    const response = await net.fetch(plan.url, { signal })
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
    progress.total = Number(response.headers.get('content-length')) || plan.size
    const hash = createHash(plan.algorithm)
    let received = 0
    const counting = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        received += chunk.byteLength
        progress.received = received
        hash.update(chunk)
        controller.enqueue(chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body.pipeThrough(counting) as import('node:stream/web').ReadableStream), createWriteStream(target))
    if (plan.size && received !== plan.size) throw new Error('下载不完整，请重试')
    if (hash.digest('hex') !== plan.checksum) throw new Error('文件校验失败，已删除下载内容')
  }

  private async writeLicenses(root: string): Promise<void> {
    const dir = join(root, 'licenses')
    await mkdir(dir, { recursive: true })
    for (const [name, hashes] of Object.entries(SDK_LICENSES)) {
      const file = join(dir, name)
      const current = await readFile(file, 'utf8').catch(() => '')
      const missing = hashes.filter((hash) => !current.includes(hash))
      if (missing.length) await writeFile(file, `${current.trimEnd()}${current.trim() ? '\n' : ''}${missing.join('\n')}\n`)
    }
  }

  private async createAvd(): Promise<void> {
    const home = avdHome()
    const dir = join(home, `${ANDROID_DEFAULT_AVD}.avd`)
    await mkdir(dir, { recursive: true })
    const image = `system-images${WIN ? '\\' : '/'}android-${ANDROID_SYSTEM_IMAGE_API}${WIN ? '\\' : '/'}google_apis${WIN ? '\\' : '/'}${abi()}${WIN ? '\\' : '/'}`
    const config = {
      AvdId: ANDROID_DEFAULT_AVD,
      'avd.ini.displayname': 'Inkstone API 36',
      'avd.ini.encoding': 'UTF-8',
      'abi.type': abi(),
      'hw.cpu.arch': abi() === 'x86_64' ? 'x86_64' : 'arm64',
      'image.sysdir.1': image,
      'tag.id': 'google_apis',
      'tag.display': 'Google APIs',
      'target': `android-${ANDROID_SYSTEM_IMAGE_API}`,
      'PlayStore.enabled': 'false',
      'hw.lcd.width': '1080',
      'hw.lcd.height': '2400',
      'hw.lcd.density': '420',
      'hw.ramSize': '2048',
      'hw.keyboard': 'yes',
      'hw.gpu.enabled': 'yes',
      'hw.gpu.mode': 'auto',
      'hw.initialOrientation': 'portrait',
      'disk.dataPartition.size': '6G',
      'sdcard.size': '512M',
      'showDeviceFrame': 'no',
      'fastboot.forceColdBoot': 'no'
    }
    await writeFile(join(dir, 'config.ini'), `${Object.entries(config).map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
    await writeFile(join(home, `${ANDROID_DEFAULT_AVD}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd${WIN ? '\\' : '/'}${ANDROID_DEFAULT_AVD}.avd\ntarget=android-${ANDROID_SYSTEM_IMAGE_API}\n`)
  }

  private async installAccel(dir: string): Promise<void> {
    const script = join(dir, 'silent_install.bat')
    if (!existsSync(script)) throw new Error('加速驱动安装包里没有 silent_install.bat')
    const code = await runElevated(script, dir)
    if (code !== 0) throw new Error(`加速驱动安装未完成（${code}），可能取消了管理员授权`)
  }
}
