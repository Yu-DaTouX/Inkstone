import type { UIToolCall } from './ipc'

/** One recorded call and the calls it made itself (Codemode scripts call other tools). */
export interface ToolCallNode {
  call: UIToolCall
  children: ToolCallNode[]
}

/**
 * Arrange calls by `parentToolCallId` without changing execution records.
 * Siblings keep execution order. A missing parent, a self reference or a cycle
 * puts the call at the top level, so every recorded call stays inspectable.
 */
export function toolCallForest(tools: UIToolCall[]): ToolCallNode[] {
  const byId = new Map<string, UIToolCall>()
  for (const call of tools) if (!byId.has(call.id)) byId.set(call.id, call)
  const nodes = new Map<string, ToolCallNode>()
  for (const call of byId.values()) nodes.set(call.id, { call, children: [] })
  /* The ancestor chain must end outside the list; a chain that comes back to the call is a cycle. */
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

/** Finished without failure and with a complete record. */
export function isSettledToolCall(call: UIToolCall): boolean {
  return call.status !== 'running' && call.status !== 'pending' && call.status !== 'error' && !call.incomplete
}

/** A call counts as settled only when everything it called settled too. */
export function isSettledToolNode(node: ToolCallNode): boolean {
  return isSettledToolCall(node.call) && node.children.every(isSettledToolNode)
}

/** Calls below `nodes`, depth first, in execution order. */
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

/** `read ×6 · bash ×2`: which tools a composite call used, in first-use order. */
export function summarizeNestedCalls(nodes: ToolCallNode[], limit = 3): string {
  const counts = new Map<string, number>()
  for (const { call } of flattenToolNodes(nodes)) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  const parts = [...counts].slice(0, limit).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
  return counts.size > limit ? `${parts.join(' · ')} …` : parts.join(' · ')
}
