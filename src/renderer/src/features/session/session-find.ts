import { compileFind, DEFAULT_FIND_OPTIONS, findShortcut, type FindKeyState } from '../preview/code-find'

export interface FindNode {
  nodeType: number
  firstChild?: FindNode | null
  nextSibling?: FindNode | null
}

interface FindTextSegment {
  node: FindNode
  start: number
}

interface FindText {
  text: string
  segments: FindTextSegment[]
}

export interface FindRange {
  startNode: FindNode
  startOffset: number
  endNode: FindNode
  endOffset: number
}

export const FIND_OMITTED = 'data-find-omitted'
export const FIND_INCLUDED = 'data-find-included'
export const FIND_GUTTER = 'data-gutter'
export const FIND_HIGHLIGHT = 'session-find'
export const FIND_ACTIVE_HIGHLIGHT = 'session-find-active'
export const FIND_INPUT_DEBOUNCE_MS = 120
export const FIND_MUTATION_DEBOUNCE_MS = 60

const TEXT_NODE = 3
const ELEMENT_NODE = 1

const BLOCK_TAGS = new Set(
  'ADDRESS ARTICLE ASIDE BLOCKQUOTE BR DD DETAILS DIV DL DT FIGCAPTION FIGURE FOOTER H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION SUMMARY TABLE TBODY TD TFOOT TH THEAD TR UL'.split(' ')
)

const SR_ONLY_CLASSES = ['sr-only', 'v3-visually-hidden']

type NodeFacts = {
  tagName?: string
  data?: string
  classList?: { contains(name: string): boolean }
  attributes?: Record<string, string>
  getAttribute?: (name: string) => string | null
  hasAttribute?: (name: string) => boolean
}

function facts(node: FindNode): NodeFacts {
  return node as NodeFacts
}

function nodeAttribute(node: FindNode, name: string): string | null {
  const holder = facts(node)
  if (typeof holder.getAttribute === 'function') return holder.getAttribute(name)
  const attributes = holder.attributes
  return attributes && Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null
}

function nodeHasAttribute(node: FindNode, name: string): boolean {
  const holder = facts(node)
  if (typeof holder.hasAttribute === 'function') return holder.hasAttribute(name)
  return nodeAttribute(node, name) !== null
}

function nodeText(node: FindNode): string {
  return facts(node).data ?? ''
}

function nodeTag(node: FindNode): string {
  return (facts(node).tagName ?? '').toUpperCase()
}

function hasClass(node: FindNode, name: string): boolean {
  const holder = facts(node)
  if (holder.classList?.contains) return holder.classList.contains(name)
  return ` ${nodeAttribute(node, 'class') ?? ''} `.includes(` ${name} `)
}

function hiddenFromFind(node: FindNode): boolean {
  return nodeAttribute(node, 'aria-hidden') === 'true'
    || nodeHasAttribute(node, 'hidden')
    || SR_ONLY_CLASSES.some((name) => hasClass(node, name))
}

function hasIncludedDescendant(node: FindNode): boolean {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === ELEMENT_NODE && (nodeHasAttribute(child, FIND_INCLUDED) || hasIncludedDescendant(child))) return true
  }
  return false
}

export function collectFindText(root: FindNode, exclude?: ReadonlySet<FindNode>): FindText {
  const segments: FindTextSegment[] = []
  let text = ''
  let gap = false
  const children = (node: FindNode, included: boolean): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, included)
  }
  const visit = (node: FindNode, included: boolean): void => {
    if (node.nodeType === TEXT_NODE) {
      if (!included) return
      if (gap && text) {
        text += '\0'
      }
      gap = false
      segments.push({ node, start: text.length })
      text += nodeText(node)
      return
    }
    let next = included
    if (node.nodeType === ELEMENT_NODE) {
      if (exclude?.has(node) || nodeHasAttribute(node, FIND_GUTTER)) {
        gap = true
        return
      }
      if (nodeHasAttribute(node, FIND_INCLUDED)) next = true
      else if (nodeHasAttribute(node, FIND_OMITTED)) {
        if (!hasIncludedDescendant(node)) {
          gap = true
          return
        }
        next = false
      }
      if (hiddenFromFind(node)) {
        gap = true
        return
      }
      if (next !== included) gap = true
      if (BLOCK_TAGS.has(nodeTag(node))) {
        gap = true
        children(node, next)
        gap = true
        return
      }
    }
    children(node, next)
    if (next !== included) gap = true
  }
  visit(root, true)
  return { text, segments }
}

export function matchFind(root: FindNode, query: string, exclude?: ReadonlySet<FindNode>): FindRange[] {
  if (!root || typeof query !== 'string' || query.length === 0) return []
  const matcher = compileFind(query, DEFAULT_FIND_OPTIONS)
  if (!matcher) return []
  const { text, segments } = collectFindText(root, exclude)
  if (!segments.length) return []
  const matches: FindRange[] = []
  let segment = 0
  matcher.lastIndex = 0
  let found: RegExpExecArray | null
  while ((found = matcher.exec(text))) {
    if (found[0].length === 0) {
      if (matcher.lastIndex >= text.length) break
      matcher.lastIndex += 1
      continue
    }
    const at = found.index
    const end = at + found[0].length
    while (segment < segments.length && segments[segment].start + nodeText(segments[segment].node).length <= at) segment += 1
    if (segment >= segments.length) break
    const match: FindRange = {
      startNode: segments[segment].node,
      startOffset: at - segments[segment].start,
      endNode: segments[segment].node,
      endOffset: at - segments[segment].start
    }
    let tail = segment
    while (tail < segments.length) {
      const segmentEnd = segments[tail].start + nodeText(segments[tail].node).length
      if (end <= segmentEnd) {
        match.endNode = segments[tail].node
        match.endOffset = end - segments[tail].start
        break
      }
      tail += 1
    }
    if (tail < segments.length) matches.push(match)
  }
  return matches
}

export function findStatusText(query: string, current: number, total: number): string {
  if (!query) return ''
  return total > 0 ? `${current}/${total}` : '0/0'
}

export function clampActiveIndex(index: number, total: number): number {
  if (total === 0) return -1
  return Math.min(Math.max(index, 0), total - 1)
}

export function centeringOffset(rect: { top: number; height: number }, bounds: { top: number; bottom: number }): number | null {
  if (rect.top + rect.height > bounds.top && rect.top < bounds.bottom) return null
  return rect.top + rect.height / 2 - (bounds.top + bounds.bottom) / 2
}

type SessionFindAction = 'open' | 'close' | 'next' | 'prev' | null

interface SessionFindKeyState extends FindKeyState {
  open: boolean
  defaultPrevented?: boolean
}

export function sessionFindAction(state: SessionFindKeyState, mac: boolean): SessionFindAction {
  if (state.composing || state.defaultPrevented) return null
  if (findShortcut(state, mac) === 'open') return 'open'
  if (!state.open || state.alt) return null
  if (state.key === 'Escape') return 'close'
  const command = mac ? state.meta && !state.ctrl : state.ctrl && !state.meta
  if ((state.key === 'g' || state.key === 'G') && command) return state.shift ? 'prev' : 'next'
  if (state.key === 'F3' && !state.meta && !state.ctrl) return state.shift ? 'prev' : 'next'
  return null
}

interface SessionFindFocus {
  own: boolean
  inConversation: boolean
  inComposer: boolean
  idle: boolean
  open: boolean
  modalOpen: boolean
}

export function sessionFindAllowed(action: SessionFindAction, state: SessionFindFocus): boolean {
  if (!action) return false
  if (state.modalOpen) return action === 'close' && state.open
  if (state.own) return true
  if (action === 'open') return state.inConversation || state.inComposer || state.idle
  return state.open || state.inConversation || state.inComposer
}

export function findStepQuery(live: string | null | undefined, committed: string): string {
  return live ?? committed
}
