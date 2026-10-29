import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LocalModelServer } from '../shared/custom-provider'
import { YAN_DIR } from './paths'

const PROBE_TIMEOUT_MS = 1_500
const IMAGE_CACHE_MS = 30_000

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

const CONFIG_FILE = join(YAN_DIR, 'local-models.json')

export async function readLocalModelUrls(): Promise<string[]> {
  try {
    const json = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as { urls?: unknown }
    return Array.isArray(json.urls) ? json.urls.filter((url): url is string => typeof url === 'string' && !!url.trim()) : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`本地模型地址配置损坏；为保护原配置，已拒绝继续：${error instanceof Error ? error.message : String(error)}`)
  }
}

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
  const temp = `${CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify({ urls: clean }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, CONFIG_FILE)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
  resetLocalImageCache()
  return clean
}

interface ChatTarget {
  kind: 'ollama' | 'lmstudio' | 'openai'
  name: string
  port: number
  env?: string
  suggestedId: string
}

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

const SDAPI_PORTS = [7860, 7861]

async function probeSdApi(root: string): Promise<LocalModelServer | null> {
  const json = await getJson(`${root}/sdapi/v1/sd-models`)
  if (!Array.isArray(json)) return null
  const models = json.map((item) => (item as { title?: unknown } | null)?.title).filter((title): title is string => typeof title === 'string' && !!title)
  return { kind: 'sdwebui', purpose: 'image', name: 'Stable Diffusion WebUI', baseUrl: root, models, running: true }
}

function windowsDrives(): string[] {
  return process.platform === 'win32' ? [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:\\`).filter((drive) => existsSync(drive)) : []
}

function appDataDirs(): string[] {
  const home = homedir()
  if (process.platform === 'win32') return [process.env.APPDATA ?? join(home, 'AppData', 'Roaming')]
  if (process.platform === 'darwin') return [join(home, 'Library', 'Application Support')]
  return [process.env.XDG_CONFIG_HOME ?? join(home, '.config'), join(home, '.local', 'share')]
}

function installParents(): string[] {
  const home = homedir()
  const drives = windowsDrives()
  return [home, join(home, 'Documents'), join(home, 'Desktop'), join(home, 'AI'), ...drives, ...drives.map((drive) => join(drive, 'AI'))]
}

function installScanOff(): boolean {
  return process.env.YAN_LOCAL_INSTALL_SCAN?.trim().toLowerCase() === 'off'
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

interface Roots {
  chat: Array<{ root: string; target?: ChatTarget }>
  sdapi: string[]
}

async function probeRoots(): Promise<Roots> {
  const extra = await readLocalModelUrls()
  const sdEnv = process.env.YAN_SDWEBUI_URL?.trim()
  return {
    chat: [
      ...CHAT_TARGETS.map((target) => ({ root: localServiceBase(target.env ? process.env[target.env] : undefined, target.port), target })),
      ...extra.map((root) => ({ root }))
    ],
    sdapi: [...(sdEnv ? [localServiceBase(sdEnv, 7860)] : []), ...SDAPI_PORTS.map((port) => `http://127.0.0.1:${port}`), ...extra]
  }
}

const unique = <T>(list: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>()
  return list.filter((item) => (seen.has(key(item)) ? false : (seen.add(key(item)), true)))
}

async function runningImageServices(roots: Roots): Promise<LocalModelServer[]> {
  const sd = await Promise.all(unique(roots.sdapi, (root) => root).map(probeSdApi))
  return sd.filter((server): server is LocalModelServer => !!server)
}

async function discoverLocalModelServers(): Promise<LocalModelServer[]> {
  const roots = await probeRoots()
  const [chat, images] = await Promise.all([
    Promise.all(unique(roots.chat, (item) => item.root).map((item) => probeChat(item.root, item.target))),
    runningImageServices(roots)
  ])
  const found = [...chat.filter((server): server is LocalModelServer => !!server), ...images]

  const runningKinds = new Set(found.map((server) => server.kind))
  for (const app of chatInstalls()) {
    if (runningKinds.has(app.kind)) continue
    found.push({ kind: app.kind, purpose: 'chat', name: app.name, baseUrl: `http://127.0.0.1:${app.port}/v1`, models: [], suggestedId: app.suggestedId, running: false, installDir: app.dir })
  }
  if (!runningKinds.has('sdwebui')) {
    const dir = sdWebUiCandidates().find(isSdWebUiInstall)
    if (dir) found.push({ kind: 'sdwebui', purpose: 'image', name: 'Stable Diffusion WebUI', baseUrl: 'http://127.0.0.1:7860', models: [], running: false, installDir: dir })
  }
  return found
}

let imageCache: { at: number; value: Promise<LocalModelServer | null> } | null = null
let modelsCache: { at: number; value: Promise<LocalModelServer[]> } | null = null

export function resetLocalImageCache(): void {
  imageCache = null
  modelsCache = null
}

export function detectLocalModelServers(): Promise<LocalModelServer[]> {
  if (modelsCache && Date.now() - modelsCache.at < IMAGE_CACHE_MS) return modelsCache.value
  const value = discoverLocalModelServers().catch((error) => {
    modelsCache = null
    throw error
  })
  modelsCache = { at: Date.now(), value }
  return value
}

export function detectLocalImageService(): Promise<LocalModelServer | null> {
  if (imageCache && Date.now() - imageCache.at < IMAGE_CACHE_MS) return imageCache.value
  const value = (async () => {
    const services = await runningImageServices(await probeRoots())
    return services.find((server) => server.models.length) ?? null
  })()
  imageCache = { at: Date.now(), value }
  return value
}
