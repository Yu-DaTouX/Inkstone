/**
 * DuckDuckGo 网页搜索来源（HTML 版）：英文与技术类查询的首选免 key 来源。
 * 在中国大陆网络下通常连不上，此时按来源报错，由中文来源（Bing / 360）承担。
 */
import type { SourceRun } from './aggregate'
import { runWebEngine, type WebEngine } from './web-engine'

interface Raw {
  title: string
  href: string
  snippet: string
}

/** 结果链接是 `duckduckgo.com/l/?uddg=<编码后的真实地址>`，还原它 */
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

export function runDdgSearch(query: string, opts: { limit: number; timeoutMs: number }): Promise<SourceRun> {
  const engine: WebEngine<Raw> = {
    source: 'ddg',
    label: 'DuckDuckGo',
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    script: SCRIPT,
    toRow: (r) => ({ title: r.title, url: decodeDdgRedirect(r.href), snippet: r.snippet })
  }
  return runWebEngine(engine, opts)
}
