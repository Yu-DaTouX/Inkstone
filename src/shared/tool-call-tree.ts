import type { UIToolCall } from './ipc'

export interface ToolCallNode {
  call: UIToolCall
  children: ToolCallNode[]
}

export function toolCallForest(tools: UIToolCall[]): ToolCallNode[] {
  const byId = new Map<string, UIToolCall>()
  for (const call of tools) if (!byId.has(call.id)) byId.set(call.id, call)
  const nodes = new Map<string, ToolCallNode>()
  for (const call of byId.values()) nodes.set(call.id, { call, children: [] })
  const nests = (call: UIToolCall): boolean => {
    if (!call.parentToolCallId || !byId.has(call.parentToolCallId)) return false
    const seen = new Set<string>([call.id])
    let parent: string | undefined = call.parentToolCallId
    while (parent && byId.has(parent)) {
      if (seen.has(parent)) return false
      seen.add(parent)
      parent = byId.get(parent)?.parentToolCallId
    }
    return true
  }
  const roots: ToolCallNode[] = []
  for (const call of byId.values()) {
    const node = nodes.get(call.id)!
    if (nests(call)) nodes.get(call.parentToolCallId!)!.children.push(node)
    else roots.push(node)
  }
  return roots
}

export function flattenToolNodes(nodes: ToolCallNode[]): ToolCallNode[] {
  const out: ToolCallNode[] = []
  const walk = (list: ToolCallNode[]): void => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}
