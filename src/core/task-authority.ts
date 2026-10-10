import type { TaskAuthority, TaskBudget } from '../shared/agent-service'
import { inside } from './task-files'

export const DEFAULT_TASK_BUDGET: TaskBudget = { maxTimeMs: 10 * 60_000, maxModelCalls: 40, maxToolCalls: 100 }
export function taskBudget(raw: Partial<TaskBudget> = {}, parent?: TaskBudget): TaskBudget {
  const result = { ...DEFAULT_TASK_BUDGET, ...raw }
  for (const key of Object.keys(result) as Array<keyof TaskBudget>) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1) throw new Error(`预算 ${key} 必须是正整数`)
    if (parent && result[key] > parent[key]) result[key] = parent[key]
  }
  return result
}
export function assertNarrower(child: TaskAuthority, parent: TaskAuthority): void {
  for (const key of ['readRoots', 'writeRoots'] as const) {
    if (child[key].some(path => !parent[key].some(root => inside(root, path)))) throw new Error(`子任务不能扩大 ${key}`)
  }
  for (const key of ['network', 'programs', 'credentials'] as const) {
    if (child[key].some(value => !parent[key].includes(value))) throw new Error(`子任务不能扩大 ${key}`)
  }
  if (child.subagents && !parent.subagents) throw new Error('子任务不能扩大派活授权')
}
