/**
 * 建任务阈值：宿主在 `yan tasks apply` 的落点判断这次该不该建任务清单。
 *
 * 各活动「怎么做」（研究怎么读、创作怎么写、整理怎么动手、导师怎么教）
 * 写在随包技能里（research / writing / organize / tutor），由模型按需读取。
 * 这里只留技能做不到的一件事：**拦下简单问答的任务清单** —— 这是宿主对
 * 持久状态的把关，不能只靠模型自觉。
 *
 * 只对 `daily` 档案的活动流程生效；`coding` 会话里的任务清单是开发者一直在用的
 * 东西，不能因为「日常不该为简单问答建任务」被顺手改掉。
 */

import type { AgentActivity, AgentProfileKind } from './agent-profile'

/** 天然是多步的活动（在 daily 档案里总是允许建任务清单）。 */
const MULTI_STEP_ACTIVITIES: ReadonlySet<AgentActivity> = new Set(['research', 'compose', 'organize', 'learn'])

export function isMultiStepActivity(activity: AgentActivity): boolean {
  return MULTI_STEP_ACTIVITIES.has(activity)
}

/** 超过这个长度就不再算「简单问答」（阈值是有意保守的，宁可不拦）。 */
export const SIMPLE_REQUEST_MAX_CHARS = 160
/** 简单问答最多允许的待办条数。 */
export const SIMPLE_TASK_MAX_ITEMS = 1

export interface TaskCreationInput {
  profile: AgentProfileKind
  activity: AgentActivity
  /** 用户当次要求原文；CLI 侧可能看不到，允许缺省。 */
  text?: string
  /** 这次提交要写入的待办条数。 */
  itemCount: number
  /** 用户明确要求「建任务 / 列个计划 / 持续跟进」。 */
  explicit?: boolean
}

export type TaskCreationReason = 'coding' | 'explicit' | 'activity-flow' | 'multi-step' | 'simple-answer'

export interface TaskCreationDecision {
  create: boolean
  reason: TaskCreationReason
}

/**
 * 该不该为这次提交建任务清单。
 *
 * 判定顺序有意为之：
 *   1. **coding 一律放行** —— 显式选了代码助手，就不拦；
 *   2. 用户明确要计划 → 建（他想看清单，不要替他省）；
 *   3. 活动本身是多步流程（研究 / 创作 / 整理 / 学习）→ 建；
 *   4. 多条待办或长输入 → 建（确实是多步）；
 *   5. 其余（自动或直接回答 + 一句话 + 至多一条待办）→ **不建**：简单问答不建任务。
 *
 * `auto` 档不走第 3 步：活动本来就是模型当场判断的，宿主没资格拿旧 activity
 * 替它认定「这是个多步流程」——否则一个默认自动的会话会因为上次的活动而突然建清单。
 */
export function decideTaskCreation(input: TaskCreationInput): TaskCreationDecision {
  if (input.profile === 'coding') return { create: true, reason: 'coding' }
  if (input.explicit) return { create: true, reason: 'explicit' }
  if (input.profile === 'daily' && isMultiStepActivity(input.activity)) {
    return { create: true, reason: 'activity-flow' }
  }
  if (input.itemCount > SIMPLE_TASK_MAX_ITEMS) return { create: true, reason: 'multi-step' }
  const text = (input.text ?? '').trim()
  if (text.length > SIMPLE_REQUEST_MAX_CHARS) return { create: true, reason: 'multi-step' }
  return { create: false, reason: 'simple-answer' }
}

/** 被拦下时给模型的一句可读说明（模型据此停止重试，而不是反复提交）。 */
export function taskCreationRefusal(reason: TaskCreationReason): string | null {
  if (reason !== 'simple-answer') return null
  return [
    '这是一个简单问答（活动 = 直接回答），宿主没有为它建立任务清单。',
    '直接回答即可；如果这其实是一个多步任务，请说明要做的步骤，或让用户明确要求「列个计划」。'
  ].join(' ')
}
