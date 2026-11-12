import type { Element, ElementContent, Root } from 'hast'

const STOP_TAGS = new Set(['pre', 'svg', 'math', 'img', 'table', 'hr', 'br', 'input'])

function classes(node: Element): string[] {
  const value: unknown = node.properties?.className
  return Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(/\s+/) : []
}

function lastContent(children: readonly ElementContent[]): ElementContent | null {
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const child = children[i]
    if (child.type === 'element') return child
    if (child.type === 'text' && child.value.trim()) return child
  }
  return null
}

export function rehypeTypingCaret() {
  return (tree: Root): void => {
    let parent: Element | null = null
    let children = tree.children as ElementContent[]
    for (;;) {
      const last = lastContent(children)
      if (!last || last.type !== 'element') break
      if (STOP_TAGS.has(last.tagName) || classes(last).some((name) => name.startsWith('katex') || name.startsWith('math'))) return
      parent = last
      children = last.children
    }
    if (!parent) return
    parent.children.push({ type: 'element', tagName: 'span', properties: { className: ['v3-caret'], ariaHidden: 'true' }, children: [{ type: 'text', value: '\u258d' }] })
  }
}
