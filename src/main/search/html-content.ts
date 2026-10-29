import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'

interface HtmlNode {
  nodeType: number
  textContent: string | null
  localName?: string
  childNodes: ArrayLike<HtmlNode>
  getAttribute?(name: string): string | null
}

const DROP = 'script,style,noscript,nav,footer,aside,form,iframe,svg,[role=navigation],[aria-hidden=true],[hidden]'
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'blockquote', 'figure', 'figcaption', 'dl', 'dt', 'dd'])

function publicLink(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 8192 ? url.href : null
  } catch { return null }
}

function markdown(node: HtmlNode, base: string): string {
  if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ')
  const tag = node.localName ?? ''
  if (tag === 'pre') {
    const code = (node.textContent ?? '').replace(/\r\n?/g, '\n').trim()
    const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)))
    return `\n\n${fence}\n${code}\n${fence}\n\n`
  }
  if (tag === 'table') {
    const rows: HtmlNode[][] = []
    const visit = (current: HtmlNode): void => {
      if (current.localName === 'tr') rows.push(Array.from(current.childNodes).filter((child) => child.localName === 'td' || child.localName === 'th'))
      else for (const child of Array.from(current.childNodes)) visit(child)
    }
    visit(node)
    if (!rows.length) return ''
    const columns = Math.max(...rows.map((row) => row.length))
    const render = (row: HtmlNode[]): string => `| ${Array.from({ length: columns }, (_, index) => row[index] ? Array.from(row[index].childNodes).map((child) => markdown(child, base)).join('').trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>') : '').join(' | ')} |`
    const hasHeader = rows[0].some((cell) => cell.localName === 'th')
    const header = hasHeader ? render(rows.shift()!) : `| ${Array.from({ length: columns }, (_, index) => `Column ${index + 1}`).join(' | ')} |`
    return `\n\n${header}\n| ${Array.from({ length: columns }, () => '---').join(' | ')} |\n${rows.map(render).join('\n')}\n\n`
  }
  const content = Array.from(node.childNodes).map((child) => markdown(child, base)).join('')
  if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${content.trim()}\n\n`
  if (tag === 'br') return '\n'
  if (tag === 'li') return `\n- ${content.trim()}`
  if (tag === 'ul' || tag === 'ol') return `\n${content}\n`
  if (tag === 'tr') return `\n${content}\n`
  if (tag === 'td' || tag === 'th') return ` | ${content.trim().replace(/\|/g, '\\|')}`
  if (tag === 'code') return `\`${content.replace(/`/g, '\\`')}\``
  if (tag === 'a') {
    const href = publicLink(node.getAttribute?.('href') ?? '', base)
    return href && content.trim() ? `[${content.trim()}](<${href.replace(/>/g, '%3E')}>)` : content
  }
  return BLOCKS.has(tag) ? `\n\n${content.trim()}\n\n` : content
}

export function extractHtml(html: string, url: string) {
  if (html.length > 2_000_000) throw new Error('HTML 超过 2,000,000 字符解析上限')
  const { document } = parseHTML(html)
  const meta = (names: string[]): string | undefined => {
    for (const name of names) {
      const value = document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute('content')?.trim()
      if (value) return value.slice(0, 200)
    }
    return undefined
  }
  const publishedAt = meta(['article:published_time', 'datePublished', 'date'])
  const modifiedAt = meta(['article:modified_time', 'dateModified', 'last-modified'])
  const title = document.title.trim()
  let content: string | undefined
  try {
    content = new Readability(document.cloneNode(true) as unknown as ConstructorParameters<typeof Readability>[0], { maxElemsToParse: 30_000, keepClasses: false }).parse()?.content ?? undefined
  } catch { }
  const root = content ? parseHTML(`<html><body>${content}</body></html>`).document.body : document.querySelector('main,article,[role=main]') ?? document.body ?? document.documentElement
  for (const el of root.querySelectorAll(DROP)) el.remove()
  const links: Array<{ title: string; url: string }> = []
  const seen = new Set<string>()
  for (const anchor of root.querySelectorAll('a[href]')) {
    const target = publicLink(anchor.getAttribute('href') ?? '', url)
    if (!target || seen.has(target)) continue
    seen.add(target)
    links.push({ title: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200), url: target })
    if (links.length === 500) break
  }
  const text = markdown(root as unknown as HtmlNode, url).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { title, text, links, ...(publishedAt ? { publishedAt } : {}), ...(modifiedAt ? { modifiedAt } : {}) }
}
