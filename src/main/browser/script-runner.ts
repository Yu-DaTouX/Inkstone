import { spawn, type ChildProcess } from 'node:child_process'
import type { BrowserObservation } from '../../shared/ipc'
import { WAIT_POLL_MS, describeWait, parseWaitCondition, sameWaitElement, waitSatisfied } from '../../shared/browser-wait'
import type { BrowserActionOptions, BrowserActionReceipt, BrowserObserveOptions } from './receipt'
import { ALL_ITEM_LIMIT, ITEM_LIMIT, diffObservations, elementLine, filterElements } from './observation-format'
import { SCRIPT_WORKER_SOURCE } from './script-worker'

export const SCRIPT_TIMEOUT_MS = 120_000
const MAX_LOG_LINES = 200
const MAX_LOG_CHARS = 20_000
const STATE_PUSH_MS = 200
const STDERR_TAIL_CHARS = 500
const RUNTIME_IDLE_MS = 10 * 60_000
const MAX_RUNTIMES = 4
const PROBE_MS = 1000

type ActionResult = { ok: boolean; error?: string; code?: string; observation?: BrowserObservation; receipt?: BrowserActionReceipt }

export interface ScriptBrowser {
  navigate(url: string): Promise<{ ok: boolean; error?: string }>
  observe(options?: BrowserObserveOptions): Promise<BrowserObservation>
  text?(): Promise<{ text: string; url: string; title: string }>
  scope?(): string
  click(ref: string, options?: BrowserActionOptions): Promise<ActionResult>
  type(ref: string, text: string, options?: BrowserActionOptions): Promise<ActionResult>
  select(ref: string, value: string, options?: BrowserActionOptions): Promise<ActionResult>
  press(key: string, options?: BrowserActionOptions): Promise<ActionResult>
  scroll(deltaX: number, deltaY: number): Promise<ActionResult>
  back(): Promise<{ ok: boolean; error?: string }>
  forward(): Promise<{ ok: boolean; error?: string }>
  reload(): Promise<{ ok: boolean; error?: string }>
  state(): { url: string; title: string; activeTabId?: string | null; tabs?: { id: string; url: string; title: string }[] }
  newTab(url?: string): Promise<unknown>
  switchTab(id: string): Promise<unknown>
  closeTab(id?: string): Promise<unknown>
  evaluate?(expression: string): Promise<unknown>
}

const LOCAL_PAGE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
export const EVALUATE_RESULT_MAX_CHARS = 1_000_000

export function isLocalPageUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_PAGE_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

export function localEvaluateExpression(expression: string): string {
  return `(async () => { const l = location; const p = l.protocol; const h = l.hostname; if (!((p === 'http:' || p === 'https:') && (h === 'localhost' || h === '127.0.0.1' || h === '[::1]'))) return { denied: true, url: l.href }; return { denied: false, value: await (${expression}\n) } })()`
}

export interface ScriptResult {
  result: unknown
  logs: string[]
  url: string
  title: string
  runtime?: 'new' | 'kept'
}

export class ScriptError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ScriptError'
  }
}

export const SCRIPT_GUIDE = `砚内置浏览器脚本（yan browser run --code - <<'JS' … JS，或 --file <脚本>）

脚本是 async 函数体，可直接 await，return 的值（需能转成 JSON）会出现在结果里；console.log 的输出也会带回。
全局只有 page、task、console、sleep(ms)；没有 require / process / fetch。只有本机地址（localhost、127.0.0.1、[::1]）的页面可以用 page.evaluate 在网页里执行 JavaScript。
所有动作都作用于当前活动标签；默认 ${SCRIPT_TIMEOUT_MS / 1000} 秒超时。
同一会话里，挂在 globalThis 上的变量（如 globalThis.rows = …）在下一次 run 里还在，前提是期间没有导航、换标签或页面换文档；
结果的 runtime 为 new 表示变量已清空，kept 表示沿用。

page.goto(url)                         打开 http(s) 页面，返回 { url, title }
page.url() / page.title()              当前地址 / 标题
page.snapshot({ all, find, role, in }) 文本快照：每行「ref 角色 "名称" =值」；默认只列视口内，all: true 含视口外，in: ref 只看该元素内部
page.observe({ all, in })              { url, title, text, elements: [{ ref, role, name, value, disabled, offscreen }] }
page.text()                            全部可见文本；page.text({ offset, maxChars }) 分段；page.text({ find: '文字' 或 /正则/ }) 返回 [{ offset, snippet }]
page.find(q) / page.findAll(q)         按文字找元素：q 是字符串（名称或值包含，不分大小写）、正则，或 { name, text, regex, role, exact }；
                                       find 返回 ref 或 null（最新观察里没有时自动重新观察一次），findAll 返回全部匹配的元素
click / fill / select 的目标可以是 ref，也可以直接写查询（同 find，如 { role: 'button', name: '登录' } 或 /^搜索$/）：
                                       恰好匹配一个才动作，匹配多个报 AMBIGUOUS_TARGET，没有匹配报 TARGET_NOT_FOUND
page.click(ref, { dialog })            点击；dialog: 'accept' | 'dismiss' 决定 confirm 弹窗（默认 dismiss，alert 总是确认；window.prompt 不支持，页面拿到 null）
                                       被别的元素挡住时不点，抛出 ELEMENT_OBSCURED 并写明遮挡者
page.fill(ref, text)                   清空后输入；写入后的实际值在返回值的 receipt.value（日期 / 时间等控件直接写值）
page.select(ref, value)                下拉框按 value 或可见文案选择
page.press(key, { dialog })            Enter / Tab / Escape / ArrowDown / Control+A / Shift+Tab …
page.scroll(deltaY, deltaX?)           滚动，返回 { x, y, maxY }
page.waitFor({ text, url, ref, gone, timeout })  等条件成立（timeout 默认 10000ms，上限 60000）
page.evaluate(fn, arg?) / page.evaluate('表达式')  只限本机地址的页面：在当前标签的主框架里执行，可返回 Promise，返回值需能转成 JSON；
                                       fn 按源码送进页面，拿不到脚本里的变量，要用的值从 arg 传（需能转成 JSON）。
                                       例：await page.evaluate(() => app.graphToPrompt())；其他网站报 EVALUATE_NOT_LOCAL
page.back() / page.forward() / page.reload()
task.pages()                           [{ id, url, title, active }]
task.newPage(url?)                     新标签并切换过去
task.switchTo(id) / task.closePage(id?)

click / fill / select / press 返回 { url, title, receipt, changes }：changes 是动作前后的变化摘要（地址、标题、新增 + / 消失 - / 改变 ~ 的元素、新出现的文字，最多 15 行）；
receipt 里有 dialogs（弹窗及处理方式）、openedTabs（新开的标签）、downloadStarted、value；scroll 直接返回位置。
一段脚本通常做完「打开 → 操作 → 等到最终状态」，最后 return 要核对的值或 page.snapshot()，下一步直接用；中途只在结果会改变下一步时观察。例如：
  await page.goto('https://example.com/search')
  await page.fill({ role: 'searchbox' }, 'alpha')
  const r = await page.click(/^搜索$/)
  return { changes: r.changes, hits: await page.text({ find: 'alpha' }) }
切换标签后旧标签的 ref 不能用，先 snapshot 或 find。
动作失败会抛出 Error，message 以错误码开头，例如 "STALE_ELEMENT: …"。ref 在同一页面上保持不变，页面导航后需要重新 snapshot 或 find。`

function plain(value: unknown): unknown {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

interface Runtime {
  child: ChildProcess
  key: string | null
  scope: string
  busy: boolean
  lastUsed: number
  ready: Promise<void>
  pong: ((id: number) => void) | null
  stderrTail: string
  idle?: ReturnType<typeof setTimeout>
  listener: ((message: Record<string, unknown>) => void) | null
  onError: ((error: Error) => void) | null
  onExit: ((code: number | null) => void) | null
}

const runtimes = new Map<string, Runtime>()
let runSequence = 0

function spawnRuntime(key: string | null): Runtime {
  const permission = process.allowedNodeEnvironmentFlags?.has('--permission') ? ['--permission'] : []
  const child = spawn(process.execPath, [...permission, '-e', SCRIPT_WORKER_SOURCE], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
    env: { ELECTRON_RUN_AS_NODE: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
  })
  let markReady: () => void = () => undefined
  const runtime: Runtime = {
    child,
    key,
    scope: '',
    busy: false,
    lastUsed: Date.now(),
    ready: new Promise<void>((resolve) => { markReady = resolve }),
    pong: null,
    stderrTail: '',
    listener: null,
    onError: null,
    onExit: null
  }
  child.stderr?.on('data', (chunk: Buffer) => { runtime.stderrTail = (runtime.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS) })
  child.on('message', (raw) => {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.type === 'ready') markReady()
    else if (message.type === 'pong') runtime.pong?.(Number(message.id))
    else runtime.listener?.(message)
  })
  child.on('error', (error) => runtime.onError?.(error))
  child.once('exit', (code) => {
    if (key !== null && runtimes.get(key) === runtime) runtimes.delete(key)
    if (runtime.idle) clearTimeout(runtime.idle)
    runtime.onExit?.(code)
  })
  if (key !== null) {
    runtimes.set(key, runtime)
    trimRuntimes(runtime)
  }
  return runtime
}

function trimRuntimes(keep: Runtime): void {
  const idle = [...runtimes.values()].filter((runtime) => runtime !== keep && !runtime.busy).sort((a, b) => a.lastUsed - b.lastUsed)
  while (runtimes.size > MAX_RUNTIMES && idle.length) killRuntime(idle.shift()!)
}

let probeSequence = 0

function responsive(runtime: Runtime): Promise<boolean> {
  const id = ++probeSequence
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      runtime.pong = null
      resolve(false)
    }, PROBE_MS)
    runtime.pong = (answered) => {
      if (answered !== id) return
      clearTimeout(timer)
      runtime.pong = null
      resolve(true)
    }
    if (runtime.child.connected) runtime.child.send({ type: 'ping', id }, () => undefined)
  })
}

function killRuntime(runtime: Runtime): void {
  if (runtime.idle) clearTimeout(runtime.idle)
  if (runtime.key !== null && runtimes.get(runtime.key) === runtime) runtimes.delete(runtime.key)
  runtime.listener = null
  runtime.onError = null
  runtime.onExit = null
  runtime.child.kill()
}

export function disposeScriptRuntimes(key?: string): void {
  for (const runtime of [...runtimes.values()]) if (key === undefined || runtime.key === key) killRuntime(runtime)
}

export function scriptRuntimeCount(): number {
  return runtimes.size
}

async function acquireRuntime(key: string | undefined, scope: string): Promise<{ runtime: Runtime; fresh: boolean }> {
  if (key === undefined) return { runtime: spawnRuntime(null), fresh: true }
  const existing = runtimes.get(key)
  if (existing && existing.busy) return { runtime: spawnRuntime(null), fresh: true }
  if (existing && existing.scope === scope && existing.child.exitCode === null && existing.child.connected) {
    if (existing.idle) clearTimeout(existing.idle)
    existing.busy = true
    const alive = await responsive(existing)
    existing.busy = false
    if (alive && runtimes.get(key) === existing) {
      existing.lastUsed = Date.now()
      return { runtime: existing, fresh: false }
    }
  }
  if (existing) killRuntime(existing)
  return { runtime: spawnRuntime(key), fresh: true }
}

function snapshotText(observation: BrowserObservation, options: Record<string, unknown>): string {
  const find = typeof options.find === 'string' ? options.find : undefined
  const role = typeof options.role === 'string' ? options.role : undefined
  const scoped = typeof options.in === 'string' && options.in.trim() !== ''
  const all = options.all === true
  const matched = filterElements(observation.elements, { find, role, all, ...(scoped ? { scopeRefs: observation.scopeRefs ?? [] } : {}) })
  const limit = all || find || scoped ? ALL_ITEM_LIMIT : ITEM_LIMIT
  const lines = [`url: ${observation.url}`, `title: ${observation.title}`, ...matched.slice(0, limit).map(elementLine)]
  if (matched.length > limit) lines.push(`… 另有 ${matched.length - limit} 个元素`)
  const offscreen = all || find || scoped ? 0 : observation.elements.filter((element) => element.offscreen).length
  if (offscreen) lines.push(`（视口外还有 ${offscreen} 个元素：snapshot({ all: true }) 或 find）`)
  return lines.join('\n')
}

export async function runBrowserScript(
  code: string,
  browser: ScriptBrowser,
  options: { signal?: AbortSignal; timeoutMs?: number; beforeAction?: () => void; persistKey?: string; withSession?: <T>(work: () => T) => T } = {}
): Promise<ScriptResult> {
  const logs: string[] = []
  let logChars = 0
  let stopped = false
  let lastObservation: BrowserObservation | null = null
  const runId = ++runSequence

  const guard = (): void => {
    if (stopped) throw new ScriptError('script_stopped', '脚本已结束或被取消，后续动作不再执行')
  }
  const actionGuard = (): void => {
    guard()
    options.beforeAction?.()
  }
  const fail = (res: { ok: boolean; error?: string; code?: string }, action: string): void => {
    const message = (res.error ?? `${action} 失败`).replace(/yan browser observe/g, 'page.snapshot() 或 page.find()')
    if (!res.ok) throw new ScriptError(res.code ?? `${action}_failed`, `${res.code ?? `${action}_failed`}: ${message}`)
  }
  const observeOptions = (value: unknown): BrowserObserveOptions | undefined => {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    const scope = typeof raw.in === 'string' && raw.in.trim() ? raw.in.trim() : undefined
    const all = raw.all === true || (typeof raw.find === 'string' && raw.find.trim() !== '')
    return all || scope ? { ...(all ? { all } : {}), ...(scope ? { scope } : {}) } : undefined
  }
  const observe = async (value?: unknown): Promise<BrowserObservation> => {
    guard()
    const wanted = observeOptions(value)
    lastObservation = wanted ? await browser.observe(wanted) : await browser.observe()
    return lastObservation
  }
  const act = async (action: string, run: () => Promise<ActionResult>) => {
    actionGuard()
    const before = lastObservation
    const res = await run()
    fail(res, action)
    if (res.observation) lastObservation = res.observation
    const state = browser.state()
    return {
      url: res.observation?.url ?? state.url,
      title: res.observation?.title ?? state.title,
      receipt: (res.receipt ?? {}) as BrowserActionReceipt,
      ...(res.observation ? { changes: diffObservations(before ?? undefined, res.observation) } : {})
    }
  }
  const nav = async (action: string, run: () => Promise<{ ok: boolean; error?: string }>) => {
    actionGuard()
    fail(await run(), action)
    lastObservation = null
    const state = browser.state()
    return { url: state.url, title: state.title }
  }
  const dialogOptions = (value: unknown): BrowserActionOptions => {
    const raw = value && typeof value === 'object' ? (value as { dialog?: unknown }) : {}
    return raw.dialog === 'accept' || raw.dialog === 'dismiss' ? { dialog: raw.dialog } : {}
  }
  const pageText = async (): Promise<string> => {
    guard()
    if (browser.text) return (await browser.text()).text
    return (await observe()).text
  }

  const page = Object.freeze({
    goto: (url: unknown) => nav('goto', () => browser.navigate(String(url ?? ''))),
    url: () => browser.state().url,
    title: () => browser.state().title,
    observe: async (value?: unknown) => plain(await observe(value)),
    snapshot: async (value?: unknown) => snapshotText(await observe(value), value && typeof value === 'object' ? (value as Record<string, unknown>) : {}),
    elements: async (value?: unknown) => {
      const fresh = Boolean(value && typeof value === 'object' && (value as { fresh?: unknown }).fresh === true)
      const observation = fresh || !lastObservation ? await observe({ all: true }) : lastObservation
      return plain(observation.elements)
    },
    text: pageText,
    evaluate: async (expression: unknown) => {
      actionGuard()
      if (!browser.evaluate) throw new ScriptError('EVALUATE_UNSUPPORTED', 'EVALUATE_UNSUPPORTED: 当前浏览器不支持 page.evaluate')
      if (typeof expression !== 'string' || !expression.trim()) throw new ScriptError('EVALUATE_INVALID', 'EVALUATE_INVALID: page.evaluate 需要一个函数或表达式')
      const state = browser.state()
      if (!isLocalPageUrl(state.url)) throw new ScriptError('EVALUATE_NOT_LOCAL', `EVALUATE_NOT_LOCAL: page.evaluate 只能在本机地址（localhost、127.0.0.1、[::1]）的页面里用，当前是 ${state.url || '空白页'}`)
      const value = await browser.evaluate(expression)
      lastObservation = null
      return value
    },
    click: (ref: unknown, opts?: unknown) => act('click', () => browser.click(String(ref ?? ''), dialogOptions(opts))),
    fill: (ref: unknown, text: unknown, opts?: unknown) => act('fill', () => browser.type(String(ref ?? ''), String(text ?? ''), dialogOptions(opts))),
    select: (ref: unknown, value: unknown) => act('select', () => browser.select(String(ref ?? ''), String(value ?? ''))),
    press: (key: unknown, opts?: unknown) => act('press', () => browser.press(String(key ?? ''), dialogOptions(opts))),
    scroll: async (deltaY: unknown, deltaX?: unknown) => (await act('scroll', () => browser.scroll(Number(deltaX ?? 0), Number(deltaY ?? 0)))).receipt.scroll ?? null,
    back: () => nav('back', () => browser.back()),
    forward: () => nav('forward', () => browser.forward()),
    reload: () => nav('reload', () => browser.reload()),
    waitFor: async (condition: unknown) => {
      const parsed = parseWaitCondition(condition && typeof condition === 'object' ? (condition as Record<string, unknown>) : { text: condition })
      if (!parsed.ok) throw new ScriptError(parsed.code, `${parsed.code}: ${parsed.message}`)
      const target = parsed.condition.ref ? lastObservation?.elements.find((element) => element.ref === parsed.condition.ref) : undefined
      const matches = target ? sameWaitElement(target) : undefined
      const deadline = Date.now() + parsed.timeoutMs
      let last: BrowserObservation | null = null
      while (Date.now() <= deadline) {
        last = await observe()
        if (waitSatisfied(parsed.condition, last, matches)) return { url: last.url, title: last.title }
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
      }
      throw new ScriptError('wait_timeout', `wait_timeout: 等了 ${parsed.timeoutMs}ms 还不满足（${describeWait(parsed.condition)}）。最后看到：${last ? `${last.url} ${last.text.slice(0, 120)}` : '无'}`)
    }
  })

  const task = Object.freeze({
    pages: () => {
      const state = browser.state()
      return (state.tabs ?? []).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.id === state.activeTabId }))
    },
    newPage: async (url?: unknown) => {
      actionGuard()
      await browser.newTab(typeof url === 'string' && url ? url : undefined)
      lastObservation = null
      return { id: browser.state().activeTabId ?? null, url: browser.state().url }
    },
    switchTo: async (id: unknown) => {
      actionGuard()
      await browser.switchTab(String(id ?? ''))
      lastObservation = null
      return { id: browser.state().activeTabId ?? null, url: browser.state().url }
    },
    closePage: async (id?: unknown) => {
      actionGuard()
      await browser.closeTab(typeof id === 'string' && id ? id : undefined)
      lastObservation = null
      return { id: browser.state().activeTabId ?? null }
    }
  })

  const log = (text: string): void => {
    if (logs.length >= MAX_LOG_LINES || logChars >= MAX_LOG_CHARS) return
    const line = text.slice(0, MAX_LOG_CHARS - logChars)
    logChars += line.length
    logs.push(line)
  }
  const sleep = (ms: unknown): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 30_000)))
  const { url: _url, title: _title, ...pageCalls } = page
  const { pages: _pages, ...taskCalls } = task
  const calls = new Map<string, (...args: never[]) => unknown>([
    ...Object.entries(pageCalls).map(([name, fn]) => [`page.${name}`, fn] as [string, (...args: never[]) => unknown]),
    ...Object.entries(taskCalls).map(([name, fn]) => [`task.${name}`, fn] as [string, (...args: never[]) => unknown]),
    ['sleep', sleep]
  ])

  const scopeOf = (): string => {
    try {
      return browser.scope?.() ?? ''
    } catch {
      return ''
    }
  }
  const { runtime, fresh } = await acquireRuntime(options.persistKey, scopeOf())
  runtime.busy = true
  const tell = (message: Record<string, unknown>): void => {
    if (runtime.child.connected) runtime.child.send(message, () => undefined)
  }
  const pushState = (): void => {
    if (stopped) return
    try {
      const state = browser.state()
      tell({ type: 'state', state: JSON.stringify({ url: state.url, title: state.title, pages: task.pages() }) })
    } catch {
    }
  }
  const handleCall = async (id: unknown, method: unknown, args: unknown): Promise<void> => {
    let reply: Record<string, unknown>
    try {
      const fn = typeof method === 'string' ? calls.get(method) : undefined
      const list = typeof args === 'string' ? JSON.parse(args) as unknown : null
      if (!fn || !Array.isArray(list)) throw new ScriptError('script_error', `script_error: unknown call ${String(method)}`)
      const invoke = () => (fn as (...items: unknown[]) => unknown)(...list)
      const value = await (options.withSession ? options.withSession(invoke) : invoke())
      reply = { ok: true, ...(value === undefined ? {} : { value: JSON.stringify(plain(value)) }) }
    } catch (error) {
      const code = error instanceof ScriptError ? error.code : (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined)
      reply = { ok: false, ...(code ? { code } : {}), message: error instanceof Error ? error.message : String(error) }
    }
    if (stopped) return
    pushState()
    tell({ type: 'reply', run: runId, id, ...reply })
  }

  let keep = options.persistKey !== undefined
  const running = new Promise<unknown>((resolve, reject) => {
    runtime.listener = (message) => {
      if (stopped || message.run !== runId) return
      if (message.type === 'call') void handleCall(message.id, message.method, message.args)
      else if (message.type === 'log' && typeof message.line === 'string') log(message.line)
      else if (message.type === 'done') {
        try {
          resolve(JSON.parse(String(message.result)))
        } catch {
          resolve(null)
        }
      } else if (message.type === 'failed') {
        const text = String(message.message ?? '')
        reject(typeof message.code === 'string' ? new ScriptError(message.code, text) : new ScriptError('script_error', `script_error: ${text}`))
      }
    }
    runtime.onError = (error) => {
      keep = false
      reject(new ScriptError('script_error', `script_error: ${error.message}`))
    }
    runtime.onExit = (exitCode) => {
      keep = false
      reject(new ScriptError('script_error', `script_error: script process exited early (${exitCode ?? '?'})${runtime.stderrTail ? `: ${runtime.stderrTail}` : ''}`))
    }
    void runtime.ready.then(() => {
      if (stopped) return
      pushState()
      tell({ type: 'start', run: runId, code })
    })
  })
  const statePush = setInterval(pushState, STATE_PUSH_MS)

  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const limits = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      keep = false
      reject(new ScriptError('script_timeout', `script_timeout: 脚本 ${timeoutMs / 1000} 秒没有结束，已停止后续动作`))
    }, timeoutMs)
    onAbort = () => {
      keep = false
      reject(new ScriptError('script_aborted', 'script_aborted: 脚本已取消'))
    }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const result = await Promise.race([running, limits])
    const state = browser.state()
    return { result: plain(result), logs, url: state.url, title: state.title, ...(options.persistKey !== undefined ? { runtime: fresh ? 'new' as const : 'kept' as const } : {}) }
  } catch (error) {
    if (error instanceof ScriptError) throw Object.assign(error, { logs })
    throw Object.assign(new ScriptError('script_error', `script_error: ${error instanceof Error ? error.message : String(error)}`), { logs })
  } finally {
    stopped = true
    clearInterval(statePush)
    clearTimeout(timer)
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
    runtime.busy = false
    runtime.listener = null
    runtime.onError = null
    runtime.onExit = null
    if (keep && runtime.key !== null && runtime.child.exitCode === null && runtime.child.connected) {
      tell({ type: 'end', run: runId })
      runtime.scope = scopeOf()
      runtime.lastUsed = Date.now()
      runtime.idle = setTimeout(() => killRuntime(runtime), RUNTIME_IDLE_MS)
      runtime.idle.unref?.()
    } else {
      killRuntime(runtime)
    }
  }
}
