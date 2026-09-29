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
import { basename, delimiter, dirname, join } from 'node:path'
import {
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

function statForNode(p: string): { isFile: boolean; size: number } {
  try {
    const s = statSync(p)
    return { isFile: s.isFile(), size: s.size }
  } catch {
    return { isFile: false, size: -1 }
  }
}

/**
 * 找 `node` —— 只要**真正的可执行文件**。
 *
 * 两条过滤，各自对应一种把「不可用」伪装成「后端报错」的现实情况：
 *   · Windows 上不认 `.cmd` / `.bat` shim（npm 会生成；我们的 spawn 刻意不过 shell，起不来）；
 *   · 不认体积为 0 的文件（0 字节的东西必然执行不了，选中它只会让报错变形）。
 *
 * 这是**防御性**过滤，不是「保证挑到能跑的 node」：PATH 上放个坏掉的 node.exe
 * 照样会被选中 —— 那种情况靠 `YAN_NODE_BIN` 显式指定绕开。
 *
 * dirs / probe / platform 都可注入，便于单测（默认读真实 PATH 与真实 stat）。
 */
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

/** 后端的启动方式：固定 file + 前置参数（`node <entry>` 这种形态需要它） */
export interface BackendTarget {
  file: string
  prefix: string[]
  /** 给人看的说明（写进错误信息与 doctor） */
  source: string
  /** 有值时直接当「后端不可用」—— 例如 Windows 上只找到 .cmd shim 却推不出包入口 */
  error?: string
}

/** 跑 JS 入口时用哪个 Node（Electron 下要换成真正 node，见下） */
export interface JsRuntime {
  file: string
  error?: string
}

/**
 * 跑 JS 入口必须用**真正的 node**，不能用 Electron。
 *
 * 原因：OpenCLI 的入口用 commander 解析参数，而 commander 一看到
 * `process.versions.electron` 就改按 Electron 语义切参数（`argv.slice(1)`）。
 * 在 `ELECTRON_RUN_AS_NODE` 下 `argv[1]` 是脚本路径，于是 commander 把入口脚本
 * 当成了子命令（`error: unknown command '…/main.js'`）—— `<app> <sub> <query>`
 * 这类调用全部失败。更坏的是 `--version` 走的是 OpenCLI 自己的快路径
 * （自行 `slice(2)`），照样成功，所以 doctor 会一直报「已就绪」（假绿）。
 *
 * 顺序：`YAN_NODE_BIN`（显式指定）→ PATH 里的 node → 都不行就如实报不可用。
 * 最后一条很重要：不拿 Electron 硬跑，否则失败会伪装成「后端报错」。
 * 非 Electron 运行时（自带 node / 系统 node）不用换，直接用自身。
 */
/** `YAN_NODE_BIN` 填成 Electron 时提前拦下 —— 那正是我们要绕开的东西 */
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
  /*
   * 显式指定优先：GUI 启动的应用 PATH 常常很干净（尤其 macOS / Linux 桌面图标），
   * 这时 PATH 里找不到 node 是常态，必须给一条不依赖 PATH 的出路。
   */
  const explicit = nodeBin?.trim()
  if (explicit) {
    if (!fileExists(explicit)) {
      return {
        file: execPath,
        error: `YAN_NODE_BIN 指向的 ${explicit} 不存在；请改成真实的 node 可执行文件，或删掉这个变量并安装 Node.js（>=20.18.1）后加入 PATH`
      }
    }
    /* 填成 Electron 会正好踩回我们要绕开的那个坑（commander 的 electron 分支） */
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

/**
 * 找到 OpenCLI 的启动方式（实施-27 S2）。
 *
 * 为什么不直接 `spawn('opencli')`：Windows 上 npm 的全局命令是 `.cmd` shim，
 * 不经 shell 是执行不了的；而为了**不把查询词交给 shell**（注入），
 * 这里改成「找包的 JS 入口 + 用 node 跑」—— 参数仍然是数组，不过 shell。
 * 顺序：显式指定 → PATH 里的 `.cmd` 推导包入口 → PATH 里的可执行文件。
 *
 * JS 入口用哪个 node 由 `resolveJsRuntime` 决定（Electron 下必须换真实 node）。
 */
export function resolveBackendTarget(explicit?: string, runtime: JsRuntime = resolveJsRuntime()): BackendTarget {
  const js = explicit ?? process.env.YAN_OPENCLI_JS
  /* 显式给了路径：`.js` 走 node，其它当可执行文件 */
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
    /* npm 全局布局：<prefix>/opencli.cmd 与 <prefix>/node_modules/@jackwener/opencli */
    const entry = join(dirname(shim), 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')
    if (fileExists(entry)) {
      const source = runtime.file + ' ' + entry
      return runtime.error
        ? { file: runtime.file, prefix: [entry], source, error: runtime.error }
        : { file: runtime.file, prefix: [entry], source }
    }
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
 * `file` 恰好是当前进程自己的 Node 时才需要声明 `ELECTRON_RUN_AS_NODE=1`，
 * 否则 Electron 会再拉起一个**应用实例**（而不是跑那个脚本）。
 *
 * 现状：JS 入口已改走 `resolveJsRuntime()` 找到的**真实 node**，所以「Electron
 * 当 Node」那条路不再使用（真到了那一步 `resolveBackendTarget` 会带 `error`，
 * 调用方提前返回、根本不 spawn）。这里保留只是为了让 `file === process.execPath`
 * 的情形（非 Electron 进程）行为不变 —— 对 node 多一个环境变量无副作用。
 * 仓库里 protocol.ts / credentials.ts / packages.ts / yan-cli.ts 是那个口径。
 */
function spawnEnv(file: string): NodeJS.ProcessEnv | undefined {
  return file === process.execPath ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : undefined
}

/**
 * ENOENT 时给人和模型读的一句话。
 *
 * `prefix` 非空说明我们是在跑 `node <entry>` —— 那缺的是 **node**，不是 opencli；
 * 两者必须分开说，否则用户会去重装已经装好的东西。
 */
function missingBinaryMessage(target: BackendTarget): string {
  return target.prefix.length > 0
    ? `找不到运行 OpenCLI 的 node（${target.file}）；请安装 Node.js（>=20.18.1）并加入 PATH，或用 YAN_NODE_BIN 指定`
    : `找不到 ${target.file}（未安装，或不在 PATH；可用 YAN_OPENCLI_JS 指定 OpenCLI 入口）`
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

/**
 * 解析查询：来源去重、未知来源丢掉（不报错，避免把手上的一批全废掉）。
 *
 * 丢掉的名字要**原样回传**（`ignoredSources`）—— 静默丢掉等于把「没查」
 * 写成「查了没结果」。
 */
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
  const wanted = input.sources && input.sources.length > 0 ? input.sources : SEARCH_SOURCES.map((s) => s.id)
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

  // 稳定输出顺序：按来源注册顺序，不按谁先跑完
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

/** `yan search doctor`：后端在不在、能不能用、各来源需不需要浏览器 */
export async function searchDoctor(deps: {
  runner?: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>
} = {}): Promise<SearchBackendStatus> {
  /*
   * `ready` 与 `available` 同源：后端命令都跑不起来的时候，逐个来源不该报 ready ——
   * 否则 `yan search doctor` 会一边说「不可用」一边说「三个来源都就绪」。
   */
  const sourcesFor = (available: boolean) =>
    SEARCH_SOURCES.map((s) => ({ id: s.id, label: s.label, needsBrowser: s.needsBrowser, ready: available }))
  const probe = deps.runner ?? defaultProbe
  const version = await probe(['--version'], 8000)
  if (version.code !== 0 && !version.stdout.trim()) {
    /* 超时与「没这个命令」要分开：前者可能是 PATH 上的命令卡住，不是没装 */
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
  /*
   * `--version` 只证明命令能启动；doctor 的输出才证明**这条调用链**是通的
   * （参数没错位、子命令真跑完了）。三种必须报不可用的情况：
   *   · 探针完全没输出 —— 命令起不来；
   *   · 输出是 commander 的未知命令 / 用法帮助 —— 参数错位（假绿的根因）；
   *   · 探针**超时**（哪怕已经打出了头部）—— `--version` 比 doctor 浅得多，
   *     不能因为头部已经出来就写「已就绪」。
   * 反过来，这里刻意不要求「输出里必须出现某个完成标志」：那等于把可用性
   * 押在 OpenCLI 的输出格式上，上游改一次文案就会误报。
   */
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

/** doctor 用的最小探针（单独拿出来，便于单测替身） */
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
    /* 超时要说出来：只凭「有输出」判不了「跑完了没」 */
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
      /* 僵死进程不响应 kill 时不能把 Promise 悬在那里：再等 1s 强制收尾 */
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

/** 给摘要用：把一次搜索压成一行（CLI 与模型都读这个） */
export function searchSummary(outcome: SearchOutcome): string {
  const parts = [`${outcome.items.length} 条结果`, summarizeSources(outcome.sources)]
  if (outcome.truncated) parts.push('已截断')
  /* 被丢掉的来源名要说出来，不然「没查」看起来就像「查了没结果」 */
  if (outcome.ignoredSources?.length) parts.push(`已忽略未知来源：${outcome.ignoredSources.join('、')}`)
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

/** 用户在设置页点「安装 OpenCLI」时的结果；error 是给用户看的句子 */
export interface OpenCliInstallResult {
  ok: boolean
  /** 找不到 npm（通常是没装 Node.js）：界面据此给出 Node.js 下载入口 */
  needsNode?: boolean
  error?: string
  /** npm 输出的最后几行，失败时给用户看原因 */
  log?: string
}

/**
 * 用户明确点了「安装」才会调用：`npm install -g @jackwener/opencli`。
 * 参数数组、不拼 shell；Windows 上 npm 是 .cmd，必须经 cmd.exe 启动（参数都是常量）。
 * 超时 5 分钟；输出只留尾部。
 */
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
