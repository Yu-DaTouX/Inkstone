import type { BrowserObservation } from '../../shared/ipc'

type Element = BrowserObservation['elements'][number]

export interface ObservedPage {
  url: string
  title: string
  text: string
  elements: Element[]
}

export interface ElementFilter {
  find?: string
  role?: string
  scopeRefs?: readonly string[]
  all?: boolean
}

export const ITEM_LIMIT = 80
export const ALL_ITEM_LIMIT = 200
export const CHANGE_LIMIT = 15
const NAME_CHARS = 60
const VALUE_CHARS = 40
const TEXT_LINE_CHARS = 120
const TEXT_CHANGE_LIMIT = 5

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export function elementLine(element: Element): string {
  const value = element.value ? ` =${JSON.stringify(element.value.slice(0, VALUE_CHARS))}` : ''
  return `${element.ref} ${element.role} ${JSON.stringify(clip(element.name, NAME_CHARS))}${value}${element.disabled ? ' disabled' : ''}`
}

export function filterElements(elements: readonly Element[], filter: ElementFilter): Element[] {
  const needle = filter.find?.trim().toLowerCase() ?? ''
  const role = filter.role?.trim().toLowerCase() ?? ''
  const scope = filter.scopeRefs ? new Set(filter.scopeRefs) : null
  return elements.filter((element) => {
    if (scope && !scope.has(element.ref)) return false
    if (role && element.role.toLowerCase() !== role) return false
    if (needle) return `${element.name}\n${element.value ?? ''}`.toLowerCase().includes(needle)
    return filter.all || scope !== null || !element.offscreen
  })
}

export function textMatches(text: string, needle: string, limit = 20, context = 80): Array<{ offset: number; snippet: string }> {
  const query = needle.trim().toLowerCase()
  if (!query) return []
  const lower = text.toLowerCase()
  const out: Array<{ offset: number; snippet: string }> = []
  let from = 0
  while (out.length < limit) {
    const index = lower.indexOf(query, from)
    if (index < 0) break
    const start = Math.max(0, index - context)
    out.push({ offset: index, snippet: text.slice(start, index + query.length + context).replace(/\s+/g, ' ').trim() })
    from = index + Math.max(query.length, 1)
  }
  return out
}

function textLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

function sameDocument(prev: ObservedPage, next: ObservedPage): boolean {
  if (!prev.elements.length || !next.elements.length) return prev.url === next.url
  const refs = new Set(prev.elements.map((element) => element.ref))
  return next.elements.some((element) => refs.has(element.ref))
}

export function diffObservations(prev: ObservedPage | undefined, next: ObservedPage, limit = CHANGE_LIMIT): string[] {
  const lines: string[] = []
  let dropped = 0
  const push = (line: string): void => {
    if (lines.length < limit) lines.push(line)
    else dropped += 1
  }
  const visible = next.elements.filter((element) => !element.offscreen)
  if (!prev) {
    for (const element of visible) push(`+ ${elementLine(element)}`)
    if (dropped) lines.push(`… 另有 ${dropped} 项`)
    return lines
  }
  if (prev.url !== next.url) push(`url → ${next.url}`)
  if (prev.title !== next.title) push(`title → ${JSON.stringify(clip(next.title, NAME_CHARS))}`)
  if (!sameDocument(prev, next)) {
    push(`文档已更换，旧 ref 全部失效；视口内 ${visible.length} 个元素：`)
    for (const element of visible) push(`+ ${elementLine(element)}`)
    if (dropped) lines.push(`… 另有 ${dropped} 项，observe 查看全部`)
    return lines
  }
  const before = new Map(prev.elements.map((element) => [element.ref, element]))
  const after = new Map(next.elements.map((element) => [element.ref, element]))
  for (const element of visible) {
    const old = before.get(element.ref)
    if (!old) push(`+ ${elementLine(element)}`)
    else if (old.name !== element.name || (old.value ?? '') !== (element.value ?? '') || Boolean(old.disabled) !== Boolean(element.disabled) || old.role !== element.role) push(`~ ${elementLine(element)}`)
  }
  for (const element of prev.elements) {
    if (!element.offscreen && !after.has(element.ref)) push(`- ${element.ref} ${element.role} ${JSON.stringify(clip(element.name, NAME_CHARS))}`)
  }
  const seen = new Set(textLines(prev.text))
  let textAdded = 0
  for (const line of textLines(next.text)) {
    if (seen.has(line)) continue
    seen.add(line)
    if (textAdded >= TEXT_CHANGE_LIMIT) {
      dropped += 1
      continue
    }
    textAdded += 1
    push(`+ 文本 ${JSON.stringify(clip(line, TEXT_LINE_CHARS))}`)
  }
  if (dropped) lines.push(`… 另有 ${dropped} 项变化，observe 或 text 查看`)
  return lines
}
