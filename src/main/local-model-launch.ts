import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { connect } from 'node:net'
import { basename, dirname, extname } from 'node:path'
import { pick } from '../shared/ui-lang'
import { COMMANDCODE_PROXY_PROVIDER } from '../shared/plugin-catalog'
import { isLocalBaseUrl, isLoopbackBaseUrl } from '../shared/model-capabilities'
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
import {
  addProviderModel,
  fetchProviderModels,
  modelProbeHeaders,
  modelsEndpoint,
  MODELS_FILE,
  providerEntry,
  readConfigText,
  removeProviderModel,
  renameProviderModel,
  serializeModels
} from './custom-providers'
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
  return localProvidersOf(models).filter((item) => item.provider !== COMMANDCODE_PROXY_PROVIDER).map((item) => {
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
  const result = await renameProviderModel(provider, modelId, name, async (models) => {
    requireLocalProvider(models, provider)
    return undefined
  })
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

function requireLocalProvider(models: unknown, provider: string): LocalProvider {
  const item = localProvidersOf(models).find((entry) => entry.provider === provider)
  if (!item) throw new Error(pick(`「${provider}」不是本地模型服务`, `"${provider}" is not a local model service`))
  return item
}

async function prepareLauncherChange(change: (config: Json) => Json | null): Promise<(() => Promise<void>) | undefined> {
  const previous = await readConfigText(LOCAL_MODELS_CONFIG)
  const config = previous === null ? {} : JSON.parse(previous)
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(pick('local-models.json 格式无效，未保存修改', 'Invalid local-models.json format; no changes saved'))
  }
  const next = change(config as Json)
  if (!next) return undefined
  return async () => {
    if (await readConfigText(LOCAL_MODELS_CONFIG) !== previous) {
      throw new Error(pick('local-models.json 已被其他程序修改，请重试', 'local-models.json was changed by another program; retry'))
    }
    await atomicWriteFile(LOCAL_MODELS_CONFIG, `${JSON.stringify(next, null, 2)}\n`)
  }
}

function updatedLauncher(item: LocalProvider, config: Json, input: LocalLauncherInput): { config: Json; warning?: string } {
  const { provider } = item
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
  return { config: { ...config, launchers }, warning }
}

export async function saveLocalLauncher(provider: string, input: LocalLauncherInput): Promise<LocalLauncherSaveResult> {
  return serializeModels(async () => {
    const item = requireLocalProvider(await readJson(MODELS_FILE), provider)
    let warning: string | undefined
    const apply = await prepareLauncherChange((config) => {
      const updated = updatedLauncher(item, config, input)
      warning = updated.warning
      return updated.config
    })
    await apply?.()
    return { launchers: await listLocalLaunchers(), ...(warning ? { warning } : {}) }
  })
}

export async function addLocalModel(provider: string, input: LocalModelInput): Promise<LocalLauncherSaveResult> {
  const command = String(input.command ?? '').trim()
  const modelId = String(input.id ?? '').trim()
  let warning: string | undefined
  const added = await addProviderModel(provider, input, async (models) => {
    const item = requireLocalProvider(models, provider)
    if (!command) return undefined
    return prepareLauncherChange((config) => {
      const updated = updatedLauncher({ ...item, models: [...item.models, { id: modelId }] }, config, { modelId, modelCommand: command })
      warning = updated.warning
      return updated.config
    })
  })
  if (!added.ok) throw new Error(added.error)
  return { launchers: await listLocalLaunchers(), ...(warning ? { warning } : {}) }
}

export async function removeLocalModel(provider: string, modelId: string): Promise<LocalLauncherView[]> {
  const removed = await removeProviderModel(provider, modelId, async (models) => {
    requireLocalProvider(models, provider)
    return prepareLauncherChange((config) => {
      const existing = launcherMap(config)[provider]
      if (!existing || !Object.hasOwn(existing.models, modelId)) return null
      const nextModels = { ...existing.models }
      delete nextModels[modelId]
      const launchers = { ...config.launchers as Json }
      const serialized = serializeLauncher({ ...existing, models: nextModels })
      if (serialized) launchers[provider] = serialized
      else delete launchers[provider]
      return { ...config, launchers }
    })
  })
  if (!removed.ok) throw new Error(removed.error)
  return listLocalLaunchers()
}

type Probe = { state: 'listed' | 'unknown' | 'down'; models: DiscoveredModel[] }

function refused(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(refused)
  return error instanceof Error && ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ||
    (error.cause !== undefined && refused(error.cause)))
}

export async function localServingModels(baseUrl: string, headers = new Headers(), signal?: AbortSignal): Promise<Probe> {
  const primary = modelsEndpoint(baseUrl)
  const urls = /\/v\d+\/models$/.test(new URL(primary).pathname) ? [primary] : [primary, modelsEndpoint(baseUrl, 'v1/models')]
  let unknown = false
  for (const url of urls) {
    if (signal?.aborted) return { state: 'unknown', models: [] }
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
    try {
      const response = await fetchProviderModels(url, headers, signal ? AbortSignal.any([signal, timeout]) : timeout)
      unknown = true
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel()
        return { state: 'unknown', models: [] }
      }
      if (!response.ok || /text\/html/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel()
        continue
      }
      const models = parseModelEntries(await response.json().catch(() => null))
      if (models.length) return { state: 'listed', models }
    } catch (error) {
      if (!refused(error)) unknown = true
    }
  }
  return { state: unknown ? 'unknown' : 'down', models: [] }
}

function servesModel(probe: Probe, modelId: string): 'match' | 'other' | 'unknown' | 'down' {
  if (probe.state !== 'listed') return probe.state
  return probe.models.some((model) => model.id === modelId) ? 'match' : 'other'
}

function hostPort(baseUrl: string): { host: string; port: number } | null {
  if (!isLocalBaseUrl(baseUrl)) return null
  const url = new URL(baseUrl)
  const host = url.hostname.replace(/^\[|\]$|\.$/g, '')
  return { host: host === '0.0.0.0' ? '127.0.0.1' : host, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) }
}

function endpointKey(baseUrl: string): string {
  const target = hostPort(baseUrl)!
  const host = target.host === 'localhost' || target.host === '127.0.0.1' || target.host === '::1' ? 'loopback' : target.host
  return `${host}:${target.port}`
}

type PortState = 'open' | 'closed' | 'unknown'

function portState(baseUrl: string): Promise<PortState> {
  const target = hostPort(baseUrl)
  if (!target) return Promise.resolve('unknown')
  return new Promise((resolve) => {
    const socket = connect(target)
    const done = (state: PortState): void => {
      socket.destroy()
      resolve(state)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done('unknown'))
    socket.once('connect', () => done('open'))
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'))
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

function targetEnv(target: Target): NodeJS.ProcessEnv {
  return { ...childEnv(), YAN_LOCAL_MODEL_BASE_URL: target.baseUrl, YAN_LOCAL_MODEL_ID: target.modelId ?? '', YAN_LOCAL_MODEL_PROVIDER: target.provider }
}

function launch(command: string, target: Target): ChildProcess {
  const { line, cwd } = launchLine(command)
  const child = spawn(line, { shell: true, detached: true, stdio: 'ignore', windowsHide: false, env: targetEnv(target), ...(cwd ? { cwd } : {}) })
  child.on('error', (error) => console.error('[local-model] start command failed', error))
  child.unref()
  return child
}

function runToEnd(command: string, timeoutMs: number, target: Target): Promise<number | null> {
  const { line, cwd } = launchLine(command)
  return new Promise((resolve) => {
    const child = spawn(line, { shell: true, stdio: 'ignore', windowsHide: true, env: targetEnv(target), ...(cwd ? { cwd } : {}) })
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

function killTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

interface Target {
  provider: string
  name: string
  displayName: string
  baseUrl: string
  modelId?: string
  command: string
  launcher?: LauncherConfig
  headers: Headers
}

interface ModelConfig {
  models: Json
  providers: LocalProvider[]
  launchers: Record<string, LauncherConfig>
}

async function modelConfig(): Promise<ModelConfig> {
  return serializeModels(async () => {
    const models = await readJson(MODELS_FILE)
    const providers = localProvidersOf(models)
    const launchers = providers.length ? launcherMap(await readJson(LOCAL_MODELS_CONFIG).catch(() => ({}))) : {}
    return { models, providers, launchers }
  })
}

function modelBaseUrl(item: LocalProvider, modelId: string): string {
  return item.models.find((model) => model.id === modelId)?.baseUrl ?? item.baseUrl
}

function targetOf(config: ModelConfig, provider: string, modelId?: string): Target | null {
  const item = config.providers.find((entry) => entry.provider === provider)
  if (!item) return null
  const model = modelId === undefined ? undefined : item.models.find((entry) => entry.id === modelId)
  if (modelId !== undefined && !model) return null
  const baseUrl = model?.baseUrl ?? (model ? item.baseUrl : providerBaseUrl(item))
  if (!isLocalBaseUrl(baseUrl)) return null
  const launcher = config.launchers[provider]
  return {
    provider, name: item.name, baseUrl, modelId, launcher,
    displayName: model?.name || (item.models.length > 1 && modelId ? modelId : item.name),
    command: commandFor(launcher, modelId),
    headers: modelProbeHeaders(baseUrl, providerEntry(config.models, provider), modelId)
  }
}

function targetsOf(config: ModelConfig): Target[] {
  return config.providers.flatMap((item) => item.models.flatMap((model) => targetOf(config, item.provider, model.id) ?? []))
}

export interface LocalModelEndpoint {
  endpointKey: string
  baseUrl: string
  matchesModel: (provider: string, modelId?: string) => boolean
}

type BusyChecker = (endpoint: LocalModelEndpoint) => boolean
let busyChecker: BusyChecker | null = null
const endpointTasks = new Map<string, Promise<unknown>>()
const launched = new Map<string, { target: Target; child: ChildProcess }>()
const lastReady = new Map<string, Target>()
const lastUsed = new Map<string, number>()

export function setLocalModelBusyChecker(checker: BusyChecker | null): void {
  busyChecker = checker
}

function atEndpoint<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (endpointTasks.get(key) ?? Promise.resolve()).then(work)
  const tail = next.catch(() => undefined)
  endpointTasks.set(key, tail)
  return next.finally(() => {
    if (endpointTasks.get(key) === tail) endpointTasks.delete(key)
  })
}

function isBusy(target: Target, config: ModelConfig, extra?: BusyChecker): boolean {
  if (!busyChecker && !extra) return false
  const key = endpointKey(target.baseUrl)
  const matches = (url: string): boolean => isLocalBaseUrl(url) && endpointKey(url) === key
  const endpoint: LocalModelEndpoint = {
    endpointKey: key,
    baseUrl: target.baseUrl,
    matchesModel: (provider, modelId) => {
      const item = config.providers.find((entry) => entry.provider === provider)
      if (!item) return false
      if (modelId !== undefined) return matches(modelBaseUrl(item, modelId))
      return matches(item.baseUrl) || item.models.some((model) => matches(model.baseUrl ?? item.baseUrl))
    }
  }
  return busyChecker?.(endpoint) === true || extra?.(endpoint) === true
}

function sameSocket(left: Target, right: Target): boolean {
  const a = hostPort(left.baseUrl)!
  const b = hostPort(right.baseUrl)!
  return a.host === b.host && a.port === b.port
}

function readyTarget(key: string, target: Target): void {
  lastReady.set(key, target)
  lastUsed.set(key, Date.now())
}

function oldTargetOf(key: string, targets: Target[], target: Target, probe: Probe): Target | undefined {
  const candidates = targets.filter((entry) => sameSocket(entry, target) && probe.models.some((model) => model.id === entry.modelId))
  for (const recorded of [launched.get(key)?.target, lastReady.get(key)]) {
    if (!recorded) continue
    const known = candidates.find((entry) => entry.provider === recorded.provider && entry.modelId === recorded.modelId && sameSocket(entry, recorded))
    if (known) return known
  }
  if (candidates.length === 1) return candidates[0]
  const sameProvider = candidates.filter((entry) => entry.provider === target.provider)
  return sameProvider.length === 1 ? sameProvider[0] : undefined
}

type ReadyResult = { ok: boolean; error?: string; started?: boolean }

export interface UnloadOptions {
  stop?: (command: string, target: { baseUrl: string; modelId?: string; provider: string }) => Promise<unknown>
  kill?: (pid: number) => Promise<void>
  ownsListener?: (baseUrl: string, pid: number) => Promise<boolean>
  closeWaitMs?: number
  modelId?: string
}

export interface EnsureLocalModelOptions extends UnloadOptions {
  onStarting?: (name: string) => void
  onSwitching?: (name: string) => void
  onReady?: () => Promise<ReadyResult>
  busy?: BusyChecker
  timeoutMs?: number
  pollMs?: number
  mismatchLimit?: number
  run?: (command: string, target: { baseUrl: string; modelId?: string; provider: string }) => ChildProcess | void | Promise<ChildProcess | void>
}

function activeChild(child: ChildProcess | undefined): child is ChildProcess & { pid: number } {
  return !!child?.pid && child.exitCode === null && child.signalCode === null && !child.killed
}

async function terminateChild(child: ChildProcess | undefined, target: Target, options: UnloadOptions): Promise<void> {
  if (!activeChild(child)) return
  if (options.kill) await options.kill(child.pid)
  else if (process.platform === 'win32' && isLoopbackBaseUrl(target.baseUrl)) await killTree(child.pid)
  else if (!child.kill() && activeChild(child)) throw new Error('Could not terminate the startup process')
}

async function startTarget(key: string, target: Target, options: EnsureLocalModelOptions): Promise<ReadyResult> {
  const timeout = options.timeoutMs ?? LAUNCH_TIMEOUT_MS
  const stopPolling = new AbortController()
  const signal = AbortSignal.any([stopPolling.signal, AbortSignal.timeout(timeout)])
  let child: ChildProcess | undefined
  let failure: string | undefined
  let ready = false
  const fail = (error: string): void => {
    failure = error
    stopPolling.abort()
  }
  const onError = (): void => fail(pick('启动命令未能运行', 'the start command could not run'))
  const onExit = (code: number | null, childSignal: NodeJS.Signals | null): void => {
    if (code === 0 && !childSignal) return
    fail(code === null ? pick('启动进程已终止', 'the startup process was terminated') : pick(`启动命令出错退出（代码 ${code}）`, `the start command exited with code ${code}`))
  }
  try {
    child = (options.run ? await options.run(target.command, target) : launch(target.command, target)) || undefined
    child?.on('error', onError)
    child?.once('exit', onExit)
    if (child && (child.exitCode !== null || child.signalCode !== null)) onExit(child.exitCode, child.signalCode)
    let mismatches = 0
    while (!signal.aborted) {
      await delay(options.pollMs ?? POLL_MS, undefined, { signal })
      const probe = await localServingModels(target.baseUrl, target.headers, signal)
      if (signal.aborted) break
      const state = servesModel(probe, target.modelId!)
      if (state === 'match') {
        ready = true
        readyTarget(key, target)
        if (activeChild(child) && isLoopbackBaseUrl(target.baseUrl)) {
          const managed = { target, child }
          launched.set(key, managed)
          child.once('exit', () => {
            if (launched.get(key) === managed) launched.delete(key)
          })
        }
        return { ok: true, started: true }
      }
      mismatches = state === 'other' ? mismatches + 1 : 0
      if (mismatches >= Math.max(1, options.mismatchLimit ?? MISMATCH_LIMIT)) {
        const running = probe.models.map((model) => model.id).join(', ')
        failure = pick(`服务返回「${running}」，不包含模型 ID「${target.modelId}」；请检查启动命令或模型 ID`, `the service reported "${running}", not model ID "${target.modelId}"; check the start command or model ID`)
        break
      }
    }
  } catch {
    if (!signal.aborted) onError()
  } finally {
    stopPolling.abort()
    child?.off('exit', onExit)
    if (!ready) {
      try {
        await terminateChild(child, target, options)
      } catch {
        failure = [failure, pick('未能清理本次启动的进程', 'could not clean up the process started by this request')].filter(Boolean).join('; ')
      }
    }
    child?.off('error', onError)
  }
  const reason = failure ?? pick(`${timeout / 1_000} 秒内未确认就绪`, `readiness was not confirmed within ${timeout / 1_000}s`)
  return { ok: false, started: true, error: pick(`本地模型「${target.displayName}」启动失败：${reason}。消息未发送，草稿已保留。`, `Local model "${target.displayName}" failed to start: ${reason}. Message not sent, draft kept.`) }
}

export function listeningPid(netstat: string, host: string, port: number): number | null {
  const pids = new Set<number>()
  const localhost = host === 'localhost' || host.endsWith('.localhost')
  for (const line of netstat.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols[0]?.toUpperCase() !== 'TCP' || cols[3]?.toUpperCase() !== 'LISTENING') continue
    const binding = cols[1]
    if (!binding?.endsWith(`:${port}`)) continue
    const address = binding.slice(0, binding.lastIndexOf(':')).replace(/^\[|\]$/g, '')
    const matches = address === host || (localhost && ['127.0.0.1', '::1', '0.0.0.0', '::'].includes(address)) ||
      (host.includes(':') ? address === '::' : address === '0.0.0.0' || address === '::')
    if (!matches) continue
    const pid = Number(cols[4])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return pids.size === 1 ? [...pids][0]! : null
}

async function listenerPid(baseUrl: string): Promise<number | null> {
  const endpoint = hostPort(baseUrl)
  if (!endpoint || !isLoopbackBaseUrl(baseUrl) || process.platform !== 'win32') return null
  return listeningPid(await run('netstat.exe', ['-ano', '-p', 'TCP']), endpoint.host, endpoint.port)
}

async function ownsListener(baseUrl: string, root: number): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const pid = await listenerPid(baseUrl)
  if (pid === null) return false
  if (pid === root) return true
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; while ($p -and $p.ParentProcessId -gt 0) { $q = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId); if (!$q -or $q.CreationDate -gt $p.CreationDate -or $q.ProcessId -eq $p.ProcessId) { break }; if ($q.ProcessId -eq ${root}) { 'owned'; break }; $p = $q }`
  return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim() === 'owned' && await listenerPid(baseUrl) === pid
}

async function stopTarget(key: string, target: Target, config: ModelConfig, options: UnloadOptions, busy?: BusyChecker): Promise<boolean> {
  if (isBusy(target, config, busy)) return false
  const stopCommand = target.launcher?.stopCommand
  const managed = launched.get(key)
  if (stopCommand) {
    try {
      if (options.stop) await options.stop(stopCommand, target)
      else await runToEnd(stopCommand, STOP_TIMEOUT_MS, target)
    } catch {
      if (await portState(target.baseUrl) !== 'closed') return false
    }
  } else {
    const child = managed?.child
    if (!managed || !sameSocket(target, managed.target) || !isLoopbackBaseUrl(target.baseUrl) || !activeChild(child)) return false
    if (!await (options.ownsListener ?? ownsListener)(target.baseUrl, child.pid)) return false
    if (launched.get(key) !== managed || isBusy(target, config, busy)) return false
    try {
      await terminateChild(child, target, options)
    } catch {
      if (await portState(target.baseUrl) !== 'closed') return false
    }
  }
  if (!await waitForPortClosed(target, options)) return false
  if (managed && sameSocket(target, managed.target)) launched.delete(key)
  lastReady.delete(key)
  lastUsed.delete(key)
  return true
}

async function waitForPortClosed(target: Target, options: UnloadOptions): Promise<boolean> {
  const deadline = Date.now() + (options.closeWaitMs ?? PORT_CLOSE_WAIT_MS)
  while (await portState(target.baseUrl) !== 'closed') {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await delay(Math.min(200, remaining))
  }
  return true
}

async function probeTarget(target: Target): Promise<Probe> {
  return localServingModels(target.baseUrl, target.headers)
}

async function readyAtEndpoint(key: string, target: Target, config: ModelConfig, options: EnsureLocalModelOptions): Promise<ReadyResult> {
  const finish = async (ready: ReadyResult): Promise<ReadyResult> => ready.ok && options.onReady ? { ...ready, ...await options.onReady() } : ready
  if (!target.launcher && !targetsOf(config).some((candidate) => candidate.command && endpointKey(candidate.baseUrl) === key)) {
    readyTarget(key, target)
    return finish({ ok: true })
  }
  const port = await portState(target.baseUrl)
  const probe = port === 'open' ? await probeTarget(target) : undefined
  const state = probe?.state === 'listed' ? servesModel(probe, target.modelId!) : port === 'closed' ? 'down' : 'unknown'
  if (state === 'match') {
    readyTarget(key, target)
    return finish({ ok: true })
  }
  if (port !== 'closed' && state !== 'other') {
    return { ok: false, error: pick('无法确认本地服务正在提供目标模型；请检查地址、模型列表和凭据。未启动或停止服务，消息未发送，草稿已保留。', 'Could not verify that the local service is serving the requested model. Check the address, model list and credentials. No service was started or stopped; message not sent, draft kept.') }
  }
  if (!target.command) {
    return { ok: false, error: pick('目标本地模型未就绪，且没有配置启动命令。请手动启动或配置命令后重试，草稿已保留。', 'The requested local model is not ready and has no start command. Start it manually or configure a command and retry; draft kept.') }
  }
  if (isBusy(target, config, options.busy)) {
    return { ok: false, error: pick(`本地服务「${target.name}」正在生成，不能切换到「${target.displayName}」，消息未发送，草稿已保留。`, `Local service "${target.name}" is busy; cannot switch to "${target.displayName}". Message not sent, draft kept.`) }
  }
  let previous: Target | undefined
  if (state === 'other' && probe) {
    previous = oldTargetOf(key, targetsOf(config), target, probe)
    const onSwitch = options.onSwitching ?? options.onStarting
    onSwitch?.(target.displayName)
    if (!await stopTarget(key, previous ?? target, config, options, options.busy)) {
      return { ok: false, error: pick('不能安全停止当前本地服务。请等待其他会话完成、配置正确的停止命令或手动关闭；消息未发送，草稿已保留。', 'Could not safely stop the current local service. Wait for other sessions to finish, configure the correct stop command or close it manually; message not sent, draft kept.') }
    }
  } else {
    options.onStarting?.(target.displayName)
  }
  const result = await startTarget(key, target, options)
  if (result.ok) return finish(result)
  if (state !== 'other') return result
  if (previous?.command && await waitForPortClosed(previous, options) && !isBusy(previous, config, options.busy)) {
    const restored = await startTarget(key, previous, options)
    if (restored.ok) return { ...result, error: `${result.error} ${pick('旧服务已恢复。', 'The previous service was restored.')}` }
  }
  return { ...result, error: `${result.error} ${pick('切换时已停止旧服务，未能确认恢复，请手动启动旧模型。', 'The previous service was stopped during the switch and its recovery could not be confirmed; restart it manually.')}` }
}

async function coordinateTarget<T>(provider: string, modelId: string | undefined, absent: () => T | Promise<T>, work: (key: string, target: Target, config: ModelConfig) => Promise<T>): Promise<T> {
  let config = await modelConfig()
  while (true) {
    const target = targetOf(config, provider, modelId)
    if (!target) return absent()
    const key = endpointKey(target.baseUrl)
    const result = await atEndpoint(key, async () => {
      config = await modelConfig()
      const current = targetOf(config, provider, modelId)
      if (!current) return { value: await absent() }
      if (endpointKey(current.baseUrl) !== key) return null
      return { value: await work(key, current, config) }
    })
    if (result) return result.value
  }
}

export function ensureLocalModelReady(provider: string, modelId: string, options: EnsureLocalModelOptions = {}): Promise<ReadyResult> {
  return coordinateTarget(provider, modelId, () => options.onReady?.() ?? { ok: true },
    (key, target, config) => readyAtEndpoint(key, target, config, options))
}

export function unloadLocalModel(provider: string, options: UnloadOptions = {}): Promise<boolean> {
  return coordinateTarget(provider, options.modelId, () => false, async (key, target, config) => {
    const port = await portState(target.baseUrl)
    if (port === 'closed') return true
    if (port !== 'open') return false
    const probe = await probeTarget(target)
    if (probe.state !== 'listed') return false
    const current = oldTargetOf(key, targetsOf(config), target, probe)
    if (options.modelId && current?.modelId !== options.modelId) return false
    return stopTarget(key, current ?? target, config, options)
  })
}

export interface IdleUnloadOptions extends UnloadOptions {
  busy: BusyChecker
  onUnloaded?: (name: string, provider: string) => void
  now?: () => number
  idleMs?: number
}

export async function scanIdleLocalModels(options: IdleUnloadOptions): Promise<string[]> {
  const config = await modelConfig()
  const keys = new Set(targetsOf(config).filter((target) => target.command && target.launcher?.idleUnload).map((target) => endpointKey(target.baseUrl)))
  const unloaded: string[] = []
  for (const key of keys) {
    if (endpointTasks.has(key)) continue
    await atEndpoint(key, async () => {
      const latest = await modelConfig()
      const targets = targetsOf(latest).filter((target) => endpointKey(target.baseUrl) === key)
      const tracked = launched.get(key)?.target ?? lastReady.get(key)
      const candidate = (tracked && targets.find((target) => target.provider === tracked.provider && target.modelId === tracked.modelId && sameSocket(target, tracked))) ??
        targets.find((target) => target.command && target.launcher?.idleUnload)
      if (!candidate?.command || !candidate.launcher?.idleUnload) return
      const now = (options.now ?? Date.now)()
      const last = lastUsed.get(key)
      if (last === undefined || isBusy(candidate, latest, options.busy)) {
        lastUsed.set(key, now)
        return
      }
      if (now - last < (options.idleMs ?? LOCAL_IDLE_UNLOAD_MS)) return
      lastUsed.set(key, now)
      const port = await portState(candidate.baseUrl)
      if (port === 'closed') {
        lastUsed.delete(key)
        return
      }
      if (port !== 'open') return
      const current = oldTargetOf(key, targets, candidate, await probeTarget(candidate))
      if (!current?.command || !current.launcher?.idleUnload) return
      if (await stopTarget(key, current, latest, options, options.busy)) {
        unloaded.push(current.provider)
        options.onUnloaded?.(current.name, current.provider)
      }
    })
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

export function detectLocalLauncher(provider: string, modelId?: string): Promise<LocalLauncherDetectResult> {
  return coordinateTarget(provider, modelId,
    () => ({ ok: false, message: pick(`「${provider}」的目标不是本地模型服务`, `The target for "${provider}" is not a local model service`) }),
    (_key, target) => detectTarget(target))
}

async function detectTarget(target: Target): Promise<LocalLauncherDetectResult> {
  const probe = await probeTarget(target)
  const models = probe.models.length ? probe.models : undefined
  if (process.platform !== 'win32') return { ok: false, ...(models ? { models } : {}), message: pick('目前只支持在 Windows 上自动识别', 'Auto-detection currently works on Windows only') }
  const port = hostPort(target.baseUrl)?.port ?? 0
  if (!isLoopbackBaseUrl(target.baseUrl)) return { ok: false, ...(models ? { models } : {}), message: pick('只能识别本机环回地址的启动程序', 'Only loopback services can have their launcher detected') }
  const pid = await listenerPid(target.baseUrl)
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
