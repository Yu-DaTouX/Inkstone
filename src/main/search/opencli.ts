import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import {
  DEFAULT_SEARCH_SOURCES,
  SEARCH_LIMIT_PER_SOURCE_DEFAULT,
  SEARCH_LIMIT_PER_SOURCE_MAX,
  SEARCH_LIMIT_TOTAL_DEFAULT,
  SEARCH_LIMIT_TOTAL_MAX,
  SEARCH_OUTPUT_MAX_BYTES,
  SEARCH_QUERY_MAX,
  SEARCH_SOURCES,
  SEARCH_TIMEOUT_MS_DEFAULT,
  SEARCH_TIMEOUT_MS_MAX,
  type SearchItem,
  type SearchOutcome,
  type SearchQuery,
  type SearchSource,
  type SearchSourceId,
  type SearchBackendStatus
} from '../../shared/search'
import { aggregate, summarizeSources, type SourceRun } from './aggregate'

export type AdapterRunner = (
  source: SearchSource,
  query: string,
  opts: { limit: number; timeoutMs: number }
) => Promise<SourceRun>

export interface SearchDeps {
  runner: AdapterRunner
  now: () => number
}

const byId = new Map<string, SearchSource>(SEARCH_SOURCES.map((s) => [s.id, s]))

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function findExecutableOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const names =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((ext) => name + ext.toLowerCase())
      : [name]
  for (const dir of dirs) {
    for (const candidate of names) {
      const p = join(dir, candidate)
      if (fileExists(p)) return p
    }
  }
  return null
}

function statForNode(p: string): { isFile: boolean; size: number } {
  try {
    const s = statSync(p)
    return { isFile: s.isFile(), size: s.size }
  } catch {
    return { isFile: false, size: -1 }
  }
}

export function findNodeOnPath(
  dirs: string[] = (process.env.PATH ?? '').split(delimiter).filter(Boolean),
  probe: (p: string) => { isFile: boolean; size: number } = statForNode,
  platform: NodeJS.Platform = process.platform
): string | null {
  const names = platform === 'win32' ? ['node.exe'] : ['node']
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name)
      const st = probe(p)
      if (!st.isFile || st.size <= 0) continue
      return p
    }
  }
  return null
}

export interface BackendTarget {
  file: string
  prefix: string[]
  source: string
  error?: string
}

export interface JsRuntime {
  file: string
  error?: string
}

function looksLikeElectronRuntime(p: string): boolean {
  if (p.toLowerCase() === process.execPath.toLowerCase()) {
    return Boolean((process.versions as { electron?: string }).electron)
  }
  const base = basename(p).toLowerCase()
  return base === 'electron' || base === 'electron.exe'
}

export function resolveJsRuntime(
  findNode: () => string | null = findNodeOnPath,
  execPath: string = process.execPath,
  electron: boolean = Boolean((process.versions as { electron?: string }).electron),
  nodeBin: string | undefined = process.env.YAN_NODE_BIN
): JsRuntime {
  if (!electron) return { file: execPath }
  const explicit = nodeBin?.trim()
  if (explicit) {
    if (!fileExists(explicit)) {
      return {
        file: execPath,
        error: `YAN_NODE_BIN 指向的 ${explicit} 不存在；请改成真实的 node 可执行文件，或删掉这个变量并安装 Node.js（>=20.18.1）后加入 PATH`
      }
    }
    if (looksLikeElectronRuntime(explicit)) {
      return {
        file: execPath,
        error: `YAN_NODE_BIN 指向的是 Electron（${explicit}），不是 node —— Electron 自带的 Node 会让 OpenCLI 的命令行参数错位；请指定真正的 node 可执行文件`
      }
    }
    return { file: explicit }
  }
  const node = findNode()
  if (node) return { file: node }
  return {
    file: execPath,
    error:
      '找不到可用的 node：OpenCLI 用的 commander 在 Electron 下会按 app 语义切参数，子命令会全部错位，所以不能拿 Electron 自带的 Node 去跑；请安装 Node.js（>=20.18.1）并加入 PATH，或用 YAN_NODE_BIN 指定 node 可执行文件'
  }
}

export function resolveBackendTarget(explicit?: string, runtime: JsRuntime = resolveJsRuntime()): BackendTarget {
  const js = explicit ?? process.env.YAN_OPENCLI_JS
  if (js) {
    if (js.endsWith('.js') || js.endsWith('.mjs') || js.endsWith('.cjs')) {
      const source = runtime.file + ' ' + js
      return runtime.error
        ? { file: runtime.file, prefix: [js], source, error: runtime.error }
        : { file: runtime.file, prefix: [js], source }
    }
    return { file: js, prefix: [], source: js }
  }
  const shim = findExecutableOnPath('opencli')
  if (shim) {
    const entry = join(dirname(shim), 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')
    if (fileExists(entry)) {
      const source = runtime.file + ' ' + entry
      return runtime.error
        ? { file: runtime.file, prefix: [entry], source, error: runtime.error }
        : { file: runtime.file, prefix: [entry], source }
    }
    return {
      file: shim,
      prefix: [],
      source: shim,
      error: `找到 ${shim} 但推不出 OpenCLI 的包入口（${entry}）；请用 YAN_OPENCLI_JS 指定 dist/src/main.js 的路径`
    }
  }
  return { file: 'opencli', prefix: [], source: 'opencli（PATH 里没找到）' }
}

function spawnEnv(file: string): NodeJS.ProcessEnv | undefined {
  return file === process.execPath ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : undefined
}

function missingBinaryMessage(target: BackendTarget): string {
  return target.prefix.length > 0
    ? `找不到运行 OpenCLI 的 node（${target.file}）；请安装 Node.js（>=20.18.1）并加入 PATH，或用 YAN_NODE_BIN 指定`
    : `找不到 ${target.file}（未安装，或不在 PATH；可用 YAN_OPENCLI_JS 指定 OpenCLI 入口）`
}

export function findSource(id: string): SearchSource | undefined {
  return byId.get(id)
}

export function parseBackendError(raw: string): { code?: string; message?: string } {
  const code = raw.match(/^\s*code:\s*([A-Z_]+)\s*$/m)?.[1]
  const message = raw.match(/^\s*message:\s*(.+)$/m)?.[1]
  const out: { code?: string; message?: string } = {}
  if (code) out.code = code
  if (message) out.message = message.trim()
  if (!out.code && !out.message) {
    const cleaned = raw.trim().slice(0, 300)
    out.message = cleaned || '后端没有任何输出'
  }
  return out
}

export function createOpencliRunner(explicit?: string, target = resolveBackendTarget(explicit)): AdapterRunner {
  return (source, query, opts) =>
    new Promise<SourceRun>((resolve) => {
      const started = Date.now()
      if (target.error) {
        resolve({
          source: source.id,
          rows: null,
          unavailable: true,
          error: { code: 'backend_unavailable', message: target.error },
          elapsedMs: 0
        })
        return
      }
      const args = [...target.prefix, source.app, source.subcommand, '-f', 'json', '--limit', String(opts.limit), '--', query]
      const env = spawnEnv(target.file)
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(target.file, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(env ? { env } : {})
        })
      } catch (e) {
        resolve({
          source: source.id,
          rows: null,
          unavailable: true,
          error: { code: 'backend_unavailable', message: e instanceof Error ? e.message : String(e) },
          elapsedMs: Date.now() - started
        })
        return
      }

      let out = ''
      let err = ''
      let timedOut = false
      let overflow = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, opts.timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        if (out.length >= SEARCH_OUTPUT_MAX_BYTES) {
          overflow = true
          return
        }
        out += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (err.length < 8192) err += chunk.toString('utf8')
      })

      child.on('error', (e: Error) => {
        clearTimeout(timer)
        const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT'
        resolve({
          source: source.id,
          rows: null,
          unavailable: enoent,
          error: {
            code: enoent ? 'backend_unavailable' : 'backend_error',
            message: enoent ? missingBinaryMessage(target) : e.message
          },
          elapsedMs: Date.now() - started
        })
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        const elapsedMs = Date.now() - started
        if (timedOut) {
          resolve({
            source: source.id,
            rows: null,
            timedOut: true,
            error: { code: 'timeout', message: `超过 ${opts.timeoutMs}ms 没有返回` },
            elapsedMs
          })
          return
        }
        const text = out.trim()
        if (text.startsWith('[')) {
          try {
            const parsed = JSON.parse(text) as unknown
            resolve({
              source: source.id,
              rows: Array.isArray(parsed) ? parsed : null,
              elapsedMs
            })
            return
          } catch {
            resolve({
              source: source.id,
              rows: null,
              error: { code: 'bad_output', message: '后端输出不是合法 JSON（可能被截断）' },
              elapsedMs
            })
            return
          }
        }
        const parsedErr = parseBackendError(text || err)
        resolve({
          source: source.id,
          rows: null,
          error: {
            code: parsedErr.code ?? (overflow ? 'output_too_large' : 'backend_error'),
            message: parsedErr.message ?? `后端退出码 ${code}`
          },
          elapsedMs
        })
      })
    })
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function normalizeQuery(input: SearchQuery):
  | {
      ok: true
      text: string
      sources: SearchSource[]
      ignoredSources: string[]
      limitPerSource: number
      limitTotal: number
      timeoutMs: number
    }
  | { ok: false; code: string; message: string; ignoredSources: string[] } {
  const text = (input.text ?? '').trim()
  const wanted = input.sources && input.sources.length > 0 ? input.sources : [...DEFAULT_SEARCH_SOURCES]
  const sources: SearchSource[] = []
  const ignoredSources: string[] = []
  for (const id of wanted) {
    const s = byId.get(id as SearchSourceId)
    if (!s) {
      const name = String(id)
      if (!ignoredSources.includes(name)) ignoredSources.push(name)
      continue
    }
    if (!sources.includes(s)) sources.push(s)
  }
  if (!text) return { ok: false, code: 'empty_query', message: '查询词是空的', ignoredSources }
  if (text.length > SEARCH_QUERY_MAX) {
    return { ok: false, code: 'query_too_long', message: `查询词太长（上限 ${SEARCH_QUERY_MAX} 字）`, ignoredSources }
  }
  if (sources.length === 0) return { ok: false, code: 'no_source', message: '没有可用的搜索来源', ignoredSources }
  return {
    ok: true,
    text,
    sources,
    ignoredSources,
    limitPerSource: clamp(input.limitPerSource, 1, SEARCH_LIMIT_PER_SOURCE_MAX, SEARCH_LIMIT_PER_SOURCE_DEFAULT),
    limitTotal: clamp(input.limitTotal, 1, SEARCH_LIMIT_TOTAL_MAX, SEARCH_LIMIT_TOTAL_DEFAULT),
    timeoutMs: clamp(input.timeoutMs, 1000, SEARCH_TIMEOUT_MS_MAX, SEARCH_TIMEOUT_MS_DEFAULT)
  }
}

export async function runSearch(input: SearchQuery, deps: SearchDeps): Promise<SearchOutcome> {
  const started = deps.now()
  const parsed = normalizeQuery(input)
  if (!parsed.ok) {
    return {
      query: (input.text ?? '').trim(),
      items: [],
      sources: [],
      truncated: false,
      durationMs: deps.now() - started,
      error: { code: parsed.code, message: parsed.message },
      ...(parsed.ignoredSources.length ? { ignoredSources: parsed.ignoredSources } : {})
    }
  }

  const runs: SourceRun[] = []
  const queue = [...parsed.sources]
  const CONCURRENCY = 3
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const source = queue.shift()
      if (!source) return
      const run = await deps.runner(source, parsed.text, {
        limit: parsed.limitPerSource,
        timeoutMs: parsed.timeoutMs
      })
      runs.push(run)
    }
  })
  await Promise.all(workers)

  const order = new Map(parsed.sources.map((s, i) => [s.id, i]))
  runs.sort((a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0))

  const merged = aggregate(runs, { limitPerSource: parsed.limitPerSource, limitTotal: parsed.limitTotal })
  return {
    query: parsed.text,
    items: merged.items,
    sources: merged.sources,
    truncated: merged.truncated,
    durationMs: deps.now() - started,
    ...(parsed.ignoredSources.length ? { ignoredSources: parsed.ignoredSources } : {})
  }
}

export async function searchDoctor(deps: {
  runner?: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>
} = {}): Promise<SearchBackendStatus> {
  const sourcesFor = (available: boolean) =>
    SEARCH_SOURCES.filter((s) => !s.direct).map((s) => ({ id: s.id, label: s.label, needsBrowser: s.needsBrowser, ready: available }))
  const probe = deps.runner ?? defaultProbe
  const version = await probe(['--version'], 8000)
  if (version.code !== 0 && !version.stdout.trim()) {
    const detail = version.timedOut
      ? 'opencli --version 超时（8s 没有返回）；可能是 PATH 上的命令卡住，或环境异常'
      : (version.stderr || version.stdout).trim().slice(0, 400)
    return {
      available: false,
      version: null,
      code: 'backend_unavailable',
      detail: detail || '找不到 opencli（未安装或不在 PATH）',
      sources: sourcesFor(false)
    }
  }
  const doctor = await probe(['doctor'], 20_000)
  const raw = (doctor.stdout + '\n' + doctor.stderr).trim()
  const timedOut = doctor.timedOut === true
  const usageError = /unknown command|unknown option|^Usage:\s*opencli/m.test(raw)
  if (!raw || usageError || timedOut) {
    return {
      available: false,
      version: version.stdout.trim().split('\n')[0].slice(0, 80) || null,
      code: 'backend_unusable',
      detail:
        (timedOut ? `doctor 探针超时（超过 20s 没有返回）；已收到的输出：${raw || '（无）'}` : raw).slice(0, 1200) ||
        '后端命令没能正常执行（没有任何输出）',
      sources: sourcesFor(false)
    }
  }
  const extensionMissing = /Extension:\s*not connected/i.test(raw) || /BROWSER_CONNECT/.test(raw)
  return {
    available: true,
    version: version.stdout.trim().split('\n')[0].slice(0, 80) || null,
    detail: raw.slice(0, 1200),
    ...(extensionMissing ? { code: 'extension_not_connected' } : {}),
    sources: sourcesFor(true)
  }
}

async function defaultProbe(
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
  const target = resolveBackendTarget()
  if (target.error) return { code: -1, stdout: '', stderr: target.error }
  const env = spawnEnv(target.file)
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(target.file, [...target.prefix, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env ? { env } : {})
      })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) })
      return
    }
    let out = ''
    let err = ''
    let timedOut = false
    let killFallback: ReturnType<typeof setTimeout> | undefined
    let timer: ReturnType<typeof setTimeout>
    const done = (result: { code: number; stdout: string; stderr: string; timedOut?: boolean }): void => {
      clearTimeout(timer)
      if (killFallback) clearTimeout(killFallback)
      resolve(result)
    }
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      killFallback = setTimeout(() => done({ code: -1, stdout: out, stderr: err, timedOut: true }), 1000)
    }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => {
      if (out.length < 64_000) out += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      if (err.length < 64_000) err += c.toString('utf8')
    })
    child.on('error', (e: Error) => {
      const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT'
      done({ code: -1, stdout: out, stderr: enoent ? missingBinaryMessage(target) : e.message })
    })
    child.on('close', (code) => {
      done({ code: code ?? -1, stdout: out, stderr: err, ...(timedOut ? { timedOut: true } : {}) })
    })
  })
}

export function searchSummary(outcome: SearchOutcome): string {
  const parts = [`${outcome.items.length} 条结果`, summarizeSources(outcome.sources)]
  if (outcome.truncated) parts.push('已截断')
  if (outcome.ignoredSources?.length) parts.push(`已忽略未知来源：${outcome.ignoredSources.join('、')}`)
  return parts.join(' · ')
}

export type { SearchItem, SourceRun }

export { SEARCH_SOURCES, SEARCH_LIMIT_PER_SOURCE_MAX } from '../../shared/search'
export {
  aggregate,
  normalizeRow,
  normalizeUrlForDedupe,
  decodeEntities,
  cleanText,
  summarizeSources
} from './aggregate'

export interface OpenCliInstallResult {
  ok: boolean
  needsNode?: boolean
  error?: string
  log?: string
}

export function installOpenCli(): Promise<OpenCliInstallResult> {
  const npm = findExecutableOnPath('npm')
  if (!npm) return Promise.resolve({ ok: false, needsNode: true, error: '没有找到 npm，需要先安装 Node.js（20.18.1 或更新）' })
  const args = ['install', '-g', '@jackwener/opencli']
  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(npm)
  return new Promise((resolve) => {
    let log = ''
    const keep = (c: Buffer): void => {
      log = (log + c.toString('utf8')).slice(-8000)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = isCmd
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${npm}" ${args.join(' ')}`], { windowsHide: true, windowsVerbatimArguments: true })
        : spawn(npm, args, { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60_000)
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.message, log: log.trim().split('\n').slice(-12).join('\n') })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const tail = log.trim().split('\n').slice(-12).join('\n')
      resolve(code === 0 ? { ok: true, log: tail } : { ok: false, error: `npm 退出码 ${code ?? '?'}`, log: tail })
    })
  })
}
