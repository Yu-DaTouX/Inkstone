// Shared harness for the PB2 native-exe adapter tests (real PiRpc + isolated data dirs).
// One-off isolated data lives under the caller's temp dir; no real user data or model calls.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = fileURLToPath(new URL('../..', import.meta.url))
export const EXT_DIR = join(REPO, 'resources', 'pi-extensions')
export const PI_BOLT_EXE_DEFAULT = 'E:/pi-desktop/.tmp/pi-bolt-eval/ext/pi-bolt-win32-x64/pi-bolt.exe'
export const PI_BOLT_KNOWN_SHA256 = 'b3a706e5521099798cc92113ba4a87ea5bfdf3af43d457fc098ae13109e0626c'

/**
 * 实际随包 pi 运行时的入口（baseline 对照仍走 Electron-as-Node，不用系统 node 冒充）。
 * `resources/pi-runtime/current.json` 指定 generation，与生产 `selectedPiRuntime` 一致。
 */
export function bundledCliJs() {
  const root = join(REPO, 'resources', 'pi-runtime')
  const manifest = join(root, 'current.json')
  const generation = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).generation : ''
  const base = generation ? join(root, generation) : root
  const cli = join(base, 'dist', 'bundle', 'cli.js')
  if (!existsSync(cli)) throw new Error(`随包 pi CLI 不存在：${cli}`)
  return cli
}

export function electronExe() {
  const name = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const exe = join(REPO, 'node_modules', 'electron', 'dist', name)
  if (!existsSync(exe)) throw new Error(`Electron 二进制不存在：${exe}`)
  return exe
}

/** 运行前复核候选 exe 的 SHA256；不匹配 / 文件不存在一律返回 null（调用方停止，不绕过）。 */
export function verifyCandidateExe(exe) {
  if (!exe || !existsSync(exe)) return { ok: false, reason: `候选 exe 不存在：${exe ?? '(未设置)'}` }
  const bytes = readFileSync(exe)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== PI_BOLT_KNOWN_SHA256) return { ok: false, reason: `候选 exe SHA256 不匹配：${actual}` }
  return { ok: true, sha256: actual, sizeBytes: bytes.length }
}

export function resetDir(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

/**
 * 完全隔离的子进程环境：不继承真实凭证 / provider / proxy / 用户数据。
 * `PATH` 默认只留 System32（+ 调用方显式补的目录，用于需要 shell 的场景）。
 */
export function isolatedEnv({ baseDir, extra = {}, pathDirs = [] } = {}) {
  const agent = join(baseDir, 'agent')
  const data = join(baseDir, 'data')
  const home = join(baseDir, 'home')
  const appdata = join(baseDir, 'appdata')
  const localappdata = join(baseDir, 'localappdata')
  const tmp = join(baseDir, 'tmp')
  const cwd = join(baseDir, 'cwd')
  const sessions = join(baseDir, 'sessions')
  for (const d of [agent, data, home, appdata, localappdata, tmp, cwd, sessions]) mkdirSync(d, { recursive: true })
  const systemRoot = process.env.SystemRoot || 'C:/Windows'
  const env = {
    SystemRoot: systemRoot,
    windir: process.env.windir || systemRoot,
    COMSPEC: process.env.COMSPEC || join(systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    PATH: [join(systemRoot, 'System32'), systemRoot, ...pathDirs].join(';'),
    TEMP: tmp,
    TMP: tmp,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appdata,
    LOCALAPPDATA: localappdata,
    PI_CODING_AGENT_DIR: agent,
    YAN_DATA_DIR: data,
    NO_COLOR: '1',
    ...extra
  }
  return { env, agent, data, home, cwd, sessions, baseDir }
}

export function writeModelsJson(agentDir, port) {
  const models = {
    providers: {
      eval: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-completions',
        apiKey: 'pb2-local-key',
        models: [{
          id: 'eval-model',
          name: 'Eval Model',
          reasoning: false,
          input: ['text'],
          contextWindow: 128000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }]
      }
    }
  }
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(models, null, 2))
}

/** AgentController 当前实际加载的薄层资源（与 src/main/index.ts 清单保持同步的检查项）。 */
export const THIN_EXTENSION_FILES = [
  'codemode-policy.js',
  'question.js',
  'shell-fallback.js',
  'response-detail.js',
  'preamble.js',
  'language.js',
  'temperature.js',
  'capability-guide.js',
  'context-inspect.js',
  'context-trim.js',
  'repeat-guard.js',
  'danger-guard.js',
  'commandcode.js',
  'provider-diagnostics.js',
  'mcp-app-proxy.js'
]

export function thinExtensionArgs() {
  return THIN_EXTENSION_FILES.filter((f) => existsSync(join(EXT_DIR, f))).flatMap((f) => ['--extension', join(EXT_DIR, f)])
}

/** 真实 WASM/worker 工作负载：两个正式工具调用（read + grep），不是纯算术。 */
/** 真实 WASM/worker 工作负载：两个正式工具调用（read + write），不是纯算术。
 * 完全隔离的 PATH 下没有 bash shell，故用等价的正式写工具做 worker→host 回程。 */
export function codemodeWorkload({ readPath, writePath, writeContent = 'pb2-codemode-write\n' }) {
  return [
    `const a = await tools.read({ path: ${JSON.stringify(readPath)} })`,
    `const b = await tools.write({ path: ${JSON.stringify(writePath)}, content: ${JSON.stringify(writeContent)} })`,
    'const len = (v) => typeof v === \'string\' ? v.length : JSON.stringify(v).length',
    'return `${len(a)}|${len(b)}`'
  ].join('\n')
}

export function waitForEvent(rpc, predicate, { timeoutMs = 60000, pollMs = 10 } = {}) {
  const existing = rpc.__events.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(iv); reject(new Error('event timeout')) }, timeoutMs)
    const iv = setInterval(() => {
      const hit = rpc.__events.find(predicate)
      if (hit) { clearInterval(iv); clearTimeout(timer); resolve(hit) }
    }, pollMs)
  })
}

/** 等一轮结束：优先 agent_settled 事件，兜底轮询 get_state。 */
export async function waitForSettled(rpc, { timeoutMs = 60000 } = {}) {
  try {
    await waitForEvent(rpc, (e) => e.type === 'agent_settled', { timeoutMs })
    return true
  } catch {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const s = await rpc.command('get_state', {}, { timeoutMs: 20000 })
      if (s.data && s.data.isStreaming === false) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }
}

/** 进程树 CPU / 内存采样（Win32_Process；采样器自身成本不计入）。 */
export function sampleProcessTree(rootPid) {
  return new Promise((resolve) => {
    const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    const script = fileURLToPath(new URL('./pi-bolt-adapter-proctree.ps1', import.meta.url))
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-File', script, '-RootPid', String(rootPid)], { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', () => resolve(null))
    child.on('exit', () => {
      try { resolve(JSON.parse(out.trim())) } catch { resolve(err ? { error: err.slice(0, 200) } : null) }
    })
  })
}

/** 相对中位数（避免均值被单次抖动拉偏）；返回 { median, values }。 */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function defaultTmpRoot(label) {
  const dir = join(tmpdir(), `pb2-adapter-${label}-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
