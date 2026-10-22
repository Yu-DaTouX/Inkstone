export const HTML_SOURCE_ATTRIBUTE = 'data-yan-src'

export interface HtmlStartTag {
  name: string
  offset: number
  end: number
  selfClosing: boolean
}

export interface HtmlTagAttribute {
  name: string
  start: number
  end: number
}

export const HTML_VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title'])

function space(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

function nameStart(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'))
}

function skipTagEnd(html: string, from: number): number {
  const end = html.indexOf('>', from)
  return end < 0 ? html.length : end + 1
}

export function readHtmlStartTag(html: string, start: number): HtmlStartTag | null {
  if (html[start] !== '<' || !nameStart(html[start + 1])) return null
  let index = start + 1
  let name = ''
  while (index < html.length) {
    const ch = html[index]
    if (space(ch) || ch === '/' || ch === '>') break
    name += ch
    index++
  }
  let quote = ''
  while (index < html.length) {
    const ch = html[index]
    if (quote) {
      if (ch === quote) quote = ''
      index++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      index++
      continue
    }
    if (ch === '>') {
      let last = index - 1
      while (last > start && space(html[last])) last--
      return { name, offset: start, end: index + 1, selfClosing: html[last] === '/' }
    }
    index++
  }
  return null
}

export function scanHtmlStartTags(html: string): HtmlStartTag[] {
  const lower = html.toLowerCase()
  const tags: HtmlStartTag[] = []
  let index = 0
  while (index < html.length) {
    if (html[index] !== '<') {
      index++
      continue
    }
    const next = html[index + 1]
    if (next === '!') {
      if (html.startsWith('<!--', index)) {
        const close = html.indexOf('-->', index + 4)
        index = close < 0 ? html.length : close + 3
        continue
      }
      if (html.startsWith('<![CDATA[', index)) {
        const close = html.indexOf(']]>', index + 9)
        index = close < 0 ? html.length : close + 3
        continue
      }
      index = skipTagEnd(html, index + 2)
      continue
    }
    if (next === '?' || next === '/') {
      index = skipTagEnd(html, index + 2)
      continue
    }
    if (!nameStart(next)) {
      index++
      continue
    }
    const tag = readHtmlStartTag(html, index)
    if (!tag) break
    tags.push(tag)
    index = tag.end
    const name = tag.name.toLowerCase()
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const close = lower.indexOf(`</${name}`, index)
      index = close < 0 ? lower.length : close
    }
  }
  return tags
}

export function scanHtmlAttributes(tagText: string): HtmlTagAttribute[] {
  const attributes: HtmlTagAttribute[] = []
  let index = 1
  while (index < tagText.length && !space(tagText[index]) && tagText[index] !== '>' && tagText[index] !== '/') index++
  while (index < tagText.length) {
    while (index < tagText.length && (space(tagText[index]) || tagText[index] === '/')) index++
    if (index >= tagText.length || tagText[index] === '>') break
    const start = index
    while (index < tagText.length && !space(tagText[index]) && tagText[index] !== '=' && tagText[index] !== '>' && tagText[index] !== '/') index++
    const name = tagText.slice(start, index)
    while (index < tagText.length && space(tagText[index])) index++
    if (tagText[index] === '=') {
      index++
      while (index < tagText.length && space(tagText[index])) index++
      const quote = tagText[index]
      if (quote === '"' || quote === "'") {
        index++
        while (index < tagText.length && tagText[index] !== quote) index++
        index++
      } else {
        while (index < tagText.length && !space(tagText[index]) && tagText[index] !== '>') index++
      }
    }
    if (!name) {
      index++
      continue
    }
    attributes.push({ name, start, end: Math.min(index, tagText.length) })
  }
  return attributes
}

function attributeEntry(tagText: string, name: string): HtmlTagAttribute | null {
  const wanted = name.toLowerCase()
  for (const attribute of scanHtmlAttributes(tagText)) {
    if (attribute.name.toLowerCase() === wanted) return attribute
  }
  return null
}

export function hasHtmlTagAttribute(tagText: string, name: string): boolean {
  return attributeEntry(tagText, name) !== null
}

export function readHtmlTagAttribute(tagText: string, name: string): string | null {
  const attribute = attributeEntry(tagText, name)
  if (!attribute) return null
  const text = tagText.slice(attribute.start, attribute.end)
  const equals = text.indexOf('=')
  if (equals < 0) return ''
  const raw = text.slice(equals + 1).trim()
  if (raw.length < 2) return raw
  const quote = raw[0]
  if ((quote === '"' || quote === "'") && raw.endsWith(quote)) return raw.slice(1, -1)
  return raw
}

export function escapeHtmlAttributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function insertionPoint(tagText: string): number {
  let index = tagText.length - 1
  if (tagText[index] !== '>') return tagText.length
  index--
  while (index > 0 && space(tagText[index])) index--
  return tagText[index] === '/' ? index : tagText.length - 1
}

export function setHtmlTagAttribute(tagText: string, name: string, value: string | null): string {
  const attribute = attributeEntry(tagText, name)
  if (!attribute) {
    if (value === null) return tagText
    const at = insertionPoint(tagText)
    return `${tagText.slice(0, at)} ${name}="${escapeHtmlAttributeValue(value)}"${tagText.slice(at)}`
  }
  if (value === null) {
    let start = attribute.start
    while (start > 0 && space(tagText[start - 1])) start--
    return tagText.slice(0, start) + tagText.slice(attribute.end)
  }
  return `${tagText.slice(0, attribute.start)}${name}="${escapeHtmlAttributeValue(value)}"${tagText.slice(attribute.end)}`
}

export function markHtmlSourceOffsets(html: string, attribute = HTML_SOURCE_ATTRIBUTE): string {
  const tags = scanHtmlStartTags(html)
  if (!tags.length) return html
  let output = ''
  let cursor = 0
  for (const tag of tags) {
    if (cursor > tag.offset) continue
    const tagText = html.slice(tag.offset, tag.end)
    if (hasHtmlTagAttribute(tagText, attribute)) continue
    output += html.slice(cursor, tag.offset) + setHtmlTagAttribute(tagText, attribute, String(tag.offset))
    cursor = tag.end
  }
  return cursor === 0 ? html : output + html.slice(cursor)
}
