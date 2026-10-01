/**
 * 360 搜索来源：中文互联网内容（博客、社区、问答），匿名访问不会像百度、搜狗那样弹验证。
 * 结果链接是 `so.com/link?m=…` 的跳转；链接节点的 `data-mdurl` 带真实地址，优先用它。
 */
import type { SourceRun } from './aggregate'
import { runWebEngine, type WebEngine } from './web-engine'

interface Raw {
  title: string
  href: string
  mdurl: string
  snippet: string
}

const SCRIPT = `(() => {
  const items = [...document.querySelectorAll('li.res-list')].map((li) => {
    const a = li.querySelector('h3 a')
    if (!a) return null
    const p = li.querySelector('.res-desc, .res-rich, p')
    return { title: a.textContent || '', href: a.href || '', mdurl: a.getAttribute('data-mdurl') || '', snippet: p ? p.textContent || '' : '' }
  }).filter(Boolean)
  const text = document.body ? document.body.innerText : ''
  const captcha = items.length === 0 && /验证码|安全验证|captcha/i.test(text + document.title)
  const none = items.length === 0 && /没有找到|未找到|抱歉/.test(text)
  return { items, captcha, none }
})()`

export function runSo360Search(query: string, opts: { limit: number; timeoutMs: number }): Promise<SourceRun> {
  const engine: WebEngine<Raw> = {
    source: 'so360',
    label: '360 搜索',
    url: `https://www.so.com/s?q=${encodeURIComponent(query)}`,
    script: SCRIPT,
    toRow: (r) => ({ title: r.title, url: /^https?:\/\//i.test(r.mdurl) ? r.mdurl : r.href, snippet: r.snippet })
  }
  return runWebEngine(engine, opts)
}
