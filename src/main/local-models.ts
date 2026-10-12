/**
 * 本机（及用户手动添加的局域网）模型服务探测。
 *
 * 按接口特征识别，不按软件名：
 * - 对话：OpenAI 兼容的 `GET /v1/models`（Ollama、LM Studio、llama.cpp、vLLM、Jan、KoboldCpp、
 *   text-generation-webui、GPT4All、LocalAI 等）；
 * - 生图：ComfyUI 的 `GET /system_stats`，以及 SD WebUI 系（A1111、Forge、reForge、SD.Next 等）的
 *   `GET /sdapi/v1/sd-models`。
 * 各软件的常见默认端口都会试（同一端口两种特征都试，ComfyUI 桌面版与 vLLM 都默认 8000），
 * 用户在设置里添加的地址也会按三种特征探测。只发免费的只读请求，每个地址 1.5 秒超时。
 *
 * 服务没在运行时，按各平台常见安装位置找目录（ComfyUI 桌面版配置里的 basePath、便携包、
 * 手动克隆、Stability Matrix、Pinokio；SD WebUI 系；Ollama；LM Studio），界面上显示「已安装、未运行」；
 * 生图通道只认正在运行的服务。这里不写模型配置，对话服务交给设置页填表单、由用户确认保存。
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import type { LocalModelServer } from '../shared/custom-provider'
import { classifyWorkflow, isApiPrompt, type UiWorkflow, type WorkflowKind } from './comfy-workflow'
import { YAN_DIR } from './paths'

const PROBE_TIMEOUT_MS = 1_500
/** 生图通道每次请求都要知道本机服务在不在；短缓存免得每张图都探测一遍 */
const IMAGE_CACHE_MS = 30_000

/* ------------------------------------------------------------ 地址 */

/**
 * 环境变量或用户输入 → 服务根地址。常见写法如 `0.0.0.0`、`127.0.0.1:11434`、`http://box:8188/v1/`：
 * 补协议与默认端口，监听全部网卡的 0.0.0.0 换成本机回环，去掉末尾的 /v1。
 */
export function localServiceBase(raw: string | undefined, port: number): string {
  const value = raw?.trim()
  if (!value) return `http://127.0.0.1:${port}`
  try {
    const hasScheme = /^[a-z]+:\/\//i.test(value)
    const url = new URL(hasScheme ? value : `http://${value}`)
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = '127.0.0.1'
    if (!url.port && !hasScheme) url.port = String(port)
    return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  } catch {
    return `http://127.0.0.1:${port}`
  }
}

/** 用户在设置里添加的地址（局域网显卡主机、非默认端口等），存在砚的数据目录 */
const CONFIG_FILE = join(YAN_DIR, 'local-models.json')

export async function readLocalModelUrls(): Promise<string[]> {
  try {
    const json = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as { urls?: unknown }
    return Array.isArray(json.urls) ? json.urls.filter((url): url is string => typeof url === 'string' && !!url.trim()) : []
  } catch {
    return []
  }
}

/** 只收 http/https 的地址，统一成服务根地址后去重 */
export function normalizeLocalModelUrls(urls: unknown[]): string[] {
  const out: string[] = []
  for (const raw of urls) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const hasScheme = /^[a-z]+:\/\//i.test(raw.trim())
    if (hasScheme && !/^https?:\/\//i.test(raw.trim())) continue
    const base = localServiceBase(raw, 80)
    if (!out.includes(base)) out.push(base)
  }
  return out.slice(0, 16)
}

export async function saveLocalModelUrls(urls: unknown[]): Promise<string[]> {
  const clean = normalizeLocalModelUrls(urls)
  await mkdir(YAN_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, `${JSON.stringify({ urls: clean }, null, 2)}\n`, 'utf8')
  imageCache = null
  return clean
}

/* ------------------------------------------------------------ 对话服务 */

interface ChatTarget {
  kind: 'ollama' | 'lmstudio' | 'openai'
  name: string
  port: number
  env?: string
  suggestedId: string
}

/** 各软件的默认端口；端口上真正跑的是什么以接口响应为准 */
const CHAT_TARGETS: ChatTarget[] = [
  { kind: 'ollama', name: 'Ollama', port: 11434, env: 'OLLAMA_HOST', suggestedId: 'yan-ollama' },
  { kind: 'lmstudio', name: 'LM Studio', port: 1234, env: 'YAN_LMSTUDIO_URL', suggestedId: 'yan-lmstudio' },
  { kind: 'openai', name: 'llama.cpp / LocalAI', port: 8080, suggestedId: 'yan-llamacpp' },
  { kind: 'openai', name: 'vLLM', port: 8000, suggestedId: 'yan-vllm' },
  { kind: 'openai', name: 'Jan', port: 1337, suggestedId: 'yan-jan' },
  { kind: 'openai', name: 'KoboldCpp', port: 5001, suggestedId: 'yan-koboldcpp' },
  { kind: 'openai', name: 'text-generation-webui', port: 5000, suggestedId: 'yan-textgen' },
  { kind: 'openai', name: 'GPT4All', port: 4891, suggestedId: 'yan-gpt4all' }
]

/** OpenAI 兼容的 `{ data: [{ id }] }`；嵌入、重排模型不能对话，去掉 */
function openAiModels(json: unknown): string[] | null {
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return null
  return data
    .map((item) => (item as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string' && !!id.trim() && !/embed|rerank/i.test(id))
}

async function getJson(url: string): Promise<unknown | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!response.ok) return undefined
    return await response.json().catch(() => undefined)
  } catch {
    return undefined
  }
}

function portOf(root: string): number {
  try {
    const url = new URL(root)
    return Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  } catch {
    return 0
  }
}

async function probeChat(root: string, target?: ChatTarget): Promise<LocalModelServer | null> {
  const models = openAiModels(await getJson(`${root}/v1/models`))
  if (!models?.length) return null
  /* Ollama 的端口可能被改过：有 /api/version 就认作 Ollama */
  const ollama = target?.kind === 'ollama' || (!target && !!(await getJson(`${root}/api/version`)))
  const port = portOf(root)
  return {
    kind: ollama ? 'ollama' : target?.kind ?? 'openai',
    purpose: 'chat',
    name: ollama ? 'Ollama' : target?.name ?? 'OpenAI 兼容服务',
    baseUrl: `${root}/v1`,
    models,
    suggestedId: ollama ? 'yan-ollama' : target?.suggestedId ?? `yan-local-${port}`,
    running: true
  }
}

/* ------------------------------------------------------------ 生图服务 */

const COMFY_PORTS = [8188, 8000, 8189]
const SDAPI_PORTS = [7860, 7861]

async function probeSdApi(root: string): Promise<LocalModelServer | null> {
  const json = await getJson(`${root}/sdapi/v1/sd-models`)
  if (!Array.isArray(json)) return null
  const models = json.map((item) => (item as { title?: unknown } | null)?.title).filter((title): title is string => typeof title === 'string' && !!title)
  return { kind: 'sdwebui', purpose: 'image', name: 'Stable Diffusion WebUI', baseUrl: root, models, running: true }
}

export interface ComfyWorkflowEntry {
  /** 相对 workflows 目录的路径，也是 /api/userdata 的文件名 */
  name: string
  kind: WorkflowKind
}

/** 文生图在前，同类按名称排序 */
export function sortWorkflows(entries: ComfyWorkflowEntry[]): ComfyWorkflowEntry[] {
  return [...entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'text-to-image' ? -1 : 1))
}

export async function fetchComfyWorkflow(baseUrl: string, name: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}/api/userdata/${encodeURIComponent(`workflows/${name}`)}`, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`comfy_workflow_http_${response.status}`)
  return await response.json()
}

function classify(json: unknown): WorkflowKind | null {
  return json && typeof json === 'object' && (Array.isArray((json as UiWorkflow).nodes) || isApiPrompt(json)) ? classifyWorkflow(json as UiWorkflow) : null
}

/** 运行中的服务：经 /api/userdata 列出并分类已保存的工作流 */
export async function listComfyWorkflows(baseUrl: string): Promise<ComfyWorkflowEntry[]> {
  const response = await fetch(`${baseUrl}/api/userdata?dir=workflows&recurse=true`, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) return []
  const names = ((await response.json().catch(() => [])) as unknown[]).filter((name): name is string => typeof name === 'string' && name.endsWith('.json'))
  const out: ComfyWorkflowEntry[] = []
  for (const name of names) {
    try {
      const kind = classify(await fetchComfyWorkflow(baseUrl, name))
      if (kind) out.push({ name, kind })
    } catch {
      /* 读不到的跳过 */
    }
  }
  return sortWorkflows(out)
}

async function probeComfy(root: string): Promise<LocalModelServer | null> {
  const stats = (await getJson(`${root}/system_stats`)) as { system?: unknown } | undefined
  if (!stats?.system) return null
  const workflows = await listComfyWorkflows(root).catch(() => [])
  return { kind: 'comfyui', purpose: 'image', name: 'ComfyUI', baseUrl: root, models: workflows.map((item) => item.name), running: true }
}

/* ------------------------------------------------------------ 安装位置（未运行时） */

function windowsDrives(): string[] {
  return process.platform === 'win32' ? [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:\\`).filter((drive) => existsSync(drive)) : []
}

/** 各平台应用数据目录（桌面版 ComfyUI、Stability Matrix 的默认位置） */
function appDataDirs(): string[] {
  const home = homedir()
  if (process.platform === 'win32') return [process.env.APPDATA ?? join(home, 'AppData', 'Roaming')]
  if (process.platform === 'darwin') return [join(home, 'Library', 'Application Support')]
  return [process.env.XDG_CONFIG_HOME ?? join(home, '.config'), join(home, '.local', 'share')]
}

/** 安装根目录的常见父目录：家目录、文档、各盘根目录及其下的 AI 目录 */
function installParents(): string[] {
  const home = homedir()
  const drives = windowsDrives()
  return [home, join(home, 'Documents'), join(home, 'Desktop'), join(home, 'AI'), ...drives, ...drives.map((drive) => join(drive, 'AI'))]
}

async function comfyDesktopBasePaths(): Promise<string[]> {
  const out: string[] = []
  for (const dir of appDataDirs()) {
    try {
      const config = JSON.parse(await readFile(join(dir, 'ComfyUI', 'config.json'), 'utf8')) as { basePath?: unknown }
      if (typeof config.basePath === 'string' && config.basePath) out.push(config.basePath)
    } catch {
      /* 没装桌面版 */
    }
  }
  return out
}

/** `YAN_LOCAL_INSTALL_SCAN=off`：不在磁盘上找安装目录，只认环境变量里指定的（不想被扫盘、或隔离测试时用） */
function installScanOff(): boolean {
  return process.env.YAN_LOCAL_INSTALL_SCAN?.trim().toLowerCase() === 'off'
}

export async function comfyInstallCandidates(): Promise<string[]> {
  const configured = process.env.YAN_COMFYUI_DIR?.trim()
  if (installScanOff()) return configured ? [configured] : []
  const fromParents = installParents().flatMap((parent) => [
    join(parent, 'ComfyUI'),
    join(parent, 'ComfyUI_windows_portable', 'ComfyUI'),
    join(parent, 'pinokio', 'api', 'comfy.git', 'app')
  ])
  const stabilityMatrix = appDataDirs().map((dir) => join(dir, 'StabilityMatrix', 'Packages', 'ComfyUI'))
  return [...(configured ? [configured] : []), ...(await comfyDesktopBasePaths()), ...fromParents, ...stabilityMatrix]
}

/** 有 user 目录，且是源码目录（main.py）或桌面版的数据目录（models） */
export function isComfyInstall(dir: string): boolean {
  try {
    return existsSync(join(dir, 'user')) && (existsSync(join(dir, 'main.py')) || existsSync(join(dir, 'models')))
  } catch {
    return false
  }
}

const SD_WEBUI_DIRS = ['stable-diffusion-webui', 'stable-diffusion-webui-forge', 'stable-diffusion-webui-reForge', 'sd-webui-forge', 'sd-webui-aki-v4', 'automatic']

function sdWebUiCandidates(): string[] {
  const configured = process.env.YAN_SDWEBUI_DIR?.trim()
  if (installScanOff()) return configured ? [configured] : []
  const fromParents = installParents().flatMap((parent) => SD_WEBUI_DIRS.map((name) => join(parent, name)))
  const stabilityMatrix = appDataDirs().flatMap((dir) => ['stable-diffusion-webui', 'stable-diffusion-webui-forge', 'reforge'].map((name) => join(dir, 'StabilityMatrix', 'Packages', name)))
  return [...(configured ? [configured] : []), ...fromParents, ...stabilityMatrix]
}

function isSdWebUiInstall(dir: string): boolean {
  try {
    return existsSync(join(dir, 'webui.py')) || existsSync(join(dir, 'launch.py'))
  } catch {
    return false
  }
}

/** 对话软件的可执行文件 / 应用位置 */
function chatInstalls(): Array<{ kind: 'ollama' | 'lmstudio'; name: string; dir: string; port: number; suggestedId: string }> {
  if (installScanOff()) return []
  const home = homedir()
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const ollama = process.platform === 'win32'
    ? [join(local, 'Programs', 'Ollama', 'ollama.exe')]
    : process.platform === 'darwin' ? ['/Applications/Ollama.app'] : ['/usr/local/bin/ollama', '/usr/bin/ollama']
  const lmstudio = process.platform === 'win32'
    ? [join(local, 'Programs', 'LM Studio', 'LM Studio.exe'), join(local, 'Programs', 'lm-studio', 'LM Studio.exe')]
    : process.platform === 'darwin' ? ['/Applications/LM Studio.app'] : [join(home, '.lmstudio')]
  const out: Array<{ kind: 'ollama' | 'lmstudio'; name: string; dir: string; port: number; suggestedId: string }> = []
  const hitOllama = ollama.find((path) => existsSync(path))
  if (hitOllama) out.push({ kind: 'ollama', name: 'Ollama', dir: hitOllama, port: 11434, suggestedId: 'yan-ollama' })
  const hitLm = lmstudio.find((path) => existsSync(path))
  if (hitLm) out.push({ kind: 'lmstudio', name: 'LM Studio', dir: hitLm, port: 1234, suggestedId: 'yan-lmstudio' })
  return out
}

async function walkJson(dir: string, root: string, depth = 0): Promise<string[]> {
  if (depth > 3) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkJson(path, root, depth + 1)))
    else if (entry.name.endsWith('.json')) out.push(relative(root, path).replace(/\\/g, '/'))
  }
  return out
}

/** 未运行时直接读磁盘上保存的工作流 */
export async function readInstalledWorkflows(installDir: string): Promise<ComfyWorkflowEntry[]> {
  const root = join(installDir, 'user', 'default', 'workflows')
  const out: ComfyWorkflowEntry[] = []
  for (const name of await walkJson(root, root)) {
    try {
      const kind = classify(JSON.parse(await readFile(join(root, name), 'utf8')))
      if (kind) out.push({ name, kind })
    } catch {
      /* 坏文件跳过 */
    }
  }
  return sortWorkflows(out)
}

/* ------------------------------------------------------------ 汇总 */

interface Roots {
  chat: Array<{ root: string; target?: ChatTarget }>
  comfy: string[]
  sdapi: string[]
}

async function probeRoots(): Promise<Roots> {
  const extra = await readLocalModelUrls()
  const comfyEnv = process.env.YAN_COMFYUI_URL?.trim()
  const sdEnv = process.env.YAN_SDWEBUI_URL?.trim()
  return {
    chat: [
      ...CHAT_TARGETS.map((target) => ({ root: localServiceBase(target.env ? process.env[target.env] : undefined, target.port), target })),
      ...extra.map((root) => ({ root }))
    ],
    comfy: [...(comfyEnv ? [localServiceBase(comfyEnv, 8188)] : []), ...COMFY_PORTS.map((port) => `http://127.0.0.1:${port}`), ...extra],
    sdapi: [...(sdEnv ? [localServiceBase(sdEnv, 7860)] : []), ...SDAPI_PORTS.map((port) => `http://127.0.0.1:${port}`), ...extra]
  }
}

const unique = <T>(list: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>()
  return list.filter((item) => (seen.has(key(item)) ? false : (seen.add(key(item)), true)))
}

async function runningImageServices(roots: Roots): Promise<LocalModelServer[]> {
  const [sd, comfy] = await Promise.all([
    Promise.all(unique(roots.sdapi, (root) => root).map(probeSdApi)),
    Promise.all(unique(roots.comfy, (root) => root).map(probeComfy))
  ])
  return [...sd, ...comfy].filter((server): server is LocalModelServer => !!server)
}

/** 探测全部本机服务（设置页「检测本地模型」），包括已安装但未运行的 */
export async function detectLocalModelServers(): Promise<LocalModelServer[]> {
  const roots = await probeRoots()
  const [chat, images] = await Promise.all([
    Promise.all(unique(roots.chat, (item) => item.root).map((item) => probeChat(item.root, item.target))),
    runningImageServices(roots)
  ])
  const found = [...chat.filter((server): server is LocalModelServer => !!server), ...images]

  /* 未运行：同类服务已经在跑就不再列安装目录 */
  const runningKinds = new Set(found.map((server) => server.kind))
  for (const app of chatInstalls()) {
    if (runningKinds.has(app.kind)) continue
    found.push({ kind: app.kind, purpose: 'chat', name: app.name, baseUrl: `http://127.0.0.1:${app.port}/v1`, models: [], suggestedId: app.suggestedId, running: false, installDir: app.dir })
  }
  if (!runningKinds.has('comfyui')) {
    const dir = (await comfyInstallCandidates()).find(isComfyInstall)
    if (dir) found.push({ kind: 'comfyui', purpose: 'image', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', models: (await readInstalledWorkflows(dir)).map((item) => item.name), running: false, installDir: dir })
  }
  if (!runningKinds.has('sdwebui')) {
    const dir = sdWebUiCandidates().find(isSdWebUiInstall)
    if (dir) found.push({ kind: 'sdwebui', purpose: 'image', name: 'Stable Diffusion WebUI', baseUrl: 'http://127.0.0.1:7860', models: [], running: false, installDir: dir })
  }
  return found
}

let imageCache: { at: number; value: Promise<LocalModelServer | null> } | null = null

/** 服务刚被启动或关掉时作废缓存，免得生图通道还拿着 30 秒前的结果 */
export function resetLocalImageCache(): void {
  imageCache = null
}

/**
 * 生图通道用的本机服务：只认正在运行、且有可用模型或工作流的。
 * SD WebUI 系在前（接口固定、不依赖工作流），其次 ComfyUI；同类里环境变量与本机默认端口在前，
 * 设置里手动添加的地址在后。
 */
export function detectLocalImageService(): Promise<LocalModelServer | null> {
  if (imageCache && Date.now() - imageCache.at < IMAGE_CACHE_MS) return imageCache.value
  const value = (async () => {
    const services = await runningImageServices(await probeRoots())
    return services.find((server) => server.models.length) ?? null
  })()
  imageCache = { at: Date.now(), value }
  return value
}
