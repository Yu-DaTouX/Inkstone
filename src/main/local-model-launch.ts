import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { basename, dirname, extname } from 'node:path'
import { pick } from '../shared/ui-lang'
import { isLocalBaseUrl } from '../shared/model-capabilities'
import {
  parseModelEntries,
  type DiscoveredModel,
  type LocalLauncherDetectResult,
  type LocalLauncherInput,
  type LocalLauncherModelView,
  type LocalLauncherSaveResult,
  type LocalLauncherView,
  type LocalModelInput
} from '../shared/custom-provider'
import { atomicWriteFile } from './atomic-write'
import { addProviderModel, MODELS_FILE, removeProviderModel, renameProviderModel } from './custom-providers'
import { LOCAL_MODELS_CONFIG } from './local-models'

const PROBE_TIMEOUT_MS = 1_500
const POLL_MS = 1_000
const STOP_TIMEOUT_MS = 30_000
const PORT_CLOSE_WAIT_MS = 10_000
const LAUNCH_TIMEOUT_MS = 180_000
const MISMATCH_LIMIT = 3
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
  models: Record<string, { command: string }>
}

function modelLauncherMap(raw: unknown): Record<string, { command: string }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, { command: string }> = {}
  for (const [id, entry] of Object.entries(raw as Json)) {
    const value = (entry ?? {}) as { command?: unknown }
    if (typeof value.command === 'string' && value.command.trim()) {
      out[id] = { command: value.command.trim() }
    }
  }
  return out
}

function launcherMap(config: Json): Record<string, LauncherConfig> {
  const raw = config.launchers
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, LauncherConfig> = {}
  for (const [provider, entry] of Object.entries(raw as Json)) {
    const value = (entry ?? {}) as { command?: unknown; stopCommand?: unknown; idleUnload?: unknown; models?: unknown }
    const command = typeof value.command === 'string' ? value.command.trim() : ''
    const models = modelLauncherMap(value.models)
    if (!command && !Object.keys(models).length) continue
    out[provider] = {
      command,
      stopCommand: typeof value.stopCommand === 'string' ? value.stopCommand.trim() : '',
      idleUnload: value.idleUnload !== false,
      models
    }
  }
  return out
}

function hasAnyCommand(launcher: LauncherConfig | undefined): boolean {
  if (!launcher) return false
  return !!launcher.command || Object.keys(launcher.models).length > 0
}

function commandFor(launcher: LauncherConfig | undefined, modelId?: string): string {
  if (!launcher) return ''
  if (modelId && launcher.models[modelId]?.command) return launcher.models[modelId]!.command
  return launcher.command
}

interface LocalProviderModel {
  id: string
  name?: string
  baseUrl?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: Array<'text' | 'image'>
}

interface LocalProvider {
  provider: string
  name: string
  baseUrl: string
  models: LocalProviderModel[]
}

export function localProvidersOf(modelsJson: unknown): LocalProvider[] {
  const providers = (modelsJson as Json | null)?.providers
  if (!providers || typeof providers !== 'object') return []
  const out: LocalProvider[] = []
  for (const [provider, raw] of Object.entries(providers as Json)) {
    const entry = (raw ?? {}) as Json
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : ''
    const models: LocalProviderModel[] = (Array.isArray(entry.models) ? entry.models : [])
      .filter((m): m is Json => !!m && typeof m === 'object' && typeof (m as Json).id === 'string')
      .map((m) => {
        const input = Array.isArray(m.input)
          ? [...new Set(m.input.filter((kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image'))]
          : undefined
        return {
          id: m.id as string,
          ...(typeof m.name === 'string' && m.name.trim() ? { name: m.name.trim() } : {}),
          ...(typeof m.baseUrl === 'string' && m.baseUrl.trim() ? { baseUrl: m.baseUrl.trim() } : {}),
          ...(typeof m.contextWindow === 'number' && Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? { contextWindow: Math.round(m.contextWindow) } : {}),
          ...(typeof m.maxTokens === 'number' && Number.isFinite(m.maxTokens) && m.maxTokens > 0 ? { maxTokens: Math.round(m.maxTokens) } : {}),
          ...(m.reasoning === true ? { reasoning: true } : {}),
          ...(input?.length ? { input } : {})
        }
      })
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
  return localProvidersOf(models).map((item) => {
    const launcher = launchers[item.provider]
    const list: LocalLauncherModelView[] = item.models.map((m) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      command: launcher?.models[m.id]?.command ?? '',
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      ...(m.reasoning ? { reasoning: true } : {}),
      ...(m.input?.length ? { input: m.input } : {})
    }))
    return {
      provider: item.provider,
      name: item.name,
      baseUrl: providerBaseUrl(item),
      command: launcher?.command ?? '',
      stopCommand: launcher?.stopCommand ?? '',
      idleUnload: launcher?.idleUnload ?? true,
      models: list
    }
  })
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

function stopScriptWarning(command: string): string | undefined {
  if (!command || !looksLikeStopScript(command)) return undefined
  const name = basename(commandFile(command) ?? command)
  return pick(`启动命令「${name}」看起来是停止脚本；发消息时会运行它，请确认选的是启动脚本`, `The start command "${name}" looks like a stop script; it will run when you send a message, so make sure it is the start script`)
}

function serializeLauncher(entry: LauncherConfig): Json | null {
  const modelEntries = Object.entries(entry.models).filter(([, item]) => !!item.command)
  if (!entry.command && !modelEntries.length) return null
  const out: Json = {}
  if (entry.command) out.command = entry.command
  if (entry.stopCommand) out.stopCommand = entry.stopCommand
  if (entry.idleUnload === false) out.idleUnload = false
  if (modelEntries.length) out.models = Object.fromEntries(modelEntries.map(([id, item]) => [id, { command: item.command }]))
  return out
}

export async function saveLocalLauncher(provider: string, input: LocalLauncherInput): Promise<LocalLauncherSaveResult> {
  const item = localProvidersOf(await readJson(MODELS_FILE)).find((entry) => entry.provider === provider)
  if (!item) throw new Error(pick(`「${provider}」不是本地模型服务`, `"${provider}" is not a local model service`))

  const config = await readJson(LOCAL_MODELS_CONFIG)
  const existing = launcherMap(config)[provider] ?? { command: '', stopCommand: '', idleUnload: true, models: {} }
  const nextModels: Record<string, { command: string }> = { ...existing.models }
  let warning: string | undefined

  let command = existing.command
  let stopCommand = existing.stopCommand
  let idleUnload = existing.idleUnload

  if (typeof input.modelId === 'string' && input.modelId.trim()) {
    const modelId = input.modelId.trim()
    if (!item.models.some((m) => m.id === modelId)) {
      throw new Error(pick(`「${provider}」里没有模型 ${modelId}`, `Model "${modelId}" is not in "${provider}"`))
    }
    const modelCommand = String(input.modelCommand ?? input.command ?? '').trim()
    const missing = missingFileError(modelCommand, pick('启动命令', 'start command'))
    if (missing) throw new Error(missing)
    if (modelCommand) nextModels[modelId] = { command: modelCommand }
    else delete nextModels[modelId]
    warning = stopScriptWarning(modelCommand)
  } else {
    if (input.command !== undefined) command = String(input.command).trim()
    if (input.stopCommand !== undefined) stopCommand = String(input.stopCommand).trim()
    else if (input.command !== undefined) stopCommand = ''
    if (input.idleUnload !== undefined) idleUnload = input.idleUnload !== false
    const missing = missingFileError(command, pick('启动命令', 'start command')) ?? missingFileError(stopCommand, pick('停止命令', 'stop command'))
    if (missing) throw new Error(missing)
    warning = stopScriptWarning(command)
  }

  const launchers = { ...((config.launchers && typeof config.launchers === 'object' ? config.launchers : {}) as Json) }
  const serialized = serializeLauncher({ command, stopCommand, idleUnload, models: nextModels })
  if (serialized) launchers[provider] = serialized
  else delete launchers[provider]
  await mkdir(dirname(LOCAL_MODELS_CONFIG), { recursive: true })
  await atomicWriteFile(LOCAL_MODELS_CONFIG, `${JSON.stringify({ ...config, launchers }, null, 2)}\n`)
  return { launchers: await listLocalLaunchers(), ...(warning ? { warning } : {}) }
}

export async function addLocalModel(provider: string, input: LocalModelInput): Promise<LocalLauncherSaveResult> {
  const known = localProvidersOf(await readJson(MODELS_FILE)).some((item) => item.provider === provider)
  if (!known) throw new Error(pick(`「${provider}」不是本地模型服务`, `"${provider}" is not a local model service`))
  const command = String(input.command ?? '').trim()
  const missing = missingFileError(command, pick('启动命令', 'start command'))
  if (missing) throw new Error(missing)
  const added = await addProviderModel(provider, input)
  if (!added.ok) throw new Error(added.error)
  if (command) {
    return saveLocalLauncher(provider, { modelId: String(input.id).trim(), modelCommand: command })
  }
  return { launchers: await listLocalLaunchers() }
}

export async function removeLocalModel(provider: string, modelId: string): Promise<LocalLauncherView[]> {
  const known = localProvidersOf(await readJson(MODELS_FILE)).some((item) => item.provider === provider)
  if (!known) throw new Error(pick(`「${provider}」不是本地模型服务`, `"${provider}" is not a local model service`))
  const removed = await removeProviderModel(provider, modelId)
  if (!removed.ok) throw new Error(removed.error)
  const config = await readJson(LOCAL_MODELS_CONFIG)
  const existing = launcherMap(config)[provider]
  if (existing && modelId in existing.models) {
    const nextModels = { ...existing.models }
    delete nextModels[modelId]
    const launchers = { ...((config.launchers && typeof config.launchers === 'object' ? config.launchers : {}) as Json) }
    const serialized = serializeLauncher({ ...existing, models: nextModels })
    if (serialized) launchers[provider] = serialized
    else delete launchers[provider]
    await mkdir(dirname(LOCAL_MODELS_CONFIG), { recursive: true })
    await atomicWriteFile(LOCAL_MODELS_CONFIG, `${JSON.stringify({ ...config, launchers }, null, 2)}\n`)
  }
  return listLocalLaunchers()
}

function probeUrls(baseUrl: string): string[] {
  const root = baseUrl.replace(/\/+$/, '')
  return /\/v1$/.test(root) ? [`${root}/models`] : [`${root}/models`, `${root}/v1/models`]
}

export async function localServingModels(baseUrl: string): Promise<{ ok: boolean; models: DiscoveredModel[] }> {
  for (const url of probeUrls(baseUrl)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!response.ok) continue
      const body = await response.json().catch(() => null)
      return { ok: true, models: parseModelEntries(body) }
    } catch {
      continue
    }
  }
  return { ok: false, models: [] }
}

export async function localServing(baseUrl: string): Promise<boolean> {
  return (await localServingModels(baseUrl)).ok
}

function servesModel(probe: { ok: boolean; models: DiscoveredModel[] }, modelId: string): 'match' | 'other' | 'down' {
  if (!probe.ok) return 'down'
  if (!modelId || probe.models.length === 0) return 'match'
  return probe.models.some((m) => m.id === modelId) ? 'match' : 'other'
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

function endpointKey(baseUrl: string, fallback: string): string {
  const target = hostPort(baseUrl)
  return target ? `${target.host}:${target.port}` : fallback
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

const inflight = new Map<string, { modelId: string; promise: Promise<{ ok: boolean; error?: string }> }>()
const unloading = new Map<string, Promise<boolean>>()
const launched = new Map<string, ChildProcess>()
const lastUsed = new Map<string, number>()
let busyChecker: ((provider: string) => boolean) | null = null

export function setLocalModelBusyChecker(checker: ((provider: string) => boolean) | null): void {
  busyChecker = checker
}

interface Target {
  provider: string
  name: string
  displayName: string
  baseUrl: string
  command: string
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
  if (!hasAnyCommand(launcher)) return null
  const item = localProvidersOf(models).find((entry) => entry.provider === provider)
  if (!item) return null
  const model = modelId ? item.models.find((m) => m.id === modelId) : undefined
  const baseUrl = model?.baseUrl ?? providerBaseUrl(item)
  if (!isLocalBaseUrl(baseUrl)) return null
  const command = commandFor(launcher, modelId)
  const displayName = model?.name || (item.models.length > 1 && modelId ? modelId : item.name)
  return { provider, name: item.name, displayName, baseUrl, command, launcher: launcher! }
}

export interface EnsureLocalModelOptions {
  onStarting?: (name: string) => void
  onSwitching?: (name: string) => void
  timeoutMs?: number
  pollMs?: number
  mismatchLimit?: number
  busy?: (provider: string) => boolean
  unload?: (provider: string) => Promise<boolean>
  run?: (command: string) => ChildProcess | void
}

export async function ensureLocalModelReady(provider: string, modelId: string, options: EnsureLocalModelOptions = {}): Promise<{ ok: boolean; error?: string; started?: boolean }> {
  const target = await targetOf(provider, modelId)
  if (!target || !target.command) return { ok: true }
  const key = endpointKey(target.baseUrl, provider)
  lastUsed.set(provider, Date.now())
  await unloading.get(key)
  const pending = inflight.get(key)
  if (pending) {
    if (pending.modelId === modelId) return { ...(await pending.promise), started: true }
    await pending.promise
    await unloading.get(key)
  }
  let switching = false
  if (await portOpen(target.baseUrl)) {
    const probe = await localServingModels(target.baseUrl)
    const state = servesModel(probe, modelId)
    if (state !== 'other') return { ok: true }
    const busy = options.busy ?? busyChecker
    if (busy?.(provider)) {
      return { ok: false, error: pick(`本地服务「${target.name}」正在为其他会话生成，请等完成后再切换到「${target.displayName}」，消息未发送，草稿已保留。`, `Local service "${target.name}" is busy with another session; wait for it to finish before switching to "${target.displayName}". Message not sent, draft kept.`) }
    }
    switching = true
  }
  const again = inflight.get(key)
  if (again) {
    if (again.modelId === modelId) return { ...(await again.promise), started: true }
    await again.promise
  }
  const task = (async () => {
    if (switching) {
      if (options.onSwitching) options.onSwitching(target.displayName)
      else options.onStarting?.(target.displayName)
      const stopped = await (options.unload ? options.unload(provider) : unloadLocalModel(provider))
      if (!stopped && (await portOpen(target.baseUrl))) {
        return { ok: false, error: pick(`切换本地模型到「${target.displayName}」前未能停止当前运行的服务，消息未发送，草稿已保留。请检查停止命令或手动关闭后重试。`, `Could not stop the currently running local service before switching to "${target.displayName}"; message not sent, draft kept. Check the stop command or close it manually.`) }
      }
    } else {
      options.onStarting?.(target.displayName)
    }
    let exitCode: number | null | undefined
    try {
      const child = (options.run ?? launch)(target.command)
      if (child) {
        launched.set(key, child)
        child.once('exit', (code) => {
          exitCode = code
        })
      }
    } catch (error) {
      return { ok: false, error: pick(`本地模型「${target.displayName}」的启动命令没能运行：${error instanceof Error ? error.message : String(error)}`, `Could not run the start command for local model "${target.displayName}": ${error instanceof Error ? error.message : String(error)}`) }
    }
    const timeout = options.timeoutMs ?? LAUNCH_TIMEOUT_MS
    const deadline = Date.now() + timeout
    const maxMismatch = Math.max(1, options.mismatchLimit ?? MISMATCH_LIMIT)
    let mismatchCount = 0
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS))
      const probe = await localServingModels(target.baseUrl)
      const state = servesModel(probe, modelId)
      if (state === 'match') {
        lastUsed.set(provider, Date.now())
        return { ok: true }
      }
      if (state === 'other') {
        mismatchCount += 1
        if (mismatchCount >= maxMismatch) {
          const running = probe.models.map((m) => m.id).join('、')
          return { ok: false, error: pick(`本地模型「${target.displayName}」启动后，服务返回的是「${running}」，不包含「${modelId}」；消息未发送，草稿已保留。请在设置里检查该模型的启动命令或模型 ID。`, `After starting "${target.displayName}", the service reported "${probe.models.map((m) => m.id).join(', ')}" instead of "${modelId}"; message not sent, draft kept. Check its start command or model ID in Settings.`) }
        }
      } else {
        mismatchCount = 0
      }
      if (typeof exitCode === 'number' && exitCode !== 0) {
        return { ok: false, error: pick(`本地模型「${target.displayName}」的启动命令出错退出（代码 ${exitCode}），消息未发送，草稿已保留。请在设置里检查启动命令。`, `The start command for local model "${target.displayName}" exited with code ${exitCode}; message not sent, draft kept. Check the start command in Settings.`) }
      }
    }
    const seconds = Math.round(timeout / 1000)
    return { ok: false, error: pick(`本地模型「${target.displayName}」启动后 ${seconds} 秒内没有就绪，消息未发送，草稿已保留。请查看它的启动窗口。`, `Local model "${target.displayName}" was not ready within ${seconds}s of starting; message not sent, draft kept. Check its startup window.`) }
  })()
  inflight.set(key, { modelId, promise: task })
  try {
    return { ...(await task), started: true }
  } finally {
    if (inflight.get(key)?.promise === task) inflight.delete(key)
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
  const key = endpointKey(target.baseUrl, provider)
  const current = unloading.get(key)
  if (current) return current
  const task = (async () => {
    const kill = options.kill ?? killTree
    if (target.launcher.stopCommand) await (options.stop ?? ((command: string) => runToEnd(command, STOP_TIMEOUT_MS)))(target.launcher.stopCommand)
    else {
      const port = hostPort(target.baseUrl)?.port
      const pid = port ? await (options.listener ?? listenerPid)(port) : null
      if (pid) await kill(pid)
    }
    const child = launched.get(key)
    if (child?.pid && child.exitCode === null && child.signalCode === null) await kill(child.pid)
    launched.delete(key)
    const deadline = Date.now() + (options.closeWaitMs ?? PORT_CLOSE_WAIT_MS)
    while (await portOpen(target.baseUrl)) {
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    lastUsed.delete(provider)
    return true
  })()
  unloading.set(key, task)
  try {
    return await task
  } finally {
    if (unloading.get(key) === task) unloading.delete(key)
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
    const baseUrl = providerBaseUrl(item)
    const key = endpointKey(baseUrl, item.provider)
    if (!hasAnyCommand(launcher) || !launcher?.idleUnload || inflight.has(key) || unloading.has(key)) continue
    if (options.busy(item.provider)) {
      lastUsed.set(item.provider, now)
      continue
    }
    if (!(await portOpen(baseUrl))) {
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
  const target = (await listLocalLaunchers()).find((item) => item.provider === provider)
  if (!target) return { ok: false, message: pick(`「${provider}」不是本地模型服务`, `"${provider}" is not a local model service`) }
  const probe = await localServingModels(target.baseUrl)
  const models = probe.models.length ? probe.models : undefined
  if (process.platform !== 'win32') return { ok: false, ...(models ? { models } : {}), message: pick('目前只支持在 Windows 上自动识别', 'Auto-detection currently works on Windows only') }
  const port = hostPort(target.baseUrl)?.port ?? 0
  const pid = port ? await listenerPid(port) : null
  if (!pid) return { ok: false, ...(models ? { models } : {}), message: pick(`端口 ${port} 上没有正在运行的服务；先手动启动一次再识别`, `Nothing is listening on port ${port}; start it once manually, then detect`) }
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; $q = if ($p) { Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) }; [Console]::OutputEncoding = [Text.Encoding]::UTF8; @{ command = $p.CommandLine; parent = $q.CommandLine } | ConvertTo-Json -Compress`
  let info: { command?: string | null; parent?: string | null } = {}
  try {
    info = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])) as typeof info
  } catch {
    info = {}
  }
  const command = launcherFromProcess(info)
  if (!command) return { ok: false, ...(models ? { models } : {}), message: pick('没能读取启动它的程序', 'Could not read the program that started it') }
  return { ok: true, command, ...(models ? { models } : {}), message: pick('已按正在运行的服务填好启动命令，确认后保存', 'Filled in from the running service; review and save') }
}
