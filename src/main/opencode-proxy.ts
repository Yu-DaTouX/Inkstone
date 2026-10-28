import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, join } from 'node:path'
import { x as untar } from 'tar'
import { listCustomProviders, removeCustomProvider, saveCustomProvider } from './custom-providers'
import { ZipReader } from './office/zip'
import { YAN_DIR } from './paths'
import {
  OPENCODE_PROXY_PROVIDER,
  OPENCODE_PROXY_REPO,
  type OpenCodeProxyResult,
  type OpenCodeProxyStatus
} from '../shared/opencode-proxy'

const ROOT = join(YAN_DIR, 'plugins', 'opencode2api')
const STATE_FILE = join(YAN_DIR, 'opencode-proxy.json')
const DOWNLOAD_LIMIT = 64 * 1024 * 1024
const LOG_LIMIT = 200
const FIRST_PORT = 18085
const READY_ATTEMPTS = 60
const READY_INTERVAL_MS = 500

const KEEP_FILES = new Set(['license', 'readme.md', 'readme.zh-cn.md'])

interface ProxyState {
  version: string
  port: number
  consolePort: number
  apiKey: string
  consolePassword: string
  autoStart: boolean
  installedAt: number
}

interface ProxyModel {
  id: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
}

interface ReleaseAsset {
  name: string
  url: string
}

interface Managed {
  child: ChildProcess
  log: string[]
}

let managed: Managed | null = null
let releaseCache: { at: number; tag: string; assets: ReleaseAsset[] } | null = null
let installing = false

function logLine(message: string): void {
  const text = message.trim()
  if (!text || !managed) return
  managed.log.push(text.length > 400 ? `${text.slice(0, 400)}…` : text)
  if (managed.log.length > LOG_LIMIT) managed.log.splice(0, managed.log.length - LOG_LIMIT)
}

function exeName(): string {
  return process.platform === 'win32' ? 'opencode2api.exe' : 'opencode2api'
}

function installDir(version: string): string {
  return join(ROOT, version)
}

function assetSuffix(): { suffix: string; ext: 'zip' | 'tar.gz' } | null {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null
  const os =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null
  if (!arch || !os) return null
  return { suffix: `${os}_${arch}`, ext: os === 'windows' ? 'zip' : 'tar.gz' }
}

async function readState(): Promise<ProxyState | null> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf8')) as Partial<ProxyState>
    if (typeof raw.version !== 'string' || !raw.version.trim()) return null
    return {
      version: raw.version.trim(),
      port: Number.isFinite(raw.port) ? Number(raw.port) : 0,
      consolePort: Number.isFinite(raw.consolePort) ? Number(raw.consolePort) : 0,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
      consolePassword: typeof raw.consolePassword === 'string' ? raw.consolePassword : '',
      autoStart: raw.autoStart !== false,
      installedAt: Number.isFinite(raw.installedAt) ? Number(raw.installedAt) : 0
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`反代状态文件损坏，请卸载后重装：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeState(next: ProxyState): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  const temp = `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, STATE_FILE)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function pickPort(start: number, taken: number[] = []): Promise<number> {
  for (let port = start; port < start + 200; port += 1) {
    if (taken.includes(port)) continue
    if (await portFree(port)) return port
  }
  throw new Error(`${start} 起连续 200 个端口都被占用`)
}

async function release(tag?: string): Promise<{ tag: string; assets: ReleaseAsset[] }> {
  if (!tag && releaseCache && Date.now() - releaseCache.at < 600_000) {
    return { tag: releaseCache.tag, assets: releaseCache.assets }
  }
  const url = tag
    ? `https://api.github.com/repos/${OPENCODE_PROXY_REPO}/releases/tags/${tag}`
    : `https://api.github.com/repos/${OPENCODE_PROXY_REPO}/releases/latest`
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'inkstone' },
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`读取发布信息失败（HTTP ${response.status}）`)
  const json = (await response.json()) as { tag_name?: unknown; assets?: unknown }
  const name = typeof json.tag_name === 'string' ? json.tag_name.trim() : ''
  const assets = (Array.isArray(json.assets) ? json.assets : [])
    .map((raw) => {
      const item = raw as { name?: unknown; browser_download_url?: unknown }
      return typeof item.name === 'string' && typeof item.browser_download_url === 'string'
        ? { name: item.name, url: item.browser_download_url }
        : null
    })
    .filter((asset): asset is ReleaseAsset => !!asset)
  if (!name || !assets.length) throw new Error('发布信息里没有可下载的文件')
  if (!tag) releaseCache = { at: Date.now(), tag: name, assets }
  return { tag: name, assets }
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > DOWNLOAD_LIMIT) throw new Error('下载文件超出大小上限')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > DOWNLOAD_LIMIT) throw new Error('下载文件超出大小上限')
  return buffer
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function verifyChecksum(archive: Buffer, asset: ReleaseAsset, assets: ReleaseAsset[]): Promise<void> {
  const meta = assets.find((item) => item.name === `${asset.name}.sha256`)
  if (!meta) throw new Error('发布信息里没有校验文件，已中止安装')
  const expected = (await fetchBuffer(meta.url)).toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const actual = sha256(archive)
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('校验文件格式不正确，已中止安装')
  if (expected !== actual) throw new Error(`SHA-256 校验不一致（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
}

async function extractZip(archive: Buffer, dest: string): Promise<void> {
  const reader = new ZipReader(archive)
  const wanted = [exeName().toLowerCase()]
  for (const name of reader.names()) {
    const file = basename(name)
    const lower = file.toLowerCase()
    if (!wanted.includes(lower) && !KEEP_FILES.has(lower)) continue
    const data = reader.read(name)
    if (data) await writeFile(join(dest, file), data)
  }
}

async function extractTarGz(archive: Buffer, dest: string): Promise<void> {
  const temp = join(YAN_DIR, `opencode2api-${randomUUID()}.tar.gz`)
  try {
    await writeFile(temp, archive)
    await untar({
      file: temp,
      cwd: dest,
      filter: (path) => {
        const lower = basename(path).toLowerCase()
        return lower === exeName().toLowerCase() || KEEP_FILES.has(lower)
      }
    })
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

function configText(state: ProxyState): string {
  return `${JSON.stringify(
    {
      listen: `127.0.0.1:${state.port}`,
      server_keys: [state.apiKey],
      zen_keys: [],
      go_keys: [],
      anonymous: true,
      proxies: ['direct'],
      proxyfile: '',
      upstream: {
        zen: 'https://opencode.ai/zen',
        go: 'https://opencode.ai/zen/go',
        anonymous: 'https://opencode.ai/inference'
      },
      retry: { max_attempts: 3, timeout_seconds: 300 },
      models: { refresh_seconds: 300, protocols: {}, free_only: true },
      performance: {
        max_idle_conns: 2048,
        max_idle_conns_per_host: 256,
        max_conns_per_host: 0,
        idle_conn_timeout_seconds: 120,
        connect_timeout_seconds: 5,
        failure_cooldown_seconds: 15,
        attempt_timeout_seconds: 0,
        first_event_timeout_seconds: 0
      },
      logging: { level: 'info', ring_size: 2000, dump_request_bodies: false },
      webui: {
        enabled: true,
        listen: `127.0.0.1:${state.consolePort}`,
        username: 'admin',
        password: state.consolePassword,
        session_ttl_minutes: 720
      },
      prefer: 'zen',
      reasoning: { effort: 'high' }
    },
    null,
    2
  )}\n`
}

function configPath(state: ProxyState): string {
  return join(installDir(state.version), 'config.json')
}

function modelDisplayName(id: string): string {
  const base = id.replace(/-free$/, '')
  const known: Record<string, string> = { deepseek: 'DeepSeek', glm: 'GLM', mimo: 'MiMo', longcat: 'LongCat', nemotron: 'Nemotron' }
  return base
    .split('-')
    .map((word) => known[word] ?? (/^[a-z]/.test(word) ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

function parseModels(json: unknown): ProxyModel[] | null {
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return null
  const out: ProxyModel[] = []
  for (const raw of data) {
    const item = (raw ?? {}) as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id) continue
    const meta = (item.metadata ?? {}) as Record<string, unknown>
    const compat = (item.compat ?? {}) as Record<string, unknown>
    const model: ProxyModel = { id }
    const context = positive(item.context_window) ?? positive(item.context_length) ?? positive(meta.context_window)
    const max = positive(item.max_output) ?? positive(item.max_output_tokens) ?? positive(meta.max_output)
    if (context) model.contextWindow = context
    if (max) model.maxTokens = max
    if (compat.supportsReasoningEffort === true || meta.reasoning === true) model.reasoning = true
    out.push(model)
  }
  return out
}

async function probe(baseUrl: string, apiKey: string, timeout = 2_000): Promise<ProxyModel[] | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeout)
    })
    if (!response.ok) return null
    return parseModels(await response.json())
  } catch {
    return null
  }
}

function apiBase(state: ProxyState): string {
  return `http://127.0.0.1:${state.port}/v1`
}

function consoleBase(state: ProxyState): string {
  return `http://127.0.0.1:${state.consolePort}`
}

function alive(child: ChildProcess | undefined): boolean {
  return !!child && child.exitCode === null && child.signalCode === null
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch {
      child.kill()
      return
    }
  }
  const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  const fallback = setTimeout(() => child.kill(), 5_000)
  fallback.unref?.()
  killer.once('exit', () => clearTimeout(fallback))
  killer.once('error', () => child.kill())
}

function detach(): void {
  if (!managed) return
  const current = managed
  managed = null
  killTree(current.child)
}

async function runningModels(state: ProxyState): Promise<{ running: boolean; managed: boolean; models: ProxyModel[] }> {
  const own = managed
  const models = await probe(apiBase(state), state.apiKey)
  if (models) return { running: true, managed: alive(own?.child), models }
  if (alive(own?.child)) return { running: true, managed: true, models: [] }
  return { running: false, managed: false, models: [] }
}

export async function openCodeProxyStatus(): Promise<OpenCodeProxyStatus> {
  const state = await readState()
  const installed = !!state && existsSync(configPath(state))
  const runtime = state && installed ? await runningModels(state) : { running: false, managed: false, models: [] as ProxyModel[] }
  const providerLinked = state
    ? (await listCustomProviders()).some((provider) => provider.id === OPENCODE_PROXY_PROVIDER)
    : false
  return {
    installed,
    version: state?.version ?? '',
    running: runtime.running,
    managed: runtime.managed,
    port: state?.port ?? 0,
    consolePort: state?.consolePort ?? 0,
    baseUrl: state ? apiBase(state) : '',
    consoleUrl: state ? consoleBase(state) : '',
    apiKey: state?.apiKey ?? '',
    consoleUser: 'admin',
    consolePassword: state?.consolePassword ?? '',
    models: runtime.models.map((model) => model.id),
    providerLinked,
    autoStart: state?.autoStart ?? true,
    installDir: state ? installDir(state.version) : ROOT,
    configPath: state ? configPath(state) : '',
    log: managed?.log.slice(-60) ?? []
  }
}

async function syncProvider(state: ProxyState, models: ProxyModel[]): Promise<string | null> {
  if (!models.length) return '反代没有返回可用的免费模型，稍后再刷新'
  const saved = await saveCustomProvider({
    id: OPENCODE_PROXY_PROVIDER,
    api: 'openai-completions',
    baseUrl: apiBase(state),
    apiKey: state.apiKey,
    confirmShrink: true,
    models: models.map((model) => ({
      id: model.id,
      name: modelDisplayName(model.id),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...(model.reasoning ? { reasoning: true } : {})
    }))
  })
  if (!saved.ok) return (saved.errors ?? ['写入模型配置失败']).join('；')
  return null
}

async function waitReady(state: ProxyState): Promise<ProxyModel[] | null> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    const models = await probe(apiBase(state), state.apiKey)
    if (models?.length) return models
    await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS))
  }
  return null
}

async function launch(state: ProxyState): Promise<ProxyModel[] | null> {
  if (alive(managed?.child) && managed) return await waitReady(state)
  const exe = join(installDir(state.version), exeName())
  if (!existsSync(exe)) throw new Error('可执行文件不存在，请重新安装')
  const child = spawn(exe, ['-config', configPath(state)], {
    cwd: installDir(state.version),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  managed = { child, log: [] }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => logLine(chunk))
  child.stderr?.on('data', (chunk: string) => logLine(chunk))
  child.on('exit', (code) => {
    logLine(`进程退出（code ${code ?? 'null'}）`)
    if (managed?.child === child) managed = null
  })
  return await waitReady(state)
}

async function startWith(state: ProxyState): Promise<OpenCodeProxyResult> {
  const models = await launch(state)
  if (!models) {
    const tail = managed?.log.slice(-6).join('\n') ?? ''
    detach()
    return { ok: false, error: '反代启动后没有响应', detail: tail || undefined, status: await openCodeProxyStatus() }
  }
  const syncError = await syncProvider(state, models)
  return {
    ok: !syncError,
    error: syncError ?? undefined,
    status: await openCodeProxyStatus()
  }
}

export async function startOpenCodeProxy(): Promise<OpenCodeProxyResult> {
  const state = await readState()
  if (!state || !existsSync(configPath(state))) return { ok: false, error: '还没有安装反代' }
  const runtime = await runningModels(state)
  if (runtime.running && runtime.managed) return { ok: true, status: await openCodeProxyStatus() }
  if (runtime.running) return { ok: true, status: await openCodeProxyStatus() }
  return await startWith(state)
}

export async function stopOpenCodeProxy(): Promise<OpenCodeProxyResult> {
  detach()
  return { ok: true, status: await openCodeProxyStatus() }
}

export function stopOpenCodeProxySync(): void {
  detach()
}

export async function refreshOpenCodeProxy(): Promise<OpenCodeProxyResult> {
  const state = await readState()
  if (!state || !existsSync(configPath(state))) return { ok: false, error: '还没有安装反代' }
  const runtime = await runningModels(state)
  if (!runtime.running) return { ok: false, error: '反代没有在运行', status: await openCodeProxyStatus() }
  const models = runtime.models.length ? runtime.models : ((await waitReady(state)) ?? [])
  if (!models.length) return { ok: false, error: '没有读取到模型列表', status: await openCodeProxyStatus() }
  const syncError = await syncProvider(state, models)
  return { ok: !syncError, error: syncError ?? undefined, status: await openCodeProxyStatus() }
}

export async function setOpenCodeProxyAutoStart(enabled: boolean): Promise<OpenCodeProxyResult> {
  const state = await readState()
  if (!state) return { ok: false, error: '还没有安装反代' }
  await writeState({ ...state, autoStart: enabled })
  return { ok: true, status: await openCodeProxyStatus() }
}

export async function installOpenCodeProxy(): Promise<OpenCodeProxyResult> {
  if (installing) return { ok: false, error: '正在安装，请稍候' }
  const target = assetSuffix()
  if (!target) return { ok: false, error: `不支持当前平台：${process.platform}/${process.arch}` }
  installing = true
  try {
    const previous = await readState()
    const { tag, assets } = await release()
    const assetName = `opencode2api_${tag}_${target.suffix}.${target.ext}`
    const asset = assets.find((item) => item.name === assetName)
    if (!asset) return { ok: false, error: `发布里没有匹配当前平台的文件：${assetName}` }
    const archive = await fetchBuffer(asset.url)
    await verifyChecksum(archive, asset, assets)

    const version = tag.replace(/^v/, '')
    const dest = installDir(version)
    await mkdir(dest, { recursive: true })
    if (target.ext === 'zip') await extractZip(archive, dest)
    else await extractTarGz(archive, dest)
    if (!existsSync(join(dest, exeName()))) return { ok: false, error: '解压后没有找到可执行文件' }

    if (previous && previous.version !== version) detach()
    const keepPort = previous?.port && (await portFree(previous.port)) ? previous.port : 0
    const port = keepPort || (await pickPort(FIRST_PORT))
    const keepConsole = previous?.consolePort && previous.consolePort !== port && (await portFree(previous.consolePort)) ? previous.consolePort : 0
    const consolePort = keepConsole || (await pickPort(port + 1, [port]))
    const state: ProxyState = {
      version,
      port,
      consolePort,
      apiKey: previous?.apiKey?.trim() || `yan-${randomBytes(24).toString('hex')}`,
      consolePassword: previous?.consolePassword || randomBytes(12).toString('base64url'),
      autoStart: previous?.autoStart !== false,
      installedAt: Date.now()
    }
    await writeFile(configPath(state), configText(state), 'utf8')
    await writeState(state)
    return await startWith(state)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    installing = false
  }
}

export async function uninstallOpenCodeProxy(): Promise<OpenCodeProxyResult> {
  detach()
  await removeCustomProvider(OPENCODE_PROXY_PROVIDER)
  await rm(ROOT, { recursive: true, force: true })
  await rm(STATE_FILE, { force: true })
  releaseCache = null
  return { ok: true, status: await openCodeProxyStatus() }
}

export async function autoStartOpenCodeProxy(): Promise<void> {
  const state = await readState()
  if (!state || !state.autoStart || !existsSync(configPath(state))) return
  const runtime = await runningModels(state)
  if (runtime.running) return
  await startWith(state)
}
