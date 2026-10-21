import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { YAN_DIR, PI_AGENT_DIR } from './paths'
import { GIT_RUNTIME_PIN, type GitInstallProgress, type GitRuntimeStatus } from '../shared/git-runtime'

export function hasNonAscii(path: string): boolean {
  for (let index = 0; index < path.length; index++) if (path.charCodeAt(index) > 127) return true
  return false
}

export function managedGitRootFor(yanDir: string, programData = process.env.ProgramData || 'C:\\ProgramData'): string {
  const preferred = join(yanDir, 'tools', 'git')
  return hasNonAscii(preferred) ? join(programData, 'Inkstone', 'tools', 'git') : preferred
}

export const MANAGED_GIT_ROOT = managedGitRootFor(YAN_DIR)

export interface ManagedGitPaths {
  root: string
  cmdDir: string
  binDir: string
  gitExe: string
  bashExe: string
}

export function managedGitPaths(root = MANAGED_GIT_ROOT): ManagedGitPaths | null {
  const paths: ManagedGitPaths = {
    root,
    cmdDir: join(root, 'cmd'),
    binDir: join(root, 'bin'),
    gitExe: join(root, 'cmd', 'git.exe'),
    bashExe: join(root, 'bin', 'bash.exe')
  }
  return existsSync(paths.gitExe) && existsSync(paths.bashExe) ? paths : null
}

function pathEntries(): string[] {
  return (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
}

function findOnPath(name: string): string | undefined {
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32').toLowerCase()
  for (const dir of pathEntries()) {
    if (name === 'bash' && dir.toLowerCase() === system32) continue
    const candidate = join(dir, `${name}.exe`)
    if (name === 'bash' && hasNonAscii(candidate)) continue
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

async function configuredShellPath(): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(PI_AGENT_DIR, 'settings.json'), 'utf8')) as { shellPath?: unknown }
    return typeof raw.shellPath === 'string' && raw.shellPath.trim() ? raw.shellPath.trim() : undefined
  } catch {
    return undefined
  }
}

export async function findSystemBash(): Promise<string | undefined> {
  const custom = await configuredShellPath()
  if (custom && existsSync(custom)) return custom
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!root) continue
    const candidate = join(root, 'Git', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }
  return findOnPath('bash')
}

export function findSystemGit(): string | undefined {
  return findOnPath('git')
}

let applied: string[] = []

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

function writePath(entries: string[]): void {
  process.env.PATH = entries.join(delimiter)
}

function stripApplied(): void {
  if (!applied.length) return
  writePath(pathEntries().filter((entry) => !applied.some((dir) => samePath(entry, dir))))
  applied = []
}

let pathQueue: Promise<unknown> = Promise.resolve()

function withPathLock<T>(run: () => Promise<T>): Promise<T> {
  const next = pathQueue.then(run, run)
  pathQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

export function refreshManagedGit(root = MANAGED_GIT_ROOT): Promise<{ git: boolean; bash: boolean }> {
  return withPathLock(async () => {
    if (process.platform !== 'win32') return { git: true, bash: true }
    stripApplied()
    const paths = managedGitPaths(root)
    const systemGit = !!findSystemGit()
    const systemBash = !!(await findSystemBash())
    if (paths) {
      const dirs: string[] = []
      if (!systemGit) dirs.push(paths.cmdDir)
      if (!systemBash && !hasNonAscii(paths.binDir)) dirs.push(paths.binDir)
      if (dirs.length) {
        writePath([...dirs, ...pathEntries()])
        applied = dirs
      }
    }
    return { git: systemGit || (!!paths && applied.includes(paths.cmdDir)), bash: systemBash || (!!paths && applied.includes(paths.binDir)) }
  })
}

export async function hasBash(): Promise<boolean> {
  if (process.platform !== 'win32') return true
  return !!(await findSystemBash()) || applied.some((dir) => existsSync(join(dir, 'bash.exe')))
}

export function gitRuntimeStatus(): Promise<GitRuntimeStatus> {
  return withPathLock(async () => {
    const supported = process.platform === 'win32'
    const keep = applied
    if (supported) stripApplied()
    const systemGit = supported ? !!findSystemGit() : true
    const systemBash = supported ? !!(await findSystemBash()) : true
    if (supported && keep.length) {
      writePath([...keep, ...pathEntries()])
      applied = keep
    }
    const installed = managedGitPaths() !== null
    let managedVersion: string | undefined
    if (installed) {
      try {
        managedVersion = JSON.parse(await readFile(join(MANAGED_GIT_ROOT, 'install.json'), 'utf8')).version
      } catch {
      }
    }
    return {
      supported,
      systemGit,
      systemBash,
      managedInstalled: installed,
      ...(managedVersion ? { managedVersion } : {}),
      installing: installing !== null,
      downloadSize: GIT_RUNTIME_PIN.size
    }
  })
}

export interface InstallOptions {
  preferMirror?: boolean
  onProgress?: (progress: GitInstallProgress) => void
  pin?: { size: number; sha256: string; github: string; mirror: string; version: string }
  root?: string
  extract?: (file: string, stageDir: string, signal: AbortSignal) => Promise<void>
}

let installing: AbortController | null = null

export function cancelGitInstall(): void {
  installing?.abort()
}

async function download(
  url: string,
  file: string,
  expected: { size: number; sha256: string },
  signal: AbortSignal,
  onBytes: (received: number) => void
): Promise<void> {
  const stall = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => stall.abort(), 30_000)
  }
  const onAbort = (): void => stall.abort()
  signal.addEventListener('abort', onAbort)
  arm()
  try {
    const response = await fetch(url, { signal: stall.signal, redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    const hash = createHash('sha256')
    const out = createWriteStream(file)
    let received = 0
    try {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        hash.update(value)
        received += value.byteLength
        onBytes(received)
        if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()))
    }
    if (received !== expected.size) throw new Error(`大小不符（${received} / ${expected.size}）`)
    if (hash.digest('hex') !== expected.sha256) throw new Error('SHA-256 校验失败')
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

function extractSfx(file: string, stageDir: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(file, ['-y', `-o"${stageDir}"`], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      argv0: `"${file}"`,
      stdio: 'ignore'
    })
    const timer = setTimeout(() => child.kill(), 3 * 60_000)
    const onAbort = (): void => {
      child.kill()
    }
    signal.addEventListener('abort', onAbort)
    child.on('error', (error) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(new Error('已取消'))
      else if (code === 0) resolve()
      else reject(new Error(`解压失败（退出码 ${code}）`))
    })
  })
}

function gitVersionOf(gitExe: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(gitExe, ['--version'], { timeout: 15_000, windowsHide: true, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout).trim())
    )
  })
}

export async function installManagedGit(options: InstallOptions = {}): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32' && !options.extract) return { ok: false, error: '只有 Windows 需要这一步' }
  if (installing) return { ok: false, error: '已经在安装中' }
  const controller = new AbortController()
  installing = controller
  const pin = options.pin ?? GIT_RUNTIME_PIN
  const root = options.root ?? MANAGED_GIT_ROOT
  const report = (progress: GitInstallProgress): void => options.onProgress?.(progress)
  const toolsDir = join(root, '..')
  const file = join(toolsDir, `${pin.version}.download.exe`)
  const stage = `${root}.staging`
  const backup = `${root}.old-${process.pid}-${Date.now()}`
  let movedOld = false
  let installedNew = false
  try {
    await mkdir(toolsDir, { recursive: true })
    await rm(stage, { recursive: true, force: true })

    const urls = options.preferMirror ? [pin.mirror, pin.github] : [pin.github, pin.mirror]
    let lastError = ''
    let downloaded = false
    for (const url of urls) {
      if (controller.signal.aborted) throw new Error('已取消')
      try {
        report({ phase: 'downloading', received: 0, total: pin.size, message: url === pin.mirror ? '从国内镜像下载' : '从 GitHub 下载' })
        let lastReport = 0
        await download(url, file, pin, controller.signal, (received) => {
          const now = Date.now()
          if (now - lastReport < 250) return
          lastReport = now
          report({ phase: 'downloading', received, total: pin.size })
        })
        downloaded = true
        break
      } catch (error) {
        if (controller.signal.aborted) throw new Error('已取消')
        lastError = error instanceof Error ? error.message : String(error)
        await rm(file, { force: true })
      }
    }
    if (!downloaded) throw new Error(`下载失败：${lastError || '无法连接'}。检查网络后重试，或手动安装 Git for Windows。`)

    report({ phase: 'verifying', message: '校验通过' })
    report({ phase: 'extracting', message: '正在解压（约半分钟）' })
    await (options.extract ?? extractSfx)(file, stage, controller.signal)
    await rm(file, { force: true })

    if (!existsSync(join(stage, 'cmd', 'git.exe')) || !existsSync(join(stage, 'bin', 'bash.exe'))) {
      throw new Error('解压后的目录里没有找到 git.exe / bash.exe')
    }
    if (!options.extract) await gitVersionOf(join(stage, 'cmd', 'git.exe'))
    await writeFile(join(stage, 'install.json'), JSON.stringify({ version: pin.version, sha256: pin.sha256, at: Date.now() }, null, 2), 'utf8')
    if (existsSync(root)) {
      await rename(root, backup)
      movedOld = true
    }
    try {
      await rename(stage, root)
      installedNew = true
    } catch (error) {
      if (movedOld) {
        await rename(backup, root)
        movedOld = false
      }
      throw error
    }
    await refreshManagedGit(root)
    if (movedOld) {
      await rm(backup, { recursive: true, force: true })
      movedOld = false
    }
    report({ phase: 'done', message: `已安装 Git ${pin.version}` })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await rm(file, { force: true }).catch(() => undefined)
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    if (movedOld) {
      if (installedNew) await rm(root, { recursive: true, force: true }).catch(() => undefined)
      if (!existsSync(root)) {
        await rename(backup, root).then(() => { movedOld = false }).catch(() => undefined)
      }
    }
    report({ phase: 'error', message })
    return { ok: false, error: message }
  } finally {
    installing = null
  }
}

export async function removeManagedGit(root = MANAGED_GIT_ROOT): Promise<void> {
  stripApplied()
  await rm(root, { recursive: true, force: true })
  await refreshManagedGit(root)
}
