/**
 * 按需启动、关闭本机 ComfyUI。
 *
 * 生图走本机通道而 ComfyUI 已安装、没在运行时，用安装目录自带的 Python 拉起 `main.py`
 * （venv / .venv / Pinokio 的 env、便携包的 python_embeded；`YAN_COMFYUI_PYTHON` 可指定），
 * 只监听本机回环，等 `/system_stats` 就绪后再出图。空闲一段时间（默认 10 分钟，
 * `YAN_COMFYUI_IDLE_MINUTES`，0 表示不自动关）后关掉以释放显存，砚退出时也一并关掉。
 *
 * 只管砚自己拉起的进程：用户自己开着的 ComfyUI 不会被关。桌面版 ComfyUI 的数据目录里没有
 * main.py，由它自己的应用启动，这里不代劳。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import type { LocalModelServer } from '../shared/custom-provider'
import { comfyInstallCandidates, detectLocalImageService, isComfyInstall, listComfyWorkflows, resetLocalImageCache } from './local-models'

export class ComfyLaunchError extends Error {
  constructor(readonly code: string, readonly reason?: string) {
    super(reason ? `${code}: ${reason}` : code)
  }
}

export interface ComfyLaunch {
  python: string
  args: string[]
  cwd: string
}

/** 安装目录自带的 Python 与启动参数；找不到可用的 Python（或是桌面版数据目录）时返回 null */
export function comfyLaunchCommand(installDir: string): ComfyLaunch | null {
  if (!existsSync(join(installDir, 'main.py'))) return null
  const exe = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  const portable = join(dirname(installDir), 'python_embeded', process.platform === 'win32' ? 'python.exe' : 'python')
  const python = [
    process.env.YAN_COMFYUI_PYTHON?.trim(),
    ...['venv', '.venv', 'env'].map((name) => join(installDir, name, ...exe)),
    portable
  ].find((path): path is string => !!path && existsSync(path))
  if (!python) return null
  const extra = process.env.YAN_COMFYUI_ARGS?.trim().split(/\s+/).filter(Boolean) ?? []
  return { python, args: [...(python === portable ? ['-s'] : []), 'main.py', ...extra], cwd: installDir }
}

/** 第一个能用砚拉起的 ComfyUI 安装目录 */
export async function findLaunchableComfy(): Promise<string | null> {
  for (const dir of await comfyInstallCandidates()) {
    if (isComfyInstall(dir) && comfyLaunchCommand(dir)) return dir
  }
  return null
}

interface Managed {
  child: ChildProcess
  installDir: string
  baseUrl: string
  startedAt: number
  log: string[]
  exited: boolean
  busy: number
  idleTimer?: NodeJS.Timeout
  idleStopAt?: number
}

let managed: Managed | null = null
let starting: Promise<LocalModelServer> | null = null

function idleMinutes(): number {
  const value = Number(process.env.YAN_COMFYUI_IDLE_MINUTES ?? 10)
  return Number.isFinite(value) && value >= 0 ? value : 10
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function pickPort(): Promise<number> {
  for (let port = 8188; port < 8200; port += 1) if (await portFree(port)) return port
  throw new ComfyLaunchError('local_launch_failed', '8188–8199 端口都被占用')
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill()
  }
}

async function serverAt(baseUrl: string): Promise<LocalModelServer | null> {
  try {
    const response = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return null
    const workflows = await listComfyWorkflows(baseUrl).catch(() => [])
    return { kind: 'comfyui', purpose: 'image', name: 'ComfyUI', baseUrl, models: workflows.map((item) => item.name), running: true, installDir: managed?.installDir }
  } catch {
    return null
  }
}

function scheduleIdleStop(): void {
  if (!managed) return
  clearTimeout(managed.idleTimer)
  managed.idleTimer = undefined
  managed.idleStopAt = undefined
  const minutes = idleMinutes()
  if (!minutes || managed.busy > 0) return
  managed.idleStopAt = Date.now() + minutes * 60_000
  managed.idleTimer = setTimeout(() => {
    if (managed && managed.busy === 0) stopManagedComfy()
  }, minutes * 60_000)
  managed.idleTimer.unref?.()
}

async function launch(installDir: string, report?: (detail: string) => void): Promise<LocalModelServer> {
  const command = comfyLaunchCommand(installDir)
  if (!command) throw new ComfyLaunchError('local_launch_unavailable', `${installDir} 里没有找到可用的 Python 环境`)
  const port = await pickPort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(command.python, [...command.args, '--listen', '127.0.0.1', '--port', String(port)], {
    cwd: command.cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const state: Managed = { child, installDir, baseUrl, startedAt: Date.now(), log: [], exited: false, busy: 0 }
  managed = state
  const keep = (chunk: Buffer): void => {
    state.log.push(...chunk.toString('utf8').split(/\r?\n/).filter((line) => line.trim()))
    if (state.log.length > 40) state.log.splice(0, state.log.length - 40)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  child.once('exit', () => {
    state.exited = true
    clearTimeout(state.idleTimer)
    if (managed === state) managed = null
    resetLocalImageCache()
  })
  child.once('error', (error) => keep(Buffer.from(error.message)))

  report?.(`正在启动 ComfyUI（${installDir}）`)
  const timeoutMs = Number(process.env.YAN_COMFYUI_START_SECONDS ?? 300) * 1000
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300_000)
  while (Date.now() < deadline) {
    if (state.exited) throw new ComfyLaunchError('local_launch_failed', state.log.slice(-3).join(' | ').slice(0, 300) || 'ComfyUI 启动后立即退出')
    const server = await serverAt(baseUrl)
    if (server) {
      resetLocalImageCache()
      report?.(`ComfyUI 已就绪（${Math.round((Date.now() - state.startedAt) / 1000)} 秒）`)
      scheduleIdleStop()
      return server
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  killTree(child)
  throw new ComfyLaunchError('local_launch_timeout', state.log.slice(-3).join(' | ').slice(0, 300))
}

/** 已在运行的（自己开的或砚拉起的）直接用；否则找安装目录启动。并发调用共用同一次启动 */
export async function ensureComfyRunning(report?: (detail: string) => void): Promise<LocalModelServer> {
  if (managed && !managed.exited) {
    const server = await serverAt(managed.baseUrl)
    if (server) return server
  }
  const running = await detectLocalImageService()
  if (running?.kind === 'comfyui') return running
  if (!starting) {
    starting = (async () => {
      const dir = await findLaunchableComfy()
      if (!dir) throw new ComfyLaunchError('local_launch_unavailable', '没有找到能直接启动的 ComfyUI 安装（桌面版请先打开它的应用）')
      return launch(dir, report)
    })().finally(() => {
      starting = null
    })
  }
  return starting
}

/** 生图期间不被空闲计时关掉；返回结束时调用的函数 */
export function holdManagedComfy(baseUrl: string): () => void {
  const state = managed
  if (!state || state.baseUrl !== baseUrl) return () => {}
  state.busy += 1
  clearTimeout(state.idleTimer)
  state.idleStopAt = undefined
  return () => {
    state.busy = Math.max(0, state.busy - 1)
    if (managed === state) scheduleIdleStop()
  }
}

/** 关掉砚拉起的 ComfyUI；用户自己开的不动。返回是否真的关了 */
export function stopManagedComfy(): boolean {
  const state = managed
  if (!state || state.exited) return false
  clearTimeout(state.idleTimer)
  managed = null
  killTree(state.child)
  resetLocalImageCache()
  return true
}

export interface ComfyStatus {
  /** 本机有 ComfyUI 在运行（不论是谁开的） */
  running: boolean
  baseUrl?: string
  /** 正在运行的是砚拉起的 */
  managed: boolean
  installDir?: string
  startedAt?: number
  idleStopAt?: number
  /** 没在运行时，能否由砚启动 */
  launchable: boolean
  workflows: string[]
}

export async function comfyStatus(): Promise<ComfyStatus> {
  resetLocalImageCache()
  const running = managed && !managed.exited ? await serverAt(managed.baseUrl) : null
  const other = running ? null : await detectLocalImageService()
  const server = running ?? (other?.kind === 'comfyui' ? other : null)
  const installDir = managed?.installDir ?? (server ? undefined : await findLaunchableComfy() ?? undefined)
  return {
    running: !!server,
    ...(server ? { baseUrl: server.baseUrl } : {}),
    managed: !!running,
    ...(installDir ? { installDir } : {}),
    ...(running && managed ? { startedAt: managed.startedAt, ...(managed.idleStopAt ? { idleStopAt: managed.idleStopAt } : {}) } : {}),
    launchable: !!server || !!installDir,
    workflows: server?.models ?? []
  }
}

process.once('exit', () => {
  stopManagedComfy()
})
