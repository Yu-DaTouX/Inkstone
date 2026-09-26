/**
 * OpenCLI 后端调用（实施-27 S2）。
 *
 * 设计要点：
 *   · **参数数组，不拼 shell** —— 查询词、来源名都可能带引号/分号，拼字符串
 *     等于把命令注入的口子开在搜索框上；
 *   · **来源走白名单** —— `app`/`subcommand` 只能来自 `SEARCH_SOURCES`，
 *     调用方给的字符串一律不接受；
 *   · **超时必杀进程**，并把「超时」与「后端报错」分成两种状态；
 *   · **输出有上限**，超出按截断处理 —— 免得一次查询把几百 KB 塞进上下文；
 *   · 不安装、不升级 OpenCLI：找不到后端就如实返回 `unavailable`。
 */
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import {
  SEARCH_LIMIT_PER_SOURCE_MAX,
  SEARCH_OUTPUT_MAX_BYTES,
  SEARCH_QUERY_MAX,
  SEARCH_SOURCES,
  SEARCH_TIMEOUT_MS_MAX,
  type SearchItem,
  type SearchOutcome,
  type SearchQuery,
  type SearchSource,
  type SearchSourceId,
  type SearchBackendStatus
} from '../../shared/search'
import { aggregate, summarizeSources, type SourceRun } from './aggregate'

/** 一次适配器调用的结果（可被替身替换，便于单测） */
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

/**
 * 在 PATH 里找一个可执行文件。
 *
 * Windows 上只认带 PATHEXT 扩展名的（`.cmd` / `.exe` / …）—— npm 全局还会放一个
 * **无扩展名的 bash 脚本**给 Git Bash 用，那个东西 CreateProcess 是起不来的，
 * 找到它反而会把「后端不可用」写成「后端报错」。
 */
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

/** 后端的启动方式：固定 file + 前置参数（`node <entry>` 这种形态需要它） */
export interface BackendTarget {
  file: string
  prefix: string[]
  /** 给人看的说明（写进错误信息与 doctor） */
  source: string
  /** 有值时直接当「后端不可用」—— 例如 Windows 上只找到 .cmd shim 却推不出包入口 */
  error?: string
}

/**
 * 找到 OpenCLI 的启动方式（实施-27 S2）。
 *
 * 为什么不直接 `spawn('opencli')`：Windows 上 npm 的全局命令是 `.cmd` shim，
 * 不经 shell 是执行不了的；而为了**不把查询词交给 shell**（注入），
 * 这里改成「找包的 JS 入口 + 用当前 node 跑」—— 参数仍然是数组，不过 shell。
 * 顺序：显式指定 → PATH 里的 `.cmd` 推导包入口 → PATH 里的可执行文件。
 */
export function resolveBackendTarget(explicit?: string): BackendTarget {
  const js = explicit ?? process.env.YAN_OPENCLI_JS
  /* 显式给了路径：`.js` 走 node，其它当可执行文件 */
  if (js) {
    return js.endsWith('.js') || js.endsWith('.mjs') || js.endsWith('.cjs')
      ? { file: process.execPath, prefix: [js], source: process.execPath + ' ' + js }
      : { file: js, prefix: [], source: js }
  }
  const shim = findExecutableOnPath('opencli')
  if (shim) {
    /* npm 全局布局：<prefix>/opencli.cmd 与 <prefix>/node_modules/@jackwener/opencli */
    const entry = join(dirname(shim), 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')
    if (fileExists(entry)) return { file: process.execPath, prefix: [entry], source: 'node ' + entry }
    /*
     * 只找到 `.cmd` 而推不出包入口：**不能**直接 spawn 它（不经 shell 起不来，
     * 经 shell 则要把查询词交给 shell —— 两样都不接受）。此处当成「不可用」上报。
     */
    return {
      file: shim,
      prefix: [],
      source: shim,
      error: `找到 ${shim} 但推不出 OpenCLI 的包入口（${entry}）；请用 YAN_OPENCLI_JS 指定 dist/src/main.js 的路径`
    }
  }
  return { file: 'opencli', prefix: [], source: 'opencli（PATH 里没找到）' }
}

/**
 * 用 Electron 自带的 Node 跑 JS 时必须显式声明 `ELECTRON_RUN_AS_NODE=1`，
 * 否则 `spawn(process.execPath, [...])` 会再拉起一个**应用实例**（而不是跑那个脚本）。
 * 仓库里 protocol.ts / credentials.ts / packages.ts / yan-cli.ts 都是这个口径。
 */
function spawnEnv(file: string): NodeJS.ProcessEnv | undefined {
  return file === process.execPath ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : undefined
}

export function findSource(id: string): SearchSource | undefined {
  return byId.get(id)
}

/** 从 OpenCLI 的 YAML 风格错误里抠出 code / message（拿不到就只给原始文本） */
export function parseBackendError(raw: string): { code?: string; message?: string } {
  const code = raw.match(/^\s*code:\s*([A-Z_]+)\s*$/m)?.[1]
  const message = raw.match(/^\s*message:\s*(.+)$/m)?.[1]
  const out: { code?: string; message?: string } = {}
  if (code) out.code = code
  if (message) out.message = message.trim()
  if (!out.code && !out.message) {
    const cleaned = raw.trim().slice(0, 300)
    /* 纯空白输出时不能给空字符串（调用方的 `?? \`后端退出码 …\`` 不会触发） */
    out.message = cleaned || '后端没有任何输出'
  }
  return out
}

/** 真实后端：`<后端> <app> <subcommand> <query> -f json --limit N` */
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
      const args = [...target.prefix, source.app, source.subcommand, query, '-f', 'json', '--limit', String(opts.limit)]
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
            message: enoent ? `找不到 ${target.source}（未安装或不在 PATH；可用 YAN_OPENCLI_JS 指定入口）` : e.message
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
        // 成功时是 JSON 数组；失败时 OpenCLI 回 YAML 风格的 { ok:false, error:{...} }
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

/** 解析查询：来源去重、未知来源丢掉（不报错，避免把手上的一批全废掉） */
export function normalizeQuery(
  input: SearchQuery
): { ok: true; text: string; sources: SearchSource[]; limitPerSource: number; limitTotal: number; timeoutMs: number } | { ok: false; code: string; message: string } {
  const text = (input.text ?? '').trim()
  if (!text) return { ok: false, code: 'empty_query', message: '查询词是空的' }
  if (text.length > SEARCH_QUERY_MAX) {
    return { ok: false, code: 'query_too_long', message: `查询词太长（上限 ${SEARCH_QUERY_MAX} 字）` }
  }
  const wanted = input.sources && input.sources.length > 0 ? input.sources : SEARCH_SOURCES.map((s) => s.id)
  const sources: SearchSource[] = []
  for (const id of wanted) {
    const s = byId.get(id as SearchSourceId)
    if (s && !sources.includes(s)) sources.push(s)
  }
  if (sources.length === 0) return { ok: false, code: 'no_source', message: '没有可用的搜索来源' }
  return {
    ok: true,
    text,
    sources,
    limitPerSource: clamp(input.limitPerSource, 1, SEARCH_LIMIT_PER_SOURCE_MAX, 6),
    limitTotal: clamp(input.limitTotal, 1, 40, 12),
    timeoutMs: clamp(input.timeoutMs, 1000, SEARCH_TIMEOUT_MS_MAX, 20_000)
  }
}

/**
 * 跑一次搜索：并发上限 3（再多对匿名后端只是更容易被限流），
 * 顺序仍按来源注册顺序汇报 —— 输出可预期。
 */
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
      error: { code: parsed.code, message: parsed.message }
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

  // 稳定输出顺序：按来源注册顺序，不按谁先跑完
  const order = new Map(parsed.sources.map((s, i) => [s.id, i]))
  runs.sort((a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0))

  const merged = aggregate(runs, { limitPerSource: parsed.limitPerSource, limitTotal: parsed.limitTotal })
  return {
    query: parsed.text,
    items: merged.items,
    sources: merged.sources,
    truncated: merged.truncated,
    durationMs: deps.now() - started
  }
}

/** `yan search doctor`：后端在不在、能不能用、各来源需不需要浏览器 */
export async function searchDoctor(deps: {
  runner?: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>
} = {}): Promise<SearchBackendStatus> {
  const sources = SEARCH_SOURCES.map((s) => ({
    id: s.id,
    label: s.label,
    needsBrowser: s.needsBrowser,
    ready: true
  }))
  const probe = deps.runner ?? defaultProbe
  const version = await probe(['--version'], 8000)
  if (version.code !== 0 && !version.stdout.trim()) {
    const detail = (version.stderr || version.stdout).trim().slice(0, 400)
    return {
      available: false,
      version: null,
      code: 'backend_unavailable',
      detail: detail || '找不到 opencli（未安装或不在 PATH）',
      sources
    }
  }
  const doctor = await probe(['doctor'], 20_000)
  const raw = (doctor.stdout + '\n' + doctor.stderr).trim()
  const extensionMissing = /Extension:\s*not connected/i.test(raw) || /BROWSER_CONNECT/.test(raw)
  return {
    available: true,
    version: version.stdout.trim().split('\n')[0].slice(0, 80) || null,
    detail: raw.slice(0, 1200),
    ...(extensionMissing ? { code: 'extension_not_connected' } : {}),
    sources
  }
}

/** doctor 用的最小探针（单独拿出来，便于单测替身） */
async function defaultProbe(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
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
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout?.on('data', (c: Buffer) => {
      if (out.length < 64_000) out += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      if (err.length < 64_000) err += c.toString('utf8')
    })
    child.on('error', (e: Error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: out, stderr: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: out, stderr: err })
    })
  })
}

/** 给摘要用：把一次搜索压成一行（CLI 与模型都读这个） */
export function searchSummary(outcome: SearchOutcome): string {
  const parts = [`${outcome.items.length} 条结果`, summarizeSources(outcome.sources)]
  if (outcome.truncated) parts.push('已截断')
  return parts.join(' · ')
}

export type { SearchItem, SourceRun }

/*
 * 再导出：诊断脚本与单测只编译这一个入口，
 * 所以契约常量与合并规则从一起 expose 出去（不另建 barrel 文件）。
 */
export { SEARCH_SOURCES, SEARCH_LIMIT_PER_SOURCE_MAX } from '../../shared/search'
export {
  aggregate,
  normalizeRow,
  normalizeUrlForDedupe,
  decodeEntities,
  cleanText,
  summarizeSources
} from './aggregate'
