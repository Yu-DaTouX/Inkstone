export const AGENT_PROFILES = ['auto', 'coding', 'daily'] as const
export type AgentProfileKind = (typeof AGENT_PROFILES)[number]

export const DEFAULT_AGENT_PROFILE: AgentProfileKind = 'auto'

export const AGENT_ACTIVITIES = ['answer', 'research', 'compose', 'organize', 'learn'] as const
export type AgentActivity = (typeof AGENT_ACTIVITIES)[number]

export const DEFAULT_AGENT_ACTIVITY: AgentActivity = 'answer'

export interface AgentProfile {
  profile: AgentProfileKind
  activity: AgentActivity
  spaceId?: string
  taskId?: string
  courseId?: string
}

export interface AgentProfilePatch {
  profile?: AgentProfileKind
  activity?: AgentActivity
  spaceId?: string | null
  taskId?: string | null
  courseId?: string | null
}

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

const ACTIVITY_TOOL_DENY: Record<AgentActivity, readonly string[]> = {
  answer: [],
  research: ['write', 'edit'],
  compose: [],
  organize: [],
  learn: []
}

export function filterToolsForActivity(activity: AgentActivity, tools: readonly string[]): string[] {
  const deny = ACTIVITY_TOOL_DENY[activity] ?? []
  return tools.filter((name) => !deny.includes(name))
}

export function activityDeniedTools(activity: AgentActivity): readonly string[] {
  return ACTIVITY_TOOL_DENY[activity] ?? []
}

export const ROLE_SECTION_NAME = 'yan_role'

export interface RoleSection {
  name: string
  content: string
}

export function agentRoleSection(profile: AgentProfileKind, activity: AgentActivity): RoleSection | null {
  const body = profile === 'coding' ? DOC_SYNC_BODY : profile === 'auto' ? AUTO_ROLE_BODY : DAILY_ROLE_BODY[activity]
  if (!body) return null
  return { name: ROLE_SECTION_NAME, content: body }
}

const DOC_SYNC_BODY = [
  '代码改完后同步相关文档：按实际改动更新描述这块行为的文档，已实现 / 未完成 / 建议分开写，不要借回填文档批准新的产品需求。',
  '收尾一轮代码改动前先读 `doc-sync` 技能（`yan skill read --id skill:doc-sync`）。'
].join('\n')

const AUTO_ROLE_BODY = [
  '你先判断这次请求是哪一类，再按那一类的方式做 —— 不要先问用户该用哪种模式。',
  '- 写代码、改文件、排错、看仓库 → 按代码助手工作：先读现有实现，改动最小，说清影响；改完同步相关文档（`doc-sync` 技能）。',
  '- 只是问一件事 → 直接回答；不要把它展开成工程计划，也不要先去读无关文件。',
  '- 要读资料、作比较、给结论 → 每条结论能指出出处，分歧如实保留。',
  '- 要写一份文档 → 先确认用途，先提纲后初稿，不覆盖用户改过的段落。',
  '- 要归类、命名、整理资料 → `organize` 技能：先说方案再动手，不丢资料。',
  '- 要学一样东西 → 一次推进一小步，讲完停下来等回应。',
  '技能用 `yan skill read --id skill:<名称>` 读取，开始这一类工作前先读。',
  '判断不了时，按「直接回答」处理，并在回答里说一句你按哪一类在做。'
].join('\n')

function dailyBody(title: string, core: string, skill?: string): string {
  const lines = [`你正在「日常」模式里${title}。`, core]
  if (skill) lines.push(`完整做法见 \`${skill}\` 技能（\`yan skill read --id skill:${skill}\`），开始前先读。`)
  return lines.join('\n')
}

const DAILY_ROLE_BODY: Record<AgentActivity, string> = {
  answer: [
    '你正在「日常」模式里回答一个问题。',
    '- 直接回答，不要把问题展开成工程计划，也不要先去读无关文件。',
    '- 需要资料时先读再答；不需要就不读。',
    '- 用户用的是普通语言，回答也说普通语言，不要用内部的工具名与文件路径堆砌。'
  ].join('\n'),
  research: dailyBody(
    '做研究',
    '每条结论都要能指出出处；资料之间有分歧就如实保留，不要强行合成唯一答案。这个活动不改文件。'
  ),
  compose: dailyBody('创作', '先确认给谁看、做什么用，先提纲后初稿；用户改过的段落不要覆盖。'),
  organize: dailyBody('整理资料', '先说明分类与命名方案再动手；不丢资料，改名、移动、删除先说明影响。', 'organize'),
  learn: dailyBody(
    '给一位学习者当导师',
    '默认引导式，一次推进一小步，讲完停下来等他回应；他要「直接讲」时切到解析式。不要替他作答，他独立完成之前不要说「你已掌握」。'
  )
}
