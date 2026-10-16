import { AGENT_ACTIVITIES, type AgentActivity } from './agent-profile'

export interface ActivityModelConfig {
  defaultModel?: string | null
  byActivity?: Partial<Record<AgentActivity, string | null>>
}

export function emptyActivityModelConfig(): ActivityModelConfig {
  return { defaultModel: null, byActivity: {} }
}

const MAX_MODEL_LENGTH = 200

function normalizeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_MODEL_LENGTH) return null
  return trimmed
}

export function sanitizeActivityModelConfig(raw: unknown): ActivityModelConfig {
  if (!raw || typeof raw !== 'object') return emptyActivityModelConfig()
  const box = raw as { defaultModel?: unknown; byActivity?: unknown }
  const byActivity: Partial<Record<AgentActivity, string | null>> = {}
  if (box.byActivity && typeof box.byActivity === 'object') {
    for (const activity of AGENT_ACTIVITIES) {
      if (!(activity in (box.byActivity as Record<string, unknown>))) continue
      byActivity[activity] = normalizeModel((box.byActivity as Record<string, unknown>)[activity])
    }
  }
  return { defaultModel: normalizeModel(box.defaultModel), byActivity }
}

export function isActivityModelConfigEmpty(config: ActivityModelConfig | undefined): boolean {
  if (!config) return true
  if (config.defaultModel) return false
  return !Object.values(config.byActivity ?? {}).some((value) => !!value)
}

export function setActivityModel(
  config: ActivityModelConfig | undefined,
  activity: AgentActivity,
  model: string | null
): ActivityModelConfig {
  const base = sanitizeActivityModelConfig(config)
  return {
    defaultModel: base.defaultModel ?? null,
    byActivity: { ...(base.byActivity ?? {}), [activity]: normalizeModel(model) }
  }
}

export type ModelChoiceSource = 'activity' | 'default' | 'current' | 'none'

export interface ActivityModelResolution {
  activity: AgentActivity
  model: string | null
  source: ModelChoiceSource
  fellBack: boolean
  note: string
}

export interface ResolveActivityModelInput {
  config: ActivityModelConfig | undefined
  activity: AgentActivity
  current?: string | null
  available?: readonly string[]
}

export function resolveActivityModel(input: ResolveActivityModelInput): ActivityModelResolution {
  const config = sanitizeActivityModelConfig(input.config)
  const current = normalizeModel(input.current)
  const available = (input.available ?? []).map((item) => String(item).trim()).filter(Boolean)
  const usable = (model: string | null): boolean => !model || available.length === 0 || available.includes(model)

  const fromActivity = config.byActivity?.[input.activity] ?? null
  if (fromActivity) {
    if (usable(fromActivity)) {
      return {
        activity: input.activity,
        model: fromActivity,
        source: 'activity',
        fellBack: false,
        note: `这个活动指定了用 ${fromActivity}`
      }
    }
    return fallback(input.activity, current, `这个活动指定的 ${fromActivity} 现在不可用`)
  }

  const fromDefault = config.defaultModel ?? null
  if (fromDefault) {
    if (usable(fromDefault)) {
      return {
        activity: input.activity,
        model: fromDefault,
        source: 'default',
        fellBack: false,
        note: `这个活动没单独指定，用默认模型 ${fromDefault}`
      }
    }
    return fallback(input.activity, current, `默认模型 ${fromDefault} 现在不可用`)
  }

  if (current) {
    return {
      activity: input.activity,
      model: current,
      source: 'current',
      fellBack: false,
      note: `这个活动没配模型，跟随会话当前模型 ${current}`
    }
  }

  return {
    activity: input.activity,
    model: null,
    source: 'none',
    fellBack: false,
    note: '这个活动没配模型，也没有可跟随的会话模型：这次不指定模型'
  }
}

function fallback(activity: AgentActivity, current: string | null, reason: string): ActivityModelResolution {
  if (current) {
    return {
      activity,
      model: current,
      source: 'current',
      fellBack: true,
      note: `${reason}，已回退到会话当前模型 ${current}`
    }
  }
  return {
    activity,
    model: null,
    source: 'none',
    fellBack: true,
    note: `${reason}，而且没有可回退的会话模型：这次不指定模型`
  }
}

export const ACTIVITY_MODEL_SCOPE_NOTE =
  '换模型只影响「这一步用哪个模型」：不会新建会话、不会改当前活动与任务清单，也不会动课程与学习进度。'

export function activityModelScopeNote(): string {
  return ACTIVITY_MODEL_SCOPE_NOTE
}

export function activityModelText(resolution: ActivityModelResolution): string {
  return `${resolution.note}。${ACTIVITY_MODEL_SCOPE_NOTE}`
}

export interface ActivityModelRow {
  activity: AgentActivity
  configured: string | null
  resolution: ActivityModelResolution
}

export function activityModelRows(input: Omit<ResolveActivityModelInput, 'activity'>): ActivityModelRow[] {
  const config = sanitizeActivityModelConfig(input.config)
  return AGENT_ACTIVITIES.map((activity) => ({
    activity,
    configured: config.byActivity?.[activity] ?? null,
    resolution: resolveActivityModel({ ...input, activity })
  }))
}
