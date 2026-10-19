import type { SourceRun } from './aggregate'
import type { SearchRecency } from '../../shared/search'
import { daysSinceEpoch, detectLocale, recencySince, siteOperator, withOperators, type SearchLocale, type SourceRequest } from './modifiers'
import { runWebEngine, type WebEngine } from './web-engine'

export { detectLocale, type SearchLocale }

interface Raw {
  title: string
  href: string
  snippet: string
}

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

const BING_AGE: Record<Exclude<SearchRecency, 'year'>, string> = { day: 'ez1', week: 'ez2', month: 'ez3' }

export function bingRecencyFilter(recent: SearchRecency, now = Date.now()): string {
  const age = recent === 'year' ? `ez5_${daysSinceEpoch(recencySince('year', now))}_${daysSinceEpoch(new Date(now))}` : BING_AGE[recent]
  return `ex1:"${age}"`
}

export function bingUrl(query: string, limit: number, locale: SearchLocale, recent?: SearchRecency, now = Date.now()): string {
  const count = Math.min(50, Math.max(limit, 10))
  const market = locale === 'zh' ? '&setmkt=zh-CN&setlang=zh-Hans&cc=CN' : ''
  const filters = recent ? `&filters=${encodeURIComponent(bingRecencyFilter(recent, now))}` : ''
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}${market}${filters}`
}

export function runBingSearch(query: string, opts: SourceRequest, locale: SearchLocale = detectLocale(query)): Promise<SourceRun> {
  const engine: WebEngine<Raw> = {
    source: 'bing',
    label: 'Bing',
    url: bingUrl(withOperators(query, [siteOperator(opts.sites)]), opts.limit, locale, opts.recent),
    script: SCRIPT,
    toRow: (r) => ({ title: r.title, url: decodeBingRedirect(r.href), snippet: r.snippet })
  }
  return runWebEngine(engine, opts)
}
