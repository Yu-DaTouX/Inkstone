/**
 * 活动流程（实施-25 P05 / T05-1、T05-2）—— 宿主侧的行为定义。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么流程要落在宿主代码，而不是写进系统提示
 * ══════════════════════════════════════════════════════════════════
 * 「研究 = 先选/补资料 → 按问题阅读 → 结论 + 来源分歧」这类流程如果只写在
 * 提示词里，它既不能阻止宿主做错事（例如给一句简单问答建一整套任务清单），
 * 也无法被检查（宿主没法回答「这一步到底做了没有」）。所以这里把每个活动的
 * **可判定事实**写成数据：
 *   · `deliverable` —— 该活动的产出要求（研究 = 带来源的结论，问答 = 无）；
 *   · `requiresSources` / `keepsDisagreement` —— 研究结论的两条硬要求；
 *   · `steps` —— 流程步骤，供上下文装配说明「现在在做第几步」。
 *
 * 提示词里描述角色的文案是另一件事（`agent-profile.ts` 的 `agentRoleSection`），
 * 两者不互相复制：这里只有**事实**，没有文案。
 *
 * ── 阈值判定（T05-2：简单问答不建任务）──
 * `decideTaskCreation` 是纯函数，宿主在 `yan tasks apply` 的落点调用它。
 * 它只对 `daily` 档案生效 —— `coding` 会话里的任务清单是开发者一直在用的
 * 东西，不能因为「日常不该为简单问答建任务」被顺手改掉。
 */

import type { AgentActivity, AgentProfileKind } from './agent-profile'

export interface ActivityStep {
  /** 稳定 id：宿主与界面用它指认「现在在第几步」，不靠序号。 */
  id: string
  title: string
  /** 这一步要产生什么。宿主据此判断流程有没有真的走完。 */
  produces: string
}

export interface ActivityFlow {
  activity: AgentActivity
  /** 产出要求；`null` = 不要求独立成果（简单问答只回答，不产出文档）。 */
  deliverable: string | null
  /** 这个活动天然是多步的吗（多步活动才建任务清单）。 */
  multiStep: boolean
  /** 结论必须带回原文的引用。 */
  requiresSources: boolean
  /** 来源之间说法不一致时，如实保留分歧（不强行合成唯一答案）。 */
  keepsDisagreement: boolean
  steps: ActivityStep[]
}

/**
 * 五个活动的流程定义。
 *
 * 步骤顺序就是设计稿里那几条（研究 / 创作 / 办事），`answer` 刻意只有一步 ——
 * 它是「直接回答」，多出来的步骤会是宿主凭空发明的仪式。
 */
export const ACTIVITY_FLOWS: Record<AgentActivity, ActivityFlow> = {
  answer: {
    activity: 'answer',
    deliverable: null,
    multiStep: false,
    requiresSources: false,
    keepsDisagreement: false,
    steps: [{ id: 'answer', title: '直接回答', produces: '答案本身' }]
  },
  research: {
    activity: 'research',
    deliverable: '带来源的结论（每条结论指出它来自哪份资料的哪一处）',
    multiStep: true,
    requiresSources: true,
    keepsDisagreement: true,
    steps: [
      { id: 'pick-sources', title: '选/补资料', produces: '要读的资料范围' },
      { id: 'read-by-question', title: '按问题阅读', produces: '与问题相关的段落' },
      { id: 'conclude', title: '给出结论', produces: '带来源的结论；来源有分歧时保留分歧' }
    ]
  },
  compose: {
    activity: 'compose',
    deliverable: '可继续编辑的文稿（按段修订，用户的改动不被覆盖）',
    multiStep: true,
    requiresSources: false,
    keepsDisagreement: false,
    steps: [
      { id: 'purpose', title: '确定用途', produces: '给谁看、用来做什么' },
      { id: 'outline', title: '给提纲', produces: '结构' },
      { id: 'draft', title: '写初稿', produces: '可编辑文稿' },
      { id: 'revise', title: '按选区修订', produces: '改过的段落' }
    ]
  },
  organize: {
    activity: 'organize',
    deliverable: '整理结果（哪些进了哪一类，一眼看懂）',
    multiStep: true,
    requiresSources: false,
    keepsDisagreement: false,
    steps: [
      { id: 'classify', title: '定分类与命名', produces: '分类方案' },
      { id: 'apply', title: '执行整理', produces: '整理后的资料集' },
      { id: 'report', title: '回报影响', produces: '改动清单' }
    ]
  },
  learn: {
    activity: 'learn',
    deliverable: '学习记录（讲解 / 练习 / 反馈 / 笔记）',
    multiStep: true,
    requiresSources: false,
    keepsDisagreement: false,
    steps: [
      { id: 'prepare', title: '准备', produces: '学习者已会什么、卡在哪' },
      { id: 'explain', title: '讲解', produces: '一小步讲解' },
      { id: 'wait', title: '等学习者', produces: '学习者的回应（等他，不自问自答）' },
      { id: 'feedback', title: '反馈', produces: '先提示、后答案' },
      { id: 'apply', title: '应用', produces: '独立完成的证据' },
      { id: 'summary', title: '小结', produces: '本轮笔记与进度' }
    ]
  }
}

/** 活动流程（未知活动回落到 `answer`，与档案的归一化口径一致）。 */
export function activityFlow(activity: AgentActivity): ActivityFlow {
  return ACTIVITY_FLOWS[activity] ?? ACTIVITY_FLOWS.answer
}

/* ------------------------------------------------------------------ *
 * T05-2：简单问答不建任务
 * ------------------------------------------------------------------ */

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
 *   1. **coding 一律放行** —— 这是不干预既有行为的前提；
 *   2. 用户明确要计划 → 建（他想看清单，不要替他省）；
 *   3. 活动本身是多步流程（研究 / 创作 / 办事 / 学习）→ 建；
 *   4. 多条待办或长输入 → 建（确实是多步）；
 *   5. 其余（answer + 一句话 + 至多一条待办）→ **不建**：简单问答不建任务。
 */
export function decideTaskCreation(input: TaskCreationInput): TaskCreationDecision {
  if (input.profile !== 'daily') return { create: true, reason: 'coding' }
  if (input.explicit) return { create: true, reason: 'explicit' }
  if (activityFlow(input.activity).multiStep) return { create: true, reason: 'activity-flow' }
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

/* ------------------------------------------------------------------ *
 * 研究结论契约（T05-5：保留分歧不强行合成）
 * ------------------------------------------------------------------ */

export interface ConclusionContract {
  requiresSources: boolean
  keepsDisagreement: boolean
  /** 结论里必须出现的结构（宿主据此检查产出，不靠模型自觉）。 */
  requiredFields: readonly string[]
}

/**
 * 研究结论的硬要求。
 *
 * `requiredFields` 不是「提示词模板」，而是宿主检查成果时的字段名：
 * 每条结论必须带 `source`，来源不一致时必须带 `disagreement`。
 */
export function conclusionContract(activity: AgentActivity): ConclusionContract {
  const flow = activityFlow(activity)
  return {
    requiresSources: flow.requiresSources,
    keepsDisagreement: flow.keepsDisagreement,
    requiredFields: flow.requiresSources ? (flow.keepsDisagreement ? ['source', 'disagreement'] : ['source']) : []
  }
}
