import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { basename, dirname, extname } from 'node:path'
import { pick } from '../shared/ui-lang'
import { isLocalBaseUrl } from '../shared/model-capabilities'
import type { LocalLauncherDetectResult, LocalLauncherInput, LocalLauncherSaveResult, LocalLauncherView } from '../shared/custom-provider'
import { atomicWriteFile } from './atomic-write'
import { MODELS_FILE, renameProviderModel } from './custom-providers'
import { LOCAL_MODELS_CONFIG } from './local-models'

const PROBE_TIMEOUT_MS = 1_500
const POLL_MS = 1_000
const STOP_TIMEOUT_MS = 30_000
const PORT_CLOSE_WAIT_MS = 10_000
const LAUNCH_TIMEOUT_MS = 180_000
export const LOCAL_IDLE_UNLOAD_MS = 10 * 60_000
const IDLE_SCAN_MS = 60_000

type Json = Record<string, unknown>

async function readJson(file: string): Promise<Json> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

interface LauncherConfig {
  command: string
  stopCommand: string
  idleUnload: boolean
}

function launcherMap(config: Json): Record<string, LauncherConfig> {
  const raw = config.launchers
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, LauncherConfig> = {}
  for (const [provider, entry] of Object.entries(raw as Json)) {
    const value = (entry ?? {}) as { command?: unknown; stopCommand?: unknown; idleUnload?: unknown }
    if (typeof value.command !== 'string' || !value.command.trim()) continue
    out[provider] = {
      command: value.command.trim(),
      stopCommand: typeof value.stopCommand === 'string' ? value.stopCommand.trim() : '',
      idleUnload: value.idleUnload !== false
    }
  }
  return out
}

interface LocalProvider {
  provider: string
  name: string
  baseUrl: string
  models: Array<{ id: string; name?: string; baseUrl?: string }>
}

export function localProvidersOf(modelsJson: unknown): LocalProvider[] {
  const providers = (modelsJson as Json | null)?.providers
  if (!providers || typeof providers !== 'object') return []
  const out: LocalProvider[] = []
  for (const [provider, raw] of Object.entries(providers as Json)) {
    const entry = (raw ?? {}) as Json
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : ''
    const models = (Array.isArray(entry.models) ? entry.models : [])
      .filter((m): m is Json => !!m && typeof m === 'object' && typeof (m as Json).id === 'string')
      .map((m) => ({ id: m.id as string, ...(typeof m.name === 'string' && m.name.trim() ? { name: m.name.trim() } : {}), ...(typeof m.baseUrl === 'string' && m.baseUrl.trim() ? { baseUrl: m.baseUrl.trim() } : {}) }))
    if (!isLocalBaseUrl(baseUrl) && !models.some((m) => isLocalBaseUrl(m.baseUrl))) continue
    out.push({ provider, name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : provider, baseUrl, models })
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider))
}

function providerBaseUrl(item: LocalProvider): string {
  return item.baseUrl || item.models.find((m) => m.baseUrl)?.baseUrl || ''
}

export async function listLocalLaunchers(): Promise<LocalLauncherView[]> {
  const [models, config] = await Promise.all([readJson(MODELS_FILE), readJson(LOCAL_MODELS_CONFIG)])
  const launchers = launcherMap(config)
  return localProvidersOf(models).map((item) => ({
    provider: item.provider,
    name: item.name,
    baseUrl: providerBaseUrl(item),
    command: launchers[item.provider]?.command ?? '',
    stopCommand: launchers[item.provider]?.stopCommand ?? '',
    idleUnload: launchers[item.provider]?.idleUnload ?? true,
    models: item.models.map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }))
  }))
}

export async function renameLocalModel(provider: string, modelId: string, name: string): Promise<LocalLauncherView[]> {
  const known = localProvidersOf(await readJson(MODELS_FILE)).some((item) => item.provider === provider)
  if (!known) throw new Error(pick(`「${provider}」不是本地模型服务`, `"${provider}" is not a local model service`))
  const result = await renameProviderModel(provider, modelId, name)
  if (!result.ok) throw new Error(result.error)
  return listLocalLaunchers()
}

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1')
}

export function commandFile(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  const bare = unquote(trimmed)
  if (!/["']/.test(bare) && existsSync(bare)) return bare
  const quoted = trimmed.match(/^"([^"]+)"/)
  const token = quoted ? quoted[1]! : trimmed.split(/\s+/)[0]!
  return /[\\/]/.test(token) || /\.(bat|cmd|ps1|exe)$/i.test(token) ? token : null
}

const STOP_LIKE = /停止|关闭|卸载|结束|stop|kill|shutdown|unload/i

export function looksLikeStopScript(command: string): boolean {
  const file = commandFile(command)
  return !!file && STOP_LIKE.test(basename(file))
}

function missingFileError(command: string, label: string): string | null {
  const file = commandFile(command)
  if (!file || existsSync(file)) return null
  return pick(`${label}里的文件不存在：${file}`, `File in the ${label} does not exist: ${file}`)
}

export async function saveLocalLauncher(provider: string, input: LocalLauncherInput): Promise<LocalLauncherSaveResult> {
  const known = localProvidersOf(await readJson(MODELS_FILE)).some((item) => item.provider === provider)
  if (!known) throw new Error(pick(`「${provider}」不是本地模型服务`, `"${provider}" is not a local model service`))
  const command = String(input.command ?? '').trim()
  const stopCommand = String(input.stopCommand ?? '').trim()
  const missing = missingFileError(command, pick('启动命令', 'start command')) ?? missingFileError(stopCommand, pick('停止命令', 'stop command'))
  if (missing) throw new Error(missing)
  const config = await readJson(LOCAL_MODELS_CONFIG)
  const launchers = { ...((config.launchers && typeof config.launchers === 'object' ? config.launchers : {}) as Json) }
  if (command) launchers[provider] = { command, ...(stopCommand ? { stopCommand } : {}), ...(input.idleUnload === false ? { idleUnload: false } : {}) }
  else delete launchers[provider]
  await mkdir(dirname(LOCAL_MODELS_CONFIG), { recursive: true })
  await atomicWriteFile(LOCAL_MODELS_CONFIG, `${JSON.stringify({ ...config, launchers }, null, 2)}\n`)
  const warning = command && looksLikeStopScript(command)
    ? pick(`启动命令「${basename(commandFile(command) ?? command)}」看起来是停止脚本；发消息时会运行它，请确认选的是启动脚本`, `The start command "${basename(commandFile(command) ?? command)}" looks like a stop script; it will run when you send a message, so make sure it is the start script`)
    : undefined
  return { launchers: await listLocalLaunchers(), ...(warning ? { warning } : {}) }
}

function probeUrls(baseUrl: string): string[] {
  const root = baseUrl.replace(/\/+$/, '')
  return /\/v1$/.test(root) ? [`${root}/models`] : [`${root}/models`, `${root}/v1/models`]
}

export async function localServing(baseUrl: string): Promise<boolean> {
  for (const url of probeUrls(baseUrl)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (response.ok) return true
    } catch {
      continue
    }
  }
  return false
}

function hostPort(baseUrl: string): { host: string; port: number } | null {
  try {
    const url = new URL(baseUrl)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    return { host: host === '0.0.0.0' ? '127.0.0.1' : host, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) }
  } catch {
    return null
  }
}

export function portOpen(baseUrl: string): Promise<boolean> {
  const target = hostPort(baseUrl)
  if (!target) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = connect(target)
    const done = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export function launchLine(command: string): { line: string; cwd?: string } {
  const trimmed = command.trim()
  const bare = unquote(trimmed)
  if (!/["']/.test(bare) && existsSync(bare)) {
    const cwd = dirname(bare)
    if (extname(bare).toLowerCase() === '.ps1') return { line: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${bare}"`, cwd }
    return { line: `"${bare}"`, cwd }
  }
  return { line: trimmed }
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function launch(command: string): ChildProcess {
  const { line, cwd } = launchLine(command)
  const child = spawn(line, { shell: true, detached: true, stdio: 'ignore', windowsHide: false, env: childEnv(), ...(cwd ? { cwd } : {}) })
  child.on('error', (error) => console.error('[local-model] start command failed', error))
  child.unref()
  return child
}

function runToEnd(command: string, timeoutMs: number): Promise<number | null> {
  const { line, cwd } = launchLine(command)
  return new Promise((resolve) => {
    const child = spawn(line, { shell: true, stdio: 'ignore', windowsHide: true, env: childEnv(), ...(cwd ? { cwd } : {}) })
    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, timeoutMs)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout ?? '')))
  })
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
  else {
    try {
      process.kill(pid)
    } catch {
      return
    }
  }
}

const inflight = new Map<string, Promise<{ ok: boolean; error?: string }>>()
const unloading = new Map<string, Promise<boolean>>()
const launched = new Map<string, ChildProcess>()
const lastUsed = new Map<string, number>()

interface Target {
  name: string
  baseUrl: string
  launcher: LauncherConfig
}

async function targetOf(provider: string, modelId?: string): Promise<Target | null> {
  let config: Json
  let models: Json
  try {
    config = await readJson(LOCAL_MODELS_CONFIG)
    models = await readJson(MODELS_FILE)
  } catch {
    return null
  }
  const launcher = launcherMap(config)[provider]
  if (!launcher) return null
  const item = localProvidersOf(models).find((entry) => entry.provider === provider)
  if (!item) return null
  const baseUrl = (modelId ? item.models.find((m) => m.id === modelId)?.baseUrl : undefined) ?? providerBaseUrl(item)
  if (!isLocalBaseUrl(baseUrl)) return null
  return { name: item.name, baseUrl, launcher }
}

export interface EnsureLocalModelOptions {
  onStarting?: (name: string) => void
  timeoutMs?: number
  pollMs?: number
  run?: (command: string) => ChildProcess | void
}

export async function ensureLocalModelReady(provider: string, modelId: string, options: EnsureLocalModelOptions = {}): Promise<{ ok: boolean; error?: string; started?: boolean }> {
  const target = await targetOf(provider, modelId)
  if (!target) return { ok: true }
  lastUsed.set(provider, Date.now())
  await unloading.get(provider)
  const pending = inflight.get(provider)
  if (pending) return { ...(await pending), started: true }
  if (await portOpen(target.baseUrl)) return { ok: true }
  const again = inflight.get(provider)
  if (again) return { ...(await again), started: true }
  const task = (async () => {
    options.onStarting?.(target.name)
    let exitCode: number | null | undefined
    try {
      const child = (options.run ?? launch)(target.launcher.command)
      if (child) {
        launched.set(provider, child)
        child.once('exit', (code) => {
          exitCode = code
        })
      }
    } catch (error) {
      return { ok: false, error: pick(`本地模型「${target.name}」的启动命令没能运行：${error instanceof Error ? error.message : String(error)}`, `Could not run the start command for local model "${target.name}": ${error instanceof Error ? error.message : String(error)}`) }
    }
    const timeout = options.timeoutMs ?? LAUNCH_TIMEOUT_MS
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS))
      if (await localServing(target.baseUrl)) {
        lastUsed.set(provider, Date.now())
        return { ok: true }
      }
      if (typeof exitCode === 'number' && exitCode !== 0) {
        return { ok: false, error: pick(`本地模型「${target.name}」的启动命令出错退出（代码 ${exitCode}），消息未发送，草稿已保留。请在设置里检查启动命令。`, `The start command for local model "${target.name}" exited with code ${exitCode}; message not sent, draft kept. Check the start command in Settings.`) }
      }
    }
    const seconds = Math.round(timeout / 1000)
    return { ok: false, error: pick(`本地模型「${target.name}」启动后 ${seconds} 秒内没有就绪，消息未发送，草稿已保留。请查看它的启动窗口。`, `Local model "${target.name}" was not ready within ${seconds}s of starting; message not sent, draft kept. Check its startup window.`) }
  })()
  inflight.set(provider, task)
  try {
    return { ...(await task), started: true }
  } finally {
    inflight.delete(provider)
  }
}

export function listeningPid(netstat: string, port: number): number | null {
  for (const line of netstat.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || cols[0]?.toUpperCase() !== 'TCP' || cols[3]?.toUpperCase() !== 'LISTENING') continue
    if (!cols[1]?.endsWith(`:${port}`)) continue
    const pid = Number(cols[4])
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return null
}

export interface UnloadOptions {
  stop?: (command: string) => Promise<unknown>
  kill?: (pid: number) => Promise<void>
  listener?: (port: number) => Promise<number | null>
  closeWaitMs?: number
}

async function listenerPid(port: number): Promise<number | null> {
  return process.platform === 'win32' ? listeningPid(await run('netstat.exe', ['-ano', '-p', 'TCP']), port) : null
}

export async function unloadLocalModel(provider: string, options: UnloadOptions = {}): Promise<boolean> {
  const target = await targetOf(provider)
  if (!target) return false
  const current = unloading.get(provider)
  if (current) return current
  const task = (async () => {
    const kill = options.kill ?? killTree
    if (target.launcher.stopCommand) await (options.stop ?? ((command: string) => runToEnd(command, STOP_TIMEOUT_MS)))(target.launcher.stopCommand)
    else {
      const port = hostPort(target.baseUrl)?.port
      const pid = port ? await (options.listener ?? listenerPid)(port) : null
      if (pid) await kill(pid)
    }
    const child = launched.get(provider)
    if (child?.pid && child.exitCode === null && child.signalCode === null) await kill(child.pid)
    launched.delete(provider)
    const deadline = Date.now() + (options.closeWaitMs ?? PORT_CLOSE_WAIT_MS)
    while (await portOpen(target.baseUrl)) {
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    lastUsed.delete(provider)
    return true
  })()
  unloading.set(provider, task)
  try {
    return await task
  } finally {
    unloading.delete(provider)
  }
}

export interface IdleUnloadOptions {
  busy: (provider: string) => boolean
  onUnloaded?: (name: string, provider: string) => void
  now?: () => number
  idleMs?: number
  unload?: (provider: string) => Promise<boolean>
}

export async function scanIdleLocalModels(options: IdleUnloadOptions): Promise<string[]> {
  const now = (options.now ?? Date.now)()
  let config: Json
  let models: Json
  try {
    config = await readJson(LOCAL_MODELS_CONFIG)
    models = await readJson(MODELS_FILE)
  } catch {
    return []
  }
  const launchers = launcherMap(config)
  const unloaded: string[] = []
  for (const item of localProvidersOf(models)) {
    const launcher = launchers[item.provider]
    if (!launcher?.idleUnload || inflight.has(item.provider) || unloading.has(item.provider)) continue
    if (options.busy(item.provider)) {
      lastUsed.set(item.provider, now)
      continue
    }
    if (!(await portOpen(providerBaseUrl(item)))) {
      lastUsed.delete(item.provider)
      continue
    }
    const last = lastUsed.get(item.provider)
    if (last === undefined) {
      lastUsed.set(item.provider, now)
      continue
    }
    if (now - last < (options.idleMs ?? LOCAL_IDLE_UNLOAD_MS)) continue
    lastUsed.set(item.provider, now)
    if (await (options.unload ?? unloadLocalModel)(item.provider)) {
      unloaded.push(item.provider)
      options.onUnloaded?.(item.name, item.provider)
    }
  }
  return unloaded
}

export function startLocalModelIdleUnload(options: IdleUnloadOptions): () => void {
  let scanning = false
  const timer = setInterval(() => {
    if (scanning) return
    scanning = true
    void scanIdleLocalModels(options)
      .catch((error) => console.error('[local-model] idle unload scan failed', error))
      .finally(() => {
        scanning = false
      })
  }, IDLE_SCAN_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

export function launcherFromProcess(info: { command?: string | null; parent?: string | null }): string | null {
  const parent = info.parent ?? ''
  const script = parent.match(/[A-Za-z]:\\[^"<>|*?\r\n]*?\.(?:bat|cmd|ps1)(?=["\s]|$)/i)?.[0]
  if (script) return script
  const command = info.command?.trim()
  return command ? command : null
}

export async function detectLocalLauncher(provider: string): Promise<LocalLauncherDetectResult> {
  if (process.platform !== 'win32') return { ok: false, message: pick('目前只支持在 Windows 上自动识别', 'Auto-detection currently works on Windows only') }
  const target = (await listLocalLaunchers()).find((item) => item.provider === provider)
  if (!target) return { ok: false, message: pick(`「${provider}」不是本地模型服务`, `"${provider}" is not a local model service`) }
  const port = hostPort(target.baseUrl)?.port ?? 0
  const pid = port ? await listenerPid(port) : null
  if (!pid) return { ok: false, message: pick(`端口 ${port} 上没有正在运行的服务；先手动启动一次再识别`, `Nothing is listening on port ${port}; start it once manually, then detect`) }
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; $q = if ($p) { Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) }; [Console]::OutputEncoding = [Text.Encoding]::UTF8; @{ command = $p.CommandLine; parent = $q.CommandLine } | ConvertTo-Json -Compress`
  let info: { command?: string | null; parent?: string | null } = {}
  try {
    info = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])) as typeof info
  } catch {
    info = {}
  }
  const command = launcherFromProcess(info)
  if (!command) return { ok: false, message: pick('没能读取启动它的程序', 'Could not read the program that started it') }
  return { ok: true, command, message: pick('已按正在运行的服务填好启动命令，确认后保存', 'Filled in from the running service; review and save') }
}
