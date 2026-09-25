import type { GoalState } from '../../../shared/goal'

/** 自动目标没有用户填写的 brief；展示时使用现有计划文字，不把内部 ID 当标题。 */
export function goalDisplayTitle(goal: GoalState | null | undefined): string {
  const title = goal?.brief?.goal || goal?.pendingReady?.understanding.goal || goal?.steps[0]?.title || ''
  return title.replace(/^完成用户请求[：:]\s*/, '').trim() || '正在准备目标'
}
