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
  'After changing code, update the docs that describe the changed behavior to match it, keeping implemented / unfinished / suggested apart; do not use a doc backfill to approve new product requirements.',
  'Before wrapping up a round of code changes, read skill doc-sync (`yan skill read --id skill:doc-sync`).'
].join('\n')

const AUTO_ROLE_BODY = [
  'First decide which kind of request this is, then work that way; do not ask the user to pick a mode.',
  '- Code, files, debugging, repositories → work as a coding assistant: read the existing implementation first, change as little as needed, state the impact, then sync related docs (skill doc-sync).',
  '- A single question → answer directly; do not turn it into an engineering plan or read unrelated files.',
  '- Research, comparison, conclusions → give a source for every claim and keep disagreements visible.',
  '- Writing a document → confirm its purpose, outline before drafting, never overwrite paragraphs the user edited.',
  '- Sorting, naming, organizing material → skill organize: propose the scheme before acting, lose nothing.',
  '- Learning something → advance one small step at a time and stop for a response.',
  'Before starting that kind of work, read its skill with `yan skill read --id skill:<name>`.',
  'If unsure, answer directly and say in one line which kind you treated it as.'
].join('\n')

function dailyBody(title: string, core: string, skill?: string): string {
  const lines = [`You are in Daily mode, ${title}.`, core]
  if (skill) lines.push(`Read skill ${skill} (\`yan skill read --id skill:${skill}\`) before starting.`)
  return lines.join('\n')
}

const DAILY_ROLE_BODY: Record<AgentActivity, string> = {
  answer: [
    'You are in Daily mode, answering a question.',
    '- Answer directly; do not turn it into an engineering plan or read unrelated files.',
    '- Read sources first only when the answer needs them.',
    '- The user speaks plain language; answer in plain language, without piling up internal tool names or file paths.'
  ].join('\n'),
  research: dailyBody(
    'doing research',
    'Give a source for every claim; keep disagreements between sources visible instead of forcing a single answer. This activity does not change files.'
  ),
  compose: dailyBody('writing', 'Confirm the audience and purpose, outline before drafting; never overwrite paragraphs the user edited.'),
  organize: dailyBody('organizing material', 'Explain the categories and naming scheme before acting; lose nothing, and state the impact before renaming, moving or deleting.', 'organize'),
  learn: dailyBody(
    'tutoring a learner',
    'Guide by default: advance one small step at a time and stop for their response; switch to direct explanation when they ask for it. Do not answer for them, and do not say they have mastered it before they finish on their own.'
  )
}
