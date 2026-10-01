/**
 * Bing 网页搜索来源。
 *
 * 中文查询走 zh-CN 市场并固定 `cc=CN`，否则匿名窗口里会拿到「无结果」页；
 * 英文不加地区参数（加 `cc=US` 反而会出空页）。
 */
import type { SourceRun } from './aggregate'
import { runWebEngine, type WebEngine } from './web-engine'

export type SearchLocale = 'zh' | 'en'

/** 含汉字（或日韩文）就按中文市场查 */
export function detectLocale(query: string): SearchLocale {
  return /[぀-ヿ㐀-鿿가-힯]/.test(query) ? 'zh' : 'en'
}

interface Raw {
  title: string
  href: string
  snippet: string
}

/** Bing 的跳转链接 `/ck/a?...&u=a1<base64url>` 还原成真实地址；还原不了就原样返回 */
export function decodeBingRedirect(href: string): string {
  try {
    const url = new URL(href, 'https://www.bing.com')
    if (!/(^|\.)bing\.com$/i.test(url.hostname) || !url.pathname.startsWith('/ck/')) return href
    const u = url.searchParams.get('u')
    if (!u || !u.startsWith('a1')) return href
    const decoded = Buffer.from(u.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return /^https?:\/\//i.test(decoded) ? decoded : href
  } catch {
    return href
  }
}

const SCRIPT = `(() => {
  const items = [...document.querySelectorAll('li.b_algo')].map((li) => {
    const a = li.querySelector('h2 a')
    const p = li.querySelector('.b_caption p, p.b_lineclamp2, p')
    return a ? { title: a.textContent || '', href: a.href || '', snippet: p ? p.textContent || '' : '' } : null
  }).filter(Boolean)
  const text = document.body ? document.body.innerText : ''
  const captcha = items.length === 0 && /captcha|验证码|unusual traffic|人机验证/i.test(text)
  const none = !!document.querySelector('.b_no')
  return { items, captcha, none }
})()`

export function bingUrl(query: string, limit: number, locale: SearchLocale): string {
  const count = Math.min(50, Math.max(limit, 10))
  const market = locale === 'zh' ? '&setmkt=zh-CN&setlang=zh-Hans&cc=CN' : ''
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}${market}`
}

export function runBingSearch(
  query: string,
  opts: { limit: number; timeoutMs: number },
  locale: SearchLocale = detectLocale(query)
): Promise<SourceRun> {
  const engine: WebEngine<Raw> = {
    source: 'bing',
    label: 'Bing',
    url: bingUrl(query, opts.limit, locale),
    script: SCRIPT,
    toRow: (r) => ({ title: r.title, url: decodeBingRedirect(r.href), snippet: r.snippet })
  }
  return runWebEngine(engine, opts)
}
