import type { SourceRun } from './aggregate'
import type { SearchRecency } from '../../shared/search'
import { siteOperator, withOperators, type SourceRequest } from './modifiers'
import { runWebEngine, type WebEngine } from './web-engine'

interface Raw {
  title: string
  href: string
  snippet: string
}

export function decodeDdgRedirect(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    if (!/(^|\.)duckduckgo\.com$/i.test(url.hostname) || !url.pathname.startsWith('/l/')) return href
    const target = url.searchParams.get('uddg')
    return target && /^https?:\/\//i.test(target) ? target : href
  } catch {
    return href
  }
}

const SCRIPT = `(() => {
  const items = [...document.querySelectorAll('.result')].map((r) => {
    const a = r.querySelector('.result__a')
    const s = r.querySelector('.result__snippet')
    return a ? { title: a.textContent || '', href: a.href || '', snippet: s ? s.textContent || '' : '' } : null
  }).filter(Boolean)
  const text = document.body ? document.body.innerText : ''
  const captcha = items.length === 0 && /unusual traffic|anomaly|captcha|robot/i.test(text)
  const none = items.length === 0 && /no results/i.test(text)
  return { items, captcha, none }
})()`

const DDG_AGE: Record<SearchRecency, string> = { day: 'd', week: 'w', month: 'm', year: 'y' }

export function ddgUrl(query: string, recent?: SearchRecency): string {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${recent ? `&df=${DDG_AGE[recent]}` : ''}`
}

export function runDdgSearch(query: string, opts: SourceRequest): Promise<SourceRun> {
  const engine: WebEngine<Raw> = {
    source: 'ddg',
    label: 'DuckDuckGo',
    url: ddgUrl(withOperators(query, [siteOperator(opts.sites)]), opts.recent),
    script: SCRIPT,
    toRow: (r) => ({ title: r.title, url: decodeDdgRedirect(r.href), snippet: r.snippet })
  }
  return runWebEngine(engine, opts)
}
