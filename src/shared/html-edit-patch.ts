import {
  HTML_VOID_ELEMENTS,
  readHtmlStartTag,
  readHtmlTagAttribute,
  setHtmlTagAttribute
} from './html-source-map'

export interface HtmlPatchStyle {
  property: string
  value: string | null
}

export interface HtmlPatchAttribute {
  name: string
  value: string | null
}

export interface HtmlEditPatch {
  styles?: HtmlPatchStyle[]
  text?: string | null
  attributes?: HtmlPatchAttribute[]
}

export type HtmlEditPatchError = 'offset' | 'styles' | 'attributes' | 'text' | 'text-children' | 'empty'

export type HtmlEditPatchResult = { ok: true; html: string } | { ok: false; error: HtmlEditPatchError }

export interface HtmlElementSpan {
  name: string
  tagStart: number
  tagEnd: number
  contentStart: number
  contentEnd: number
  closeStart: number
  closeEnd: number
}

const PROPERTY_NAME = /^(--[A-Za-z0-9_-]+|-?[A-Za-z][A-Za-z0-9-]*)$/
const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9:._-]*$/
const EDITABLE_ATTRIBUTES = new Set(['href', 'src', 'alt', 'title', 'class', 'id', 'target', 'rel', 'width', 'height', 'lang', 'dir', 'role', 'loading', 'poster'])
const URL_ATTRIBUTES = new Set(['href', 'src', 'poster'])

function editableAttribute(name: string, value: string | null): boolean {
  const key = name.toLowerCase()
  if (!EDITABLE_ATTRIBUTES.has(key) && !/^(data|aria)-[a-z0-9._-]+$/.test(key)) return false
  if (key === 'data-yan-src') return false
  if (value !== null && URL_ATTRIBUTES.has(key) && /^\s*(javascript|vbscript|data\s*:\s*text\/html)/i.test(value.replace(/[\u0000-\u001f]/g, ''))) return false
  return true
}

function declarationParts(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < value.length; index++) {
    const ch = value[index]
    if (quote) {
      if (ch === '\\') {
        index++
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

export function parseInlineStyle(value: string): HtmlPatchStyle[] {
  const declarations: HtmlPatchStyle[] = []
  for (const part of declarationParts(value)) {
    const text = part.trim()
    if (!text) continue
    const colon = text.indexOf(':')
    if (colon <= 0) continue
    const property = text.slice(0, colon).trim()
    const declaration = text.slice(colon + 1).trim()
    if (!PROPERTY_NAME.test(property) || !declaration) continue
    declarations.push({ property, value: declaration })
  }
  return declarations
}

export function serializeInlineStyle(declarations: readonly HtmlPatchStyle[]): string {
  return declarations
    .filter((item): item is { property: string; value: string } => typeof item.value === 'string' && item.value !== '')
    .map((item) => `${item.property}: ${item.value}`)
    .join('; ')
}

function usableValue(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text) return false
  if (/[;{}<>\n\r]/.test(text)) return false
  return true
}

export function mergeInlineStyle(current: string, patches: readonly HtmlPatchStyle[]): string | null {
  const merged: Array<{ key: string; property: string; value: string }> = []
  for (const declaration of parseInlineStyle(current)) {
    merged.push({ key: declaration.property.toLowerCase(), property: declaration.property, value: declaration.value as string })
  }
  for (const patch of patches) {
    const property = typeof patch?.property === 'string' ? patch.property.trim() : ''
    if (!PROPERTY_NAME.test(property)) continue
    const key = property.toLowerCase()
    const at = merged.findIndex((item) => item.key === key)
    const empty = patch.value === null || (typeof patch.value === 'string' && !patch.value.trim())
    if (empty) {
      for (let index = merged.length - 1; index >= 0; index--) if (merged[index].key === key) merged.splice(index, 1)
      continue
    }
    if (!usableValue(patch.value)) continue
    const value = (patch.value as string).trim()
    if (at >= 0) {
      merged[at] = { key, property: merged[at].property, value }
      for (let index = merged.length - 1; index > at; index--) if (merged[index].key === key) merged.splice(index, 1)
    } else merged.push({ key, property, value })
  }
  return merged.length ? serializeInlineStyle(merged.map((item) => ({ property: item.property, value: item.value }))) : null
}

export function findHtmlEndTag(html: string, from: number, name: string): { start: number; end: number } | null {
  const lower = html.toLowerCase()
  const needle = `</${name.toLowerCase()}`
  let index = from
  while (index < html.length) {
    const at = lower.indexOf(needle, index)
    if (at < 0) return null
    const after = html[at + needle.length]
    if (after === undefined || after === '>' || after === '/' || after === ' ' || after === '\t' || after === '\n' || after === '\r' || after === '\f') {
      const end = html.indexOf('>', at)
      return end < 0 ? null : { start: at, end: end + 1 }
    }
    index = at + needle.length
  }
  return null
}

export function htmlElementSpan(html: string, offset: number, tagName: string): HtmlElementSpan | null {
  const name = String(tagName ?? '').trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null
  if (!Number.isInteger(offset) || offset < 0 || offset >= html.length) return null
  const tag = readHtmlStartTag(html, offset)
  if (!tag || tag.name.toLowerCase() !== name) return null
  if (tag.selfClosing || HTML_VOID_ELEMENTS.has(name)) return null
  const close = findHtmlEndTag(html, tag.end, name)
  if (!close) return null
  return {
    name,
    tagStart: tag.offset,
    tagEnd: tag.end,
    contentStart: tag.end,
    contentEnd: close.start,
    closeStart: close.start,
    closeEnd: close.end
  }
}

export function isHtmlTextLeaf(html: string, offset: number, tagName: string): boolean {
  const span = htmlElementSpan(html, offset, tagName)
  if (!span) return false
  return !html.slice(span.contentStart, span.contentEnd).includes('<')
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function patchHtmlAtOffset(
  html: string,
  offset: number,
  tagName: string,
  patch: HtmlEditPatch
): HtmlEditPatchResult {
  if (typeof html !== 'string' || !patch || typeof patch !== 'object') return { ok: false, error: 'empty' }
  const name = String(tagName ?? '').trim().toLowerCase()
  const styles = Array.isArray(patch.styles) ? patch.styles : []
  const attributes = Array.isArray(patch.attributes) ? patch.attributes : []
  const hasText = patch.text !== undefined && patch.text !== null
  if (!styles.length && !attributes.length && !hasText) return { ok: false, error: 'empty' }
  if (hasText && typeof patch.text !== 'string') return { ok: false, error: 'text' }
  if (!Number.isInteger(offset) || offset < 0 || offset >= html.length) return { ok: false, error: 'offset' }
  const tag = readHtmlStartTag(html, offset)
  if (!tag || tag.name.toLowerCase() !== name) return { ok: false, error: 'offset' }

  for (const style of styles) {
    const value = style?.value
    if (typeof value === 'string' && value.trim() && !usableValue(value)) return { ok: false, error: 'styles' }
  }
  let tagText = html.slice(tag.offset, tag.end)
  if (styles.length) {
    const merged = mergeInlineStyle(readHtmlTagAttribute(tagText, 'style') ?? '', styles)
    tagText = setHtmlTagAttribute(tagText, 'style', merged)
  }
  for (const attribute of attributes) {
    const attributeName = typeof attribute?.name === 'string' ? attribute.name.trim() : ''
    if (!ATTRIBUTE_NAME.test(attributeName)) return { ok: false, error: 'attributes' }
    if (attribute.value !== null && typeof attribute.value !== 'string') return { ok: false, error: 'attributes' }
    if (!editableAttribute(attributeName, attribute.value)) return { ok: false, error: 'attributes' }
    tagText = setHtmlTagAttribute(tagText, attributeName, attribute.value)
  }

  let output = html.slice(0, tag.offset) + tagText + html.slice(tag.end)
  if (hasText) {
    const span = htmlElementSpan(html, offset, name)
    if (!span) return { ok: false, error: 'text-children' }
    if (html.slice(span.contentStart, span.contentEnd).includes('<')) return { ok: false, error: 'text-children' }
    const delta = tagText.length - (tag.end - tag.offset)
    output = output.slice(0, span.contentStart + delta) + escapeHtmlText(patch.text as string) + output.slice(span.contentEnd + delta)
  }
  if (output === html) return { ok: false, error: 'empty' }
  return { ok: true, html: output }
}
