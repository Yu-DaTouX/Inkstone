import type { AgentActivity, AgentProfileKind } from './agent-profile'

const MULTI_STEP_ACTIVITIES: ReadonlySet<AgentActivity> = new Set(['research', 'compose', 'organize', 'learn'])

export function isMultiStepActivity(activity: AgentActivity): boolean {
  return MULTI_STEP_ACTIVITIES.has(activity)
}

export const SIMPLE_REQUEST_MAX_CHARS = 160
export const CODING_MIN_ITEMS = 3
export const SIMPLE_TASK_MAX_ITEMS = 1

export interface TaskCreationInput {
  profile: AgentProfileKind
  activity: AgentActivity
  text?: string
  itemCount: number
  explicit?: boolean
  existingItems?: number
}

export type TaskCreationReason = 'coding' | 'coding-small' | 'explicit' | 'activity-flow' | 'multi-step' | 'simple-answer'

export interface TaskCreationDecision {
  create: boolean
  reason: TaskCreationReason
}

export function decideTaskCreation(input: TaskCreationInput): TaskCreationDecision {
  if (input.explicit) return { create: true, reason: 'explicit' }
  if (input.profile === 'coding') {
    if ((input.existingItems ?? 0) > 0 || input.itemCount >= CODING_MIN_ITEMS) return { create: true, reason: 'coding' }
    return { create: false, reason: 'coding-small' }
  }
  if (input.profile === 'daily' && isMultiStepActivity(input.activity)) {
    return { create: true, reason: 'activity-flow' }
  }
  if (input.itemCount > SIMPLE_TASK_MAX_ITEMS) return { create: true, reason: 'multi-step' }
  const text = (input.text ?? '').trim()
  if (text.length > SIMPLE_REQUEST_MAX_CHARS) return { create: true, reason: 'multi-step' }
  return { create: false, reason: 'simple-answer' }
}

export function taskCreationRefusal(reason: TaskCreationReason): string | null {
  if (reason === 'coding-small') {
    return `任务不足 ${CODING_MIN_ITEMS} 步，宿主没有建立任务清单。直接动手即可；确实是多步任务时，一次写全所有步骤再提交，或让用户明确要求「列个计划」。`
  }
  if (reason !== 'simple-answer') return null
  return [
    '这是一个简单问答（活动 = 直接回答），宿主没有为它建立任务清单。',
    '直接回答即可；如果这其实是一个多步任务，请说明要做的步骤，或让用户明确要求「列个计划」。'
  ].join(' ')
}
