/**
 * 活动档案（AgentProfile）—— 契约与纯逻辑（实施-25 P01）。
 *
 * 为什么需要它：日常模式里的 agent 不该还是「代码助手」。同一条问题，
 * 在 `coding` 会话、`daily` 会话、`daily + learn` 会话里应当有三种角色行为。
 * 这份档案就是那件事的**唯一真源**：按会话保存，改它只影响该会话。
 *
 * 两条边界（详见实施-25 §3.1 与不变量）：
 *   · **不读当前前台导航**：装配时只看这个会话自己的档案。切会话不串。
 *   · **只允许结构化分区**：角色文本走 pi 的 `systemPromptOptions.sections`，
 *     不拼整份系统提示。pi 升级改了 tools / docs 分区也不跟着漂移。
 *
 * 语言与回复详细程度**不在这里**：它们已有全局设置与各自的薄层扩展
 * （`language.js` / `response-detail.js`），再存一份就是第二个真源。
 * 需要按会话覆盖时另开片子，不在这里悄悄复制。
 */

export const AGENT_PROFILES = ['coding', 'daily'] as const
export type AgentProfileKind = (typeof AGENT_PROFILES)[number]

/** 默认档案：与现状一致 —— 已有会话不迁移、行为不变。 */
export const DEFAULT_AGENT_PROFILE: AgentProfileKind = 'coding'

export const AGENT_ACTIVITIES = ['answer', 'research', 'compose', 'organize', 'learn'] as const
export type AgentActivity = (typeof AGENT_ACTIVITIES)[number]

export const DEFAULT_AGENT_ACTIVITY: AgentActivity = 'answer'

export interface AgentProfile {
  profile: AgentProfileKind
  activity: AgentActivity
  /**
   * 所属主题空间（实施-25 P02 引入；P01 先留占位，由 P02 回填）。
   *
   * 可空一等字段：已有 Code 会话保持 `null`，不迁移。
   */
  spaceId?: string
  taskId?: string
  courseId?: string
}

/** 一次提交允许改的字段。`null` 显式清空（如空间被删）。 */
export interface AgentProfilePatch {
  profile?: AgentProfileKind
  activity?: AgentActivity
  spaceId?: string | null
  taskId?: string | null
  courseId?: string | null
}

/** 带上乐观并发版本的状态（渲染端与主进程共用）。 */
export interface AgentProfileState extends AgentProfile {
  revision: number
}

export function isAgentProfileKind(value: unknown): value is AgentProfileKind {
  return typeof value === 'string' && (AGENT_PROFILES as readonly string[]).includes(value)
}

export function isAgentActivity(value: unknown): value is AgentActivity {
  return typeof value === 'string' && (AGENT_ACTIVITIES as readonly string[]).includes(value)
}

export function normalizeAgentProfileKind(value: unknown): AgentProfileKind {
  return isAgentProfileKind(value) ? value : DEFAULT_AGENT_PROFILE
}

export function normalizeAgentActivity(value: unknown): AgentActivity {
  return isAgentActivity(value) ? value : DEFAULT_AGENT_ACTIVITY
}

/**
 * 校验一份档案。
 *
 * 返回校验失败的原因（而不是默默修好）：`profile` / `activity` 是枚举，
 * 拼错就是拼错 —— T01-4 要求「结构化接口不符预期时显式报错」。
 * 可选 id 字段做形状校验（字符串、长度上限、无控制字符）。
 */
export function validateAgentProfile(
  raw: unknown
): { ok: true; profile: AgentProfile } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '档案不是对象' }
  const o = raw as Record<string, unknown>
  if (!isAgentProfileKind(o.profile)) return { ok: false, reason: `profile 取值非法：${String(o.profile)}` }
  if (!isAgentActivity(o.activity)) return { ok: false, reason: `activity 取值非法：${String(o.activity)}` }

  const out: AgentProfile = { profile: o.profile, activity: o.activity }
  for (const key of ['spaceId', 'taskId', 'courseId'] as const) {
    const value = o[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') return { ok: false, reason: `${key} 不是字符串` }
    const trimmed = value.trim()
    if (!trimmed) continue
    if (trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      return { ok: false, reason: `${key} 形状非法` }
    }
    out[key] = trimmed
  }
  return { ok: true, profile: out }
}

/**
 * 各活动**禁用**的工具。
 *
 * 用「禁哪些」而不是「留哪些」：pi 的工具表会随版本增减，白名单会在升级后
 * 悄悄把新工具挡在外面（症状是模型说「我没有工具」。`grep` / `find` / `ls`
 * 默认就不在激活集里，这类事实施-04 已经踩过一次）。
 *
 * ⚠️ **任何活动都不禁 `bash`**：`yan` 能力入口与只读查询都走它，
 * 禁掉就等于切断宿主能力通路（不变量 8）。
 */
const ACTIVITY_TOOL_DENY: Record<AgentActivity, readonly string[]> = {
  answer: [],
  /* 研究只读资料、不下结论式的改文件；结论交给成果对象（P06） */
  research: ['write', 'edit'],
  compose: [],
  organize: [],
  /* 导师只讲与问：写文件走成果对象，避免顺手改用户的代码与资料 */
  learn: ['write', 'edit']
}

/** 按活动过滤一份工具名列表（保持原顺序）。 */
export function filterToolsForActivity(activity: AgentActivity, tools: readonly string[]): string[] {
  const deny = ACTIVITY_TOOL_DENY[activity] ?? []
  return tools.filter((name) => !deny.includes(name))
}

export function activityDeniedTools(activity: AgentActivity): readonly string[] {
  return ACTIVITY_TOOL_DENY[activity] ?? []
}

/** 系统提示里的分区名（必须匹配 pi 的 `/^[a-z][a-z0-9_-]*$/`，且不能叫 preamble）。 */
export const ROLE_SECTION_NAME = 'yan_role'

export interface RoleSection {
  name: string
  content: string
}

/**
 * 生成注入系统提示的角色分区（纯函数）。
 *
 * 返回 `null` 表示**不注入**：`coding` 档案保持 pi 原生行为 ——
 * 「三种角色行为」里的第一种就是「不做任何改变」。
 */
export function agentRoleSection(profile: AgentProfileKind, activity: AgentActivity): RoleSection | null {
  if (profile !== 'daily') return null
  const body = DAILY_ROLE_BODY[activity]
  if (!body) return null
  return { name: ROLE_SECTION_NAME, content: body }
}

const DAILY_ROLE_BODY: Record<AgentActivity, string> = {
  answer: [
    '你正在「日常」模式里回答一个问题。',
    '- 直接回答，不要把问题展开成工程计划，也不要先去读无关文件。',
    '- 需要资料时先读再答；不需要就不读。',
    '- 用户用的是普通语言，回答也说普通语言，不要用内部的工具名与文件路径堆砌。'
  ].join('\n'),
  research: [
    '你正在「日常」模式里做研究。',
    '- 先把要回答的问题弄清楚，再把资料读全；不要只凭记忆下结论。',
    '- 每条结论都要能指出它来自哪份资料的哪一处。',
    '- 资料之间说法不一致时，把分歧如实保留下来，不要强行合成唯一答案。',
    '- 不要写文件：研究结论由宿主收进成果对象。'
  ].join('\n'),
  compose: [
    '你正在「日常」模式里创作。',
    '- 先确认这份内容给谁看、用来做什么，再动笔。',
    '- 先给提纲，再写初稿；不要一上来就产出长篇。',
    '- 用户改过的段落不要覆盖：改动按段进行，保留用户的写法与语气。'
  ].join('\n'),
  organize: [
    '你正在「日常」模式里整理资料。',
    '- 先说明你打算怎么分类、按什么命名，再动手。',
    '- 不要丢用户的资料；改名、移动、删除都要先说明影响。',
    '- 整理结果要能让人一眼看懂「哪些进了哪一类」。'
  ].join('\n'),
  learn: [
    '你正在给一位学习者当导师，不是替他把事情做完。',
    '- 先弄清他卡在哪、已经会了什么，再决定讲多少。',
    '- 一次只推进一小步；讲完就停下来等他回应，不要自问自答往下讲。',
    '- 他答错时先给提示，不要直接给答案。',
    '- 他独立完成之前，不要说「你已掌握」；练习与掌握以实际作答为准。',
    '- 保持同一位导师的连续性，不要在一轮里换几种讲解人格。'
  ].join('\n')
}
