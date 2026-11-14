import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname, extname } from 'node:path'
import { pick } from '../shared/ui-lang'
import { isLocalBaseUrl } from '../shared/model-capabilities'
import type { LocalLauncherDetectResult, LocalLauncherView } from '../shared/custom-provider'
import { atomicWriteFile } from './atomic-write'
import { MODELS_FILE, renameProviderModel } from './custom-providers'
import { LOCAL_MODELS_CONFIG } from './local-models'

const PROBE_TIMEOUT_MS = 1_500
const POLL_MS = 1_000
export const LAUNCH_TIMEOUT_MS = 180_000

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

function launcherMap(config: Json): Record<string, string> {
  const raw = config.launchers
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [provider, entry] of Object.entries(raw as Json)) {
    const command = (entry as { command?: unknown } | null)?.command
    if (typeof command === 'string' && command.trim()) out[provider] = command.trim()
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

export async function listLocalLaunchers(): Promise<LocalLauncherView[]> {
  const [models, config] = await Promise.all([readJson(MODELS_FILE), readJson(LOCAL_MODELS_CONFIG)])
  const commands = launcherMap(config)
  return localProvidersOf(models).map((item) => ({
    provider: item.provider,
    name: item.name,
    baseUrl: item.baseUrl || item.models.find((m) => m.baseUrl)?.baseUrl || '',
    command: commands[item.provider] ?? '',
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

export async function saveLocalLauncher(provider: string, command: string): Promise<LocalLauncherView[]> {
  const known = localProvidersOf(await readJson(MODELS_FILE)).some((item) => item.provider === provider)
  if (!known) throw new Error(pick(`「${provider}」不是本地模型服务`, `"${provider}" is not a local model service`))
  const config = await readJson(LOCAL_MODELS_CONFIG)
  const launchers = { ...((config.launchers && typeof config.launchers === 'object' ? config.launchers : {}) as Json) }
  const value = command.trim()
  if (value) launchers[provider] = { command: value }
  else delete launchers[provider]
  await mkdir(dirname(LOCAL_MODELS_CONFIG), { recursive: true })
  await atomicWriteFile(LOCAL_MODELS_CONFIG, `${JSON.stringify({ ...config, launchers }, null, 2)}\n`)
  return listLocalLaunchers()
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

export function portOpen(baseUrl: string): Promise<boolean> {
  let host: string
  let port: number
  try {
    const url = new URL(baseUrl)
    host = url.hostname.replace(/^\[|\]$/g, '')
    port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  } catch {
    return Promise.resolve(false)
  }
  if (host === '0.0.0.0') host = '127.0.0.1'
  return new Promise((resolve) => {
    const socket = connect({ host, port })
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
  const bare = trimmed.replace(/^"(.*)"$/, '$1')
  if (!/["']/.test(bare) && existsSync(bare)) {
    const cwd = dirname(bare)
    if (extname(bare).toLowerCase() === '.ps1') return { line: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${bare}"`, cwd }
    return { line: `"${bare}"`, cwd }
  }
  return { line: trimmed }
}

function launch(command: string): void {
  const { line, cwd } = launchLine(command)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(line, { shell: true, detached: true, stdio: 'ignore', windowsHide: false, env, ...(cwd ? { cwd } : {}) })
  child.on('error', (error) => console.error('[local-model] start command failed', error))
  child.unref()
}

const inflight = new Map<string, Promise<{ ok: boolean; error?: string }>>()

export interface EnsureLocalModelOptions {
  onStarting?: (name: string) => void
  timeoutMs?: number
  pollMs?: number
  run?: (command: string) => void
}

export async function ensureLocalModelReady(provider: string, modelId: string, options: EnsureLocalModelOptions = {}): Promise<{ ok: boolean; error?: string; started?: boolean }> {
  let config: Json
  let models: Json
  try {
    config = await readJson(LOCAL_MODELS_CONFIG)
  } catch {
    return { ok: true }
  }
  const command = launcherMap(config)[provider]
  if (!command) return { ok: true }
  try {
    models = await readJson(MODELS_FILE)
  } catch {
    return { ok: true }
  }
  const target = localProvidersOf(models).find((item) => item.provider === provider)
  if (!target) return { ok: true }
  const baseUrl = target.models.find((m) => m.id === modelId)?.baseUrl ?? target.baseUrl
  if (!isLocalBaseUrl(baseUrl)) return { ok: true }
  const pending = inflight.get(provider)
  if (pending) return { ...(await pending), started: true }
  if (await portOpen(baseUrl)) return { ok: true }
  const again = inflight.get(provider)
  if (again) return { ...(await again), started: true }
  const task = (async () => {
    options.onStarting?.(target.name)
    try {
      ;(options.run ?? launch)(command)
    } catch (error) {
      return { ok: false, error: pick(`本地模型「${target.name}」的启动命令没能运行：${error instanceof Error ? error.message : String(error)}`, `Could not run the start command for local model "${target.name}": ${error instanceof Error ? error.message : String(error)}`) }
    }
    const timeout = options.timeoutMs ?? LAUNCH_TIMEOUT_MS
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS))
      if (await localServing(baseUrl)) return { ok: true }
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

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout ?? '')))
  })
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

export function launcherFromProcess(info: { command?: string | null; parent?: string | null }): string | null {
  const parent = info.parent ?? ''
  const script = parent.match(/[A-Za-z]:\\[^"<>|*?\r\n]*?\.(?:bat|cmd|ps1)(?=["\s]|$)/i)?.[0]
  if (script) return script
  const command = info.command?.trim()
  return command ? command : null
}

function portOf(baseUrl: string): number {
  try {
    const url = new URL(baseUrl)
    return Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  } catch {
    return 0
  }
}

export async function detectLocalLauncher(provider: string): Promise<LocalLauncherDetectResult> {
  if (process.platform !== 'win32') return { ok: false, message: pick('目前只支持在 Windows 上自动识别', 'Auto-detection currently works on Windows only') }
  const target = (await listLocalLaunchers()).find((item) => item.provider === provider)
  if (!target) return { ok: false, message: pick(`「${provider}」不是本地模型服务`, `"${provider}" is not a local model service`) }
  const port = portOf(target.baseUrl)
  const pid = port ? listeningPid(await run('netstat.exe', ['-ano', '-p', 'TCP']), port) : null
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
