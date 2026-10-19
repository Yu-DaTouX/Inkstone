import type { Element, ElementContent, Root } from 'hast'
import type { PluggableList } from 'unified'

export type MathLoadState = 'idle' | 'pending' | 'ready' | 'failed'

export interface MathPlugins {
  remark: PluggableList
  rehype: PluggableList
}

const DISPLAY_MATH = /(^|[^\\])\$\$[\s\S]*?[^\\]\$\$/
const INLINE_MATH = /(^|[^\\$\w])\$(?![\s$])([^$\n]{1,400}?)(?<![\s\\])\$(?![\w$])/g
const TEX_HINT = /[\\^_{}=]|\b[a-zA-Z]\b/
const RETRY_AFTER_MS = 15_000

export function needsMath(text: string): boolean {
  if (!text.includes('$')) return false
  if (DISPLAY_MATH.test(text)) return true
  for (const match of text.matchAll(INLINE_MATH)) {
    const body = match[2]
    if (/^\d+(?:[.,]\d+)?$/.test(body.trim())) continue
    if (TEX_HINT.test(body)) return true
  }
  return false
}

function classList(node: Element): string[] {
  const value = node.properties?.className
  return Array.isArray(value) ? value.map(String) : []
}

function soleChild(children: readonly ElementContent[]): ElementContent | null {
  const meaningful = children.filter((child) => !(child.type === 'text' && !child.value.trim()))
  return meaningful.length === 1 ? meaningful[0] : null
}

function promoteDisplay(node: Root | Element, source: string): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (child.tagName === 'p') {
      const only = soleChild(child.children)
      const start = only?.type === 'element' ? only.position?.start?.offset : undefined
      if (only?.type === 'element' && only.tagName === 'code' && start !== undefined && source.startsWith('$$', start)) {
        const classes = classList(only)
        if (classes.includes('math-inline')) only.properties.className = classes.map((name) => (name === 'math-inline' ? 'math-display' : name))
      }
      continue
    }
    promoteDisplay(child, source)
  }
}

export function rehypeDisplayDoubleDollar() {
  return (tree: Root, file: { value?: unknown }): void => {
    const source = typeof file?.value === 'string' ? file.value : String(file?.value ?? '')
    if (source.includes('$$')) promoteDisplay(tree, source)
  }
}

type Listener = () => void

let state: MathLoadState = 'idle'
let plugins: MathPlugins | null = null
let failedAt = 0
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function mathLoadState(): MathLoadState {
  return state
}

export function mathPlugins(): MathPlugins | null {
  return plugins
}

export function subscribeMath(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function requestMath(now = Date.now()): void {
  if (state === 'pending' || state === 'ready') return
  if (state === 'failed' && now - failedAt < RETRY_AFTER_MS) return
  state = 'pending'
  emit()
  void Promise.all([import('remark-math'), import('rehype-katex'), import('katex/dist/katex.min.css')]).then(
    ([remarkMath, rehypeKatex]) => {
      plugins = {
        remark: [[remarkMath.default, { singleDollarTextMath: true }]],
        rehype: [rehypeDisplayDoubleDollar, [rehypeKatex.default, { throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' }]]
      }
      state = 'ready'
      emit()
    },
    () => {
      state = 'failed'
      failedAt = Date.now()
      emit()
    }
  )
}
