import { runInNewContext } from 'node:vm'
import type { BrowserObservation } from '../../shared/ipc'
import { WAIT_POLL_MS, describeWait, parseWaitCondition, sameWaitElement, waitSatisfied } from '../../shared/browser-wait'
import type { BrowserActionOptions, BrowserActionReceipt } from './receipt'

export const SCRIPT_TIMEOUT_MS = 120_000
const MAX_LOG_LINES = 200
const MAX_LOG_CHARS = 20_000

type ActionResult = { ok: boolean; error?: string; code?: string; observation?: BrowserObservation; receipt?: BrowserActionReceipt }

export interface ScriptBrowser {
  navigate(url: string): Promise<{ ok: boolean; error?: string }>
  observe(): Promise<BrowserObservation>
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
}

export interface ScriptResult {
  result: unknown
  logs: string[]
  url: string
  title: string
}

export class ScriptError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ScriptError'
  }
}

export const SCRIPT_GUIDE = `砚内置浏览器脚本（yan browser run --file <脚本>）

脚本是 async 函数体，可直接 await，return 的值（需能转成 JSON）会出现在结果里；console.log 的输出也会带回。
全局只有 page、task、console、sleep(ms)；没有 require / process / fetch，也不能在网页里执行任意 JavaScript。
所有动作都作用于当前活动标签；默认 ${SCRIPT_TIMEOUT_MS / 1000} 秒超时。

page.goto(url)                         打开 http(s) 页面，返回 { url, title }
page.url() / page.title()              当前地址 / 标题
page.observe()                         { url, title, text, elements: [{ ref, role, name, value, disabled }] }
page.text()                            当前页面可见文本
page.find({ name, role, exact })       在最新观察里找元素：name 默认按包含匹配（exact: true 为全等），返回 ref 或 null
page.findAll({ name, role, exact })    同上，返回全部匹配的元素
page.click(ref, { dialog })            点击；dialog: 'accept' | 'dismiss' 决定 confirm 弹窗（默认 dismiss，alert 总是确认；window.prompt 不支持，页面拿到 null）
page.fill(ref, text)                   清空后输入；写入后的实际值在返回值的 receipt.value（日期 / 时间等控件直接写值）
page.select(ref, value)                下拉框按 value 或可见文案选择
page.press(key, { dialog })            Enter / Tab / Escape / ArrowDown / Control+A / Shift+Tab …
page.scroll(deltaY, deltaX?)           滚动，返回 { x, y, maxY }
page.waitFor({ text, url, ref, gone, timeout })  等条件成立（timeout 默认 10000ms，上限 60000）
page.back() / page.forward() / page.reload()
task.pages()                           [{ id, url, title, active }]
task.newPage(url?)                     新标签并切换过去
task.switchTo(id) / task.closePage(id?)

每个动作返回 { url, title, receipt }，字段都在 receipt 里：dialogs（弹窗及处理方式）、openedTabs（新开的标签）、downloadStarted、value、scroll。
例如 const r = await page.fill(ref, '18:30'); r.receipt.value === '18:30'。切换标签后旧标签的 ref 不能用，先 observe 或 find。
动作失败会抛出 Error，message 以错误码开头，例如 "STALE_ELEMENT: …"。ref 在同一页面上保持不变，页面导航后需要重新 observe 或 find。`

function formatLog(args: unknown[]): string {
  return args.map((arg) => {
    if (typeof arg === 'string') return arg
    try {
      return JSON.stringify(arg)
    } catch {
      return String(arg)
    }
  }).join(' ')
}

function plain(value: unknown): unknown {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function matchElements(observation: BrowserObservation, query: unknown): BrowserObservation['elements'] {
  const q = query && typeof query === 'object' ? (query as { name?: unknown; role?: unknown; exact?: unknown }) : { name: query }
  const name = typeof q.name === 'string' ? q.name.trim().toLowerCase() : ''
  const role = typeof q.role === 'string' ? q.role.trim().toLowerCase() : ''
  return observation.elements.filter((element) => {
    if (role && element.role.toLowerCase() !== role) return false
    if (!name) return true
    const own = element.name.trim().toLowerCase()
    return q.exact === true ? own === name : own.includes(name)
  })
}

export async function runBrowserScript(
  code: string,
  browser: ScriptBrowser,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ScriptResult> {
  const logs: string[] = []
  let logChars = 0
  let stopped = false
  let lastObservation: BrowserObservation | null = null

  const guard = (): void => {
    if (stopped) throw new ScriptError('script_stopped', '脚本已结束或被取消，后续动作不再执行')
  }
  const fail = (res: { ok: boolean; error?: string; code?: string }, action: string): void => {
    const message = (res.error ?? `${action} 失败`).replace(/yan browser observe/g, 'page.observe() 或 page.find()')
    if (!res.ok) throw new ScriptError(res.code ?? `${action}_failed`, `${res.code ?? `${action}_failed`}: ${message}`)
  }
  const observe = async (): Promise<BrowserObservation> => {
    guard()
    lastObservation = await browser.observe()
    return lastObservation
  }
  const act = async (action: string, run: () => Promise<ActionResult>) => {
    guard()
    const res = await run()
    fail(res, action)
    if (res.observation) lastObservation = res.observation
    const state = browser.state()
    return { url: res.observation?.url ?? state.url, title: res.observation?.title ?? state.title, receipt: (res.receipt ?? {}) as BrowserActionReceipt }
  }
  const nav = async (action: string, run: () => Promise<{ ok: boolean; error?: string }>) => {
    guard()
    fail(await run(), action)
    lastObservation = null
    const state = browser.state()
    return { url: state.url, title: state.title }
  }
  const dialogOptions = (value: unknown): BrowserActionOptions => {
    const raw = value && typeof value === 'object' ? (value as { dialog?: unknown }) : {}
    return raw.dialog === 'accept' || raw.dialog === 'dismiss' ? { dialog: raw.dialog } : {}
  }

  const page = Object.freeze({
    goto: (url: unknown) => nav('goto', () => browser.navigate(String(url ?? ''))),
    url: () => browser.state().url,
    title: () => browser.state().title,
    observe: async () => plain(await observe()),
    text: async () => (await observe()).text,
    find: async (query: unknown) => matchElements(lastObservation ?? (await observe()), query)[0]?.ref ?? null,
    findAll: async (query: unknown) => plain(matchElements(lastObservation ?? (await observe()), query)),
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
      guard()
      await browser.newTab(typeof url === 'string' && url ? url : undefined)
      lastObservation = null
      return { id: browser.state().activeTabId ?? null, url: browser.state().url }
    },
    switchTo: async (id: unknown) => {
      guard()
      await browser.switchTab(String(id ?? ''))
      lastObservation = null
      return { id: browser.state().activeTabId ?? null, url: browser.state().url }
    },
    closePage: async (id?: unknown) => {
      guard()
      await browser.closeTab(typeof id === 'string' && id ? id : undefined)
      lastObservation = null
      return { id: browser.state().activeTabId ?? null }
    }
  })

  const log = (...args: unknown[]): void => {
    if (logs.length >= MAX_LOG_LINES || logChars >= MAX_LOG_CHARS) return
    const line = formatLog(args).slice(0, MAX_LOG_CHARS - logChars)
    logChars += line.length
    logs.push(line)
  }
  const sandbox = {
    page,
    task,
    console: Object.freeze({ log, info: log, warn: log, error: log }),
    sleep: (ms: unknown) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 30_000)))
  }

  let running: Promise<unknown>
  try {
    running = runInNewContext(`(async () => {\n${code}\n})()`, sandbox, { timeout: 2_000, filename: 'browser-script.js' }) as Promise<unknown>
  } catch (error) {
    throw new ScriptError('script_error', `script_error: ${error instanceof Error ? error.message : String(error)}`)
  }

  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const limits = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ScriptError('script_timeout', `script_timeout: 脚本 ${timeoutMs / 1000} 秒没有结束，已停止后续动作`)), timeoutMs)
    onAbort = () => reject(new ScriptError('script_aborted', 'script_aborted: 脚本已取消'))
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const result = await Promise.race([running, limits])
    const state = browser.state()
    return { result: plain(result), logs, url: state.url, title: state.title }
  } catch (error) {
    if (error instanceof ScriptError) throw Object.assign(error, { logs })
    throw Object.assign(new ScriptError('script_error', `script_error: ${error instanceof Error ? error.message : String(error)}`), { logs })
  } finally {
    stopped = true
    clearTimeout(timer)
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
  }
}
