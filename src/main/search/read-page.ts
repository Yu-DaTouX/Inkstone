import { isLinkLocalHost, isPrivateHost } from '../browser/network-boundary'
import { HiddenPageTimeout, sleepUnlessAborted, withHiddenPage } from './hidden-page'

export const READ_PAGE_MAX_CHARS_DEFAULT = 12_000
export const READ_PAGE_MAX_CHARS_MAX = 40_000

export interface ReadPageResult {
  url: string
  finalUrl: string
  title: string
  text: string
  truncated: boolean
  totalChars: number
}

export class ReadPageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const EXTRACT = `(() => {
  const drop = 'script,style,noscript,nav,header,footer,aside,form,iframe,svg,[role=navigation],[aria-hidden=true]'
  const clean = (el) => {
    const c = el.cloneNode(true)
    c.querySelectorAll(drop).forEach((n) => n.remove())
    return (c.innerText || c.textContent || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
  }
  const whole = clean(document.body || document.documentElement)
  const best = [...document.querySelectorAll('article, main, [role=main]')].map(clean).sort((x, y) => y.length - x.length)[0] || ''
  const text = best.length >= whole.length * 0.5 ? best : whole
  return { title: document.title || '', finalUrl: location.href, text, state: document.readyState }
})()`

export function normalizeReadUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ReadPageError('bad_url', '不是合法的网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ReadPageError('bad_url', '只支持 http(s) 网页')
  if (url.username || url.password) throw new ReadPageError('bad_url', '网址不能包含用户名或密码')
  if (isPrivateHost(url.hostname) || isLinkLocalHost(url.hostname)) {
    throw new ReadPageError('private_host', '不读取本机或内网地址（本机预览请用 yan browser）')
  }
  return url.toString()
}

export function assertReadablePage(page: ReadPageResult): ReadPageResult {
  if (!page.text.trim()) throw new ReadPageError('empty_content', '网页没有可读取的正文')
  const title = page.title.trim()
  if (
    /^(?:just a moment\.*|attention required!?(?:\s*\|\s*cloudflare)?|access denied|403 forbidden|429 too many requests|verify (?:you are|you're) human|访问被拒绝|安全验证|人机验证|请完成安全验证)$/i.test(title) &&
    /captcha|cloudflare|verify|verification|denied|forbidden|security|checking your browser|验证|访问被拒绝|权限不足/i.test(page.text.slice(0, 2000))
  ) throw new ReadPageError('access_blocked', '网页返回了验证或访问拒绝页面，未取得正文')
  return page
}

export async function readPage(
  rawUrl: string,
  opts: { maxChars?: number; timeoutMs?: number } = {}
): Promise<ReadPageResult> {
  const url = normalizeReadUrl(rawUrl)
  const maxChars = Math.min(READ_PAGE_MAX_CHARS_MAX, Math.max(500, Math.round(opts.maxChars ?? READ_PAGE_MAX_CHARS_DEFAULT)))
  const timeoutMs = Math.min(60_000, Math.max(3_000, Math.round(opts.timeoutMs ?? 20_000)))
  try {
    return await withHiddenPage(timeoutMs, async (win, signal) => {
      let loadError = ''
      let status = 0
      win.webContents.on('did-navigate', (_event, _url, code) => { status = code })
      void win.loadURL(url).catch((e: Error) => {
        if (!/ERR_ABORTED/.test(e.message)) loadError = e.message
      })
      type Snapshot = { title: string; finalUrl: string; text: string; state: string }
      let last = null as Snapshot | null
      let stable = 0
      let prevLen = -1
      for (;;) {
        if (signal.aborted) throw new HiddenPageTimeout(timeoutMs)
        if (loadError) throw new ReadPageError('network_error', loadError)
        if (status >= 400) throw new ReadPageError('http_error', `网页返回 HTTP ${status}，未取得正文`)
        try {
          last = (await win.webContents.executeJavaScript(EXTRACT)) as Snapshot
        } catch {
        }
        if (last && last.text.length > 0 && last.finalUrl !== 'about:blank') {
          stable = last.text.length === prevLen ? stable + 1 : 0
          prevLen = last.text.length
          if (last.state === 'complete' || stable >= 4) break
        }
        await sleepUnlessAborted(400, signal)
      }
      const done = last as Snapshot
      const text = done.text
      return assertReadablePage({
        url,
        finalUrl: normalizeReadUrl(done.finalUrl),
        title: done.title.trim(),
        text: text.length > maxChars ? text.slice(0, maxChars) : text,
        truncated: text.length > maxChars,
        totalChars: text.length
      })
    })
  } catch (e) {
    if (e instanceof ReadPageError) throw e
    if (e instanceof HiddenPageTimeout) throw new ReadPageError('timeout', e.message)
    throw new ReadPageError('network_error', e instanceof Error ? e.message : String(e))
  }
}
