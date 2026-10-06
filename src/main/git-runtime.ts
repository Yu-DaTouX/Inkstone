/**
 * 受管 Git 运行时：没有系统 Git 的 Windows 设备上，按用户确认把 PortableGit 装进砚的数据目录。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这样做
 * ══════════════════════════════════════════════════════════════════
 * pi 的命令行工具要 Git Bash，改动审阅 / 工作树 / 子任务隔离 / 检查点要 git 本体。
 * 让用户自己去官网装一遍太麻烦，随包再带 60MB 又让所有人都背上体积；所以按需下载：
 *   · 优先用系统里已有的 Git，**从不覆盖**用户自己装的；
 *   · 下载物必须通过 `GIT_RUNTIME_PIN` 里写死的 SHA-256 才会运行；
 *   · 解压在数据目录里，不弹安装向导、不要管理员权限、不改系统 PATH；
 *   · 只改**砚自己进程**的 PATH（`process.env.PATH`）：砚的 git 调用与 pi 子进程都继承它。
 *
 * 不依赖 electron：纯 Node 单测可以加载本文件。
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { YAN_DIR, PI_AGENT_DIR } from './paths'
import { GIT_RUNTIME_PIN, type GitInstallProgress, type GitRuntimeStatus } from '../shared/git-runtime'

/** 路径里有非 ASCII 字符（中文用户名很常见） */
export function hasNonAscii(path: string): boolean {
  for (let index = 0; index < path.length; index++) if (path.charCodeAt(index) > 127) return true
  return false
}

/**
 * 受管 Git 的安装位置。
 *
 * ⚠️ 必须是纯 ASCII 路径：pi 在 PATH 里找 bash 用的是 `where`，并把输出按 UTF-8 解码后再检查文件是否存在，
 * 路径含中文时会被解码成乱码，pi 就「找不到」bash（真实安装验证里抓到）。所以数据目录在中文用户名下时，
 * 改装到 `%ProgramData%\Inkstone\tools\git`（用户可在 ProgramData 下新建目录，不需要管理员权限）。
 */
export function managedGitRootFor(yanDir: string, programData = process.env.ProgramData || 'C:\\ProgramData'): string {
  const preferred = join(yanDir, 'tools', 'git')
  return hasNonAscii(preferred) ? join(programData, 'Inkstone', 'tools', 'git') : preferred
}

export const MANAGED_GIT_ROOT = managedGitRootFor(YAN_DIR)

export interface ManagedGitPaths {
  root: string
  /** 放进 PATH 的目录：git.exe 所在 */
  cmdDir: string
  /** 放进 PATH 的目录：bash.exe / sh.exe 所在 */
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

/* ------------------------------------------------------------------ 系统里已有的 */

function pathEntries(): string[] {
  return (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
}

/** 在 PATH 里找可执行文件（不起子进程）；`System32\bash.exe` 是 WSL 入口，不算 Git Bash */
function findOnPath(name: string): string | undefined {
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32').toLowerCase()
  for (const dir of pathEntries()) {
    if (name === 'bash' && dir.toLowerCase() === system32) continue
    const candidate = join(dir, `${name}.exe`)
    /* pi 自己用 where 找 bash，中文路径会乱码而找不到；这样的 bash 对 pi 等于不存在 */
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

/**
 * 系统里的 bash，查找顺序与随包 pi 的 `getShellConfig` 一致：
 * pi 设置里的 shellPath → Program Files\Git → Program Files (x86)\Git → PATH 里的 bash.exe。
 */
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

/* ------------------------------------------------------------------ 把受管那份接进进程环境 */

let applied: string[] = []

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

function writePath(entries: string[]): void {
  process.env.PATH = entries.join(delimiter)
}

/** 去掉上一次前置的目录，让「系统里有没有」的判断不被自己干扰 */
function stripApplied(): void {
  if (!applied.length) return
  writePath(pathEntries().filter((entry) => !applied.some((dir) => samePath(entry, dir))))
  applied = []
}

/**
 * 重新对齐进程 PATH：系统没有 git 才加受管的 `cmd`，系统没有 bash 才加受管的 `bin`。
 * 启动时与安装完成后各调一次；只在 Windows 上有效果。
 */
export async function refreshManagedGit(root = MANAGED_GIT_ROOT): Promise<{ git: boolean; bash: boolean }> {
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
}

/** 当前这份 PATH 下 git / bash 能否找到（含受管那份）；pi 启动前据此决定要不要退到 PowerShell */
export async function hasBash(): Promise<boolean> {
  if (process.platform !== 'win32') return true
  return !!(await findSystemBash()) || applied.some((dir) => existsSync(join(dir, 'bash.exe')))
}

export async function gitRuntimeStatus(): Promise<GitRuntimeStatus> {
  const supported = process.platform === 'win32'
  /* 判断「系统里有没有」要先摘掉自己前置的目录 */
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
      /* 没有记录就不显示版本 */
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
}

/* ------------------------------------------------------------------ 下载与安装 */

export interface InstallOptions {
  /** 优先走国内镜像（界面语言是中文时） */
  preferMirror?: boolean
  onProgress?: (progress: GitInstallProgress) => void
  /** 以下三项只给单测替换 */
  pin?: { size: number; sha256: string; github: string; mirror: string; version: string }
  root?: string
  extract?: (file: string, stageDir: string, signal: AbortSignal) => Promise<void>
}

let installing: AbortController | null = null

export function cancelGitInstall(): void {
  installing?.abort()
}

/** 下载一个地址到文件，边下边算哈希；任意 30 秒没有数据就当失败 */
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

/** PortableGit 是 7-Zip 自解压包：`-y` 不询问，`-o"目录"` 指定输出（路径要带引号，目录名里可能有空格或中文） */
function extractSfx(file: string, stageDir: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    /*
     * ⚠️ `argv0` 必须自己加引号：windowsVerbatimArguments 下 Node 不会替我们给可执行文件路径加引号，
     * 数据目录在带空格的用户名下（`C:\Users\Yu Da\…`）时，自解压程序把路径从空格处截断，
     * 窗口又是隐藏的，于是**一直挂着等一个看不见的对话框**（真实下载验证时抓到，空格路径 45 秒不退出，加引号后 8 秒完成）。
     */
    const child: ChildProcess = spawn(file, ['-y', `-o"${stageDir}"`], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      argv0: `"${file}"`,
      stdio: 'ignore'
    })
    /* 正常约 10 秒；3 分钟还没结束就是卡住了，别让用户对着转圈干等 */
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
    await rm(root, { recursive: true, force: true })
    await rename(stage, root)
    await writeFile(join(root, 'install.json'), JSON.stringify({ version: pin.version, sha256: pin.sha256, at: Date.now() }, null, 2), 'utf8')
    await refreshManagedGit(root)
    report({ phase: 'done', message: `已安装 Git ${pin.version}` })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await rm(file, { force: true }).catch(() => undefined)
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    report({ phase: 'error', message })
    return { ok: false, error: message }
  } finally {
    installing = null
  }
}

/** 卸载受管那份（设置里「移除」）；不动系统里的 Git */
export async function removeManagedGit(root = MANAGED_GIT_ROOT): Promise<void> {
  stripApplied()
  await rm(root, { recursive: true, force: true })
  await refreshManagedGit(root)
}
