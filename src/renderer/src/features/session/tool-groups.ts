import type { ToolCallNode } from '../../../../shared/tool-call-tree'
import { toolKind } from './tool-summary'

export const GROUP_MIN = 3
export const GROUP_EXTRAS = 3
export const LIVE_STEPS = 3
export const LIVE_SEGMENTS = 3

export interface StepGroup {
  id: string
  name: string
  nodes: ToolCallNode[]
}

export type StepItem =
  | { type: 'step'; node: ToolCallNode }
  | { type: 'group'; group: StepGroup }

function groupKey(node: ToolCallNode): string | null {
  if (node.children.length) return null
  const kind = toolKind(node.call.name)
  return kind === 'other' ? `other:${node.call.name}` : kind
}

export function groupConsecutive(forest: readonly ToolCallNode[], min = GROUP_MIN): StepItem[] {
  const items: StepItem[] = []
  let run: ToolCallNode[] = []
  let runKey: string | null = null
  const flush = (): void => {
    if (run.length >= min) items.push({ type: 'group', group: { id: `group:${run[0].call.id}`, name: run[0].call.name, nodes: run } })
    else for (const node of run) items.push({ type: 'step', node })
    run = []
    runKey = null
  }
  for (const node of forest) {
    const key = groupKey(node)
    if (key === null) {
      flush()
      items.push({ type: 'step', node })
    } else if (key === runKey) {
      run.push(node)
    } else {
      flush()
      run = [node]
      runKey = key
    }
  }
  flush()
  return items
}

export function isLiveCall(node: ToolCallNode): boolean {
  return node.call.status === 'running' || node.call.status === 'pending'
}

export function isFailedCall(node: ToolCallNode): boolean {
  return node.call.status === 'error' && !node.call.cancelled
}

export function capRecent<T>(items: readonly T[], limit: number): { shown: T[]; hidden: number } {
  if (items.length <= limit) return { shown: [...items], hidden: 0 }
  return { shown: items.slice(items.length - limit), hidden: items.length - limit }
}

export function groupExtras(group: StepGroup): ToolCallNode[] {
  return group.nodes.filter((node) => isLiveCall(node) || isFailedCall(node))
}
