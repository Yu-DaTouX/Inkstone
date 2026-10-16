import type { GoalState } from '../../../shared/goal'

export function goalDisplayTitle(goal: GoalState | null | undefined): string {
  const title = goal?.brief?.goal || goal?.pendingReady?.understanding.goal || goal?.steps[0]?.title || ''
  return title.replace(/^完成用户请求[：:]\s*/, '').trim() || '正在准备目标'
}
