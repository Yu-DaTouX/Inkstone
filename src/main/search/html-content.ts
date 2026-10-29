import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { NodeHtmlMarkdown, PostProcessResult, type TranslatorConfigFactory } from 'node-html-markdown'

type ElementContext = Parameters<TranslatorConfigFactory>[0]

const DROP = 'script,style,noscript,nav,footer,aside,form,iframe,svg,[role=navigation],[aria-hidden=true],[hidden]'

function publicLink(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 8192 ? url.href : null
  } catch { return null }
}

function angleUrl(href: string): string {
  return `<${href.replace(/>/g, '%3E')}>`
}

function collapse(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim()
}

function compactTables(text: string): string {
  let fenced = false
  return text.split('\n').map((line) => {
    if (/^\s*`{3,}/.test(line)) {
      fenced = !fenced
      return line
    }
    if (fenced || !/^[ \t]*\|.*\|[ \t]*$/.test(line)) return line
    const compact = line.replace(/[ \t]{2,}/g, ' ').trim()
    return /^\|(?:[ \t]*:?-+:?[ \t]*\|)+$/.test(compact) ? compact.replace(/-+/g, '---') : compact
  }).join('\n')
}

function attribute(node: { getAttribute(name: string): string | null | undefined }, name: string): string {
  return collapse(node.getAttribute(name))
}

function codeBlock(node: ElementContext['node'], lineBreak: string) {
  const code = (node.textContent ?? '').replace(/\r\n?/g, '\n').trim()
  if (!code) return { ignore: true }
  const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((match) => match[0].length + 1)))
  const language = (node.querySelector('code')?.getAttribute('class') ?? node.getAttribute('class') ?? '').match(/language-(\S+)/)?.[1] ?? ''
  return { content: `${fence}${language}${lineBreak}${code.replace(/\n/g, lineBreak)}${lineBreak}${fence}`, recurse: false }
}

function converter(base: string): NodeHtmlMarkdown {
  const link = ({ node }: ElementContext) => {
    const href = publicLink(attribute(node, 'href'), base)
    if (!href) return {}
    return {
      noEscape: true,
      postprocess: ({ content }: { content: string }) => {
        const label = collapse(content)
        return label ? `[${label}](${angleUrl(href)})` : PostProcessResult.RemoveNode
      }
    }
  }
  const image = ({ node }: ElementContext) => {
    const src = publicLink(attribute(node, 'src'), base)
    if (!src) return { ignore: true }
    return { content: `![${attribute(node, 'alt')}](${angleUrl(src)})`, recurse: false }
  }
  const markdown = new NodeHtmlMarkdown({
    bulletMarker: '-',
    indent: '  '
  }, {
    a: link,
    img: image,
    'ol,ul': ({ indentLevel }) => ({ surroundingNewlines: indentLevel ? 1 : 2 }),
    br: { content: '\n', recurse: false },
    pre: ({ node }) => codeBlock(node, '\n')
  })
  const inlineCode = markdown.translators.get('code')
  markdown.aTagTranslators.set('img', image)
  markdown.tableCellTranslators.set('a', link)
  markdown.tableCellTranslators.set('img', image)
  markdown.tableCellTranslators.set('br', { content: '<br>', recurse: false })
  markdown.tableCellTranslators.set('pre', ({ node }) => codeBlock(node, '<br>'))
  if (inlineCode) markdown.tableCellTranslators.set('code', inlineCode)
  return markdown
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
  const text = compactTables(converter(url).translate(root.innerHTML)).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { title, text, links, ...(publishedAt ? { publishedAt } : {}), ...(modifiedAt ? { modifiedAt } : {}) }
}
