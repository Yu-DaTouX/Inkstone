import type { Element, ElementContent, Root, RootContent, Text } from 'hast'

const KBD_OPEN = /^<kbd(?:\s[^<>]*)?>$/i
const KBD_CLOSE = /^<\/kbd\s*>$/i

type Raw = { type: 'raw'; value: string }
type TreeNode = RootContent | ElementContent | Raw

function kbdElement(nodes: Text[]): Element {
  return {
    type: 'element',
    tagName: 'kbd',
    properties: {},
    children: nodes.length === 1 ? [nodes[0]] : nodes
  }
}

function isRaw(node: TreeNode): node is Raw {
  return node.type === 'raw' && typeof (node as Raw).value === 'string'
}

function convert(children: readonly TreeNode[]): { nodes: TreeNode[]; changed: boolean } {
  const nodes: TreeNode[] = []
  let changed = false
  let index = 0
  while (index < children.length) {
    const node = children[index]
    if (isRaw(node) && KBD_OPEN.test(node.value)) {
      let close = index + 1
      while (close < children.length && children[close].type === 'text') close += 1
      const end = children[close]
      if (close > index + 1 && end !== undefined && isRaw(end) && KBD_CLOSE.test(end.value)) {
        nodes.push(kbdElement(children.slice(index + 1, close) as Text[]))
        index = close + 1
        changed = true
        continue
      }
    }
    if (node.type === 'element' && Array.isArray(node.children)) {
      const inner = convert(node.children as TreeNode[])
      if (inner.changed) {
        node.children = inner.nodes as ElementContent[]
        changed = true
      }
    }
    nodes.push(node)
    index += 1
  }
  return { nodes, changed }
}

export function rehypeKbd() {
  return (tree: Root): void => {
    const result = convert(tree.children as TreeNode[])
    if (result.changed) tree.children = result.nodes as RootContent[]
  }
}
