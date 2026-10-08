/**
 * 读网页正文：搜到结果之后，把一个页面读成可直接引用的文本。
 *
 * 和搜索引擎来源一样在隐藏页面里加载（JS 渲染的页面也能读到），不带用户的登录态，
 * 不碰内置浏览器标签；本机与内网地址在请求层被拦（含域名解析到内网的情况）。
 * 需要登录或交互的页面应改用 `yan browser`。
 */
import { isLinkLocalHost, isPrivateHost } from '../browser/network-boundary'
import { HiddenPageTimeout, sleepUnlessAborted, withHiddenPage } from './hidden-page'

export const READ_PAGE_MAX_CHARS_DEFAULT = 12_000
export const READ_PAGE_MAX_CHARS_MAX = 40_000

export interface ReadPageResult {
  url: string
  finalUrl: string
  title: string
  text: string
  /** 正文被 maxChars 截断了（原文更长） */
  truncated: boolean
  /** 页面原文长度（字符） */
  totalChars: number
}

export class ReadPageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/**
 * 优先取 article / main 里文字最多的那个；砍掉导航、页脚、脚本等噪声。
 * 但站点常把「课程推广卡片」之类也做成 article —— 候选的文字不到整页的一半时，退回整页。
 */
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
  if (isPrivateHost(url.hostname) || isLinkLocalHost(url.hostname)) {
    throw new ReadPageError('private_host', '不读取本机或内网地址（本机预览请用 yan browser）')
  }
  return url.toString()
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
      void win.loadURL(url).catch((e: Error) => {
        if (!/ERR_ABORTED/.test(e.message)) loadError = e.message
      })
      type Snapshot = { title: string; finalUrl: string; text: string; state: string }
      let last = null as Snapshot | null
      let stable = 0
      let prevLen = -1
      for (;;) {
        /* 超时后 withHiddenPage 会 abort：这里立刻退出，不再在已销毁窗口上轮询 */
        if (signal.aborted) throw new HiddenPageTimeout(timeoutMs)
        if (loadError) throw new ReadPageError('network_error', loadError)
        try {
          last = (await win.webContents.executeJavaScript(EXTRACT)) as Snapshot
        } catch {
          /* 正在跳转 */
        }
        if (last && last.text.length > 0 && last.finalUrl !== 'about:blank') {
          /* 加载完成，或正文长度连续几次不再变化（慢脚本拖住 load 事件时也能交卷） */
          stable = last.text.length === prevLen ? stable + 1 : 0
          prevLen = last.text.length
          if (last.state === 'complete' || stable >= 4) break
        }
        await sleepUnlessAborted(400, signal)
      }
      const done = last as Snapshot
      const text = done.text
      return {
        url,
        finalUrl: done.finalUrl,
        title: done.title.trim(),
        text: text.length > maxChars ? text.slice(0, maxChars) : text,
        truncated: text.length > maxChars,
        totalChars: text.length
      }
    })
  } catch (e) {
    if (e instanceof ReadPageError) throw e
    if (e instanceof HiddenPageTimeout) throw new ReadPageError('timeout', e.message)
    throw new ReadPageError('network_error', e instanceof Error ? e.message : String(e))
  }
}
