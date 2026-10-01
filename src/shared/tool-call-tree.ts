import type { UIToolCall } from './ipc'

/** Keep visible children with their ancestors, without changing execution records. */
export function projectToolCallTree(tools: UIToolCall[], visibleIds: Set<string>): { call: UIToolCall; depth: number }[] {
  const byId = new Map(tools.map(call => [call.id, call]))
  const keep = new Set(visibleIds)
  for (const id of visibleIds) {
    const seen = new Set<string>([id])
    let parent = byId.get(id)?.parentToolCallId
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent)
      keep.add(parent)
      parent = byId.get(parent)?.parentToolCallId
    }
  }
  const children = new Map<string, UIToolCall[]>()
  for (const call of tools) {
    if (!call.parentToolCallId || !byId.has(call.parentToolCallId) || call.parentToolCallId === call.id) continue
    const siblings = children.get(call.parentToolCallId) ?? []
    siblings.push(call)
    children.set(call.parentToolCallId, siblings)
  }
  const result: { call: UIToolCall; depth: number }[] = []
  const visited = new Set<string>()
  const append = (call: UIToolCall, depth: number) => {
    if (visited.has(call.id)) return
    visited.add(call.id)
    if (keep.has(call.id)) result.push({ call, depth: Math.min(depth, 4) })
    for (const child of children.get(call.id) ?? []) append(child, depth + 1)
  }
  for (const call of tools) {
    if (!call.parentToolCallId || !byId.has(call.parentToolCallId) || call.parentToolCallId === call.id) append(call, 0)
  }
  // Malformed or cyclic historical references still remain inspectable.
  for (const call of tools) if (!visited.has(call.id)) append(call, 0)
  return result
}
