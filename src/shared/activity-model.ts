/**
 * 按活动配置模型（实施-25 P18）的**契约层 + 纯逻辑**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 解决什么
 * ══════════════════════════════════════════════════════════════════
 * `answer` / `research` / `compose` / `organize` / `learn` 这五个活动
 * （`agent-profile.ts` 已有的划分）对模型的要求不一样：读一堆资料作比较
 * 与研究结论，和一句简单问答并不是同一件事。这里让用户能**按活动指定用哪个模型**，
 * 并给出一个可解释的解析结果。
 *
 * ── 三条边界 ──
 *  ① **优先级固定且可解释**：活动指定 → 默认模型 → 跟随会话当前模型。
 *     解析结果里带 `source`，界面 / 命令都能回答「为什么是这个模型」。
 *  ② **回退要如实说**（T18-2）：配置的模型现在不可用时，回退到会话当前模型
 *     并标 `fellBack: true`；连可回退的都没有就**不指定模型**（而不是硬塞一个）。
 *  ③ **不改变任务身份与学习状态**（T18-3）：这个模块只回答「该用哪个模型」——
 *     函数签名里**没有**会话、课程、学习阶段这些参数。换模型不等于换任务。
 *
 * 它不碰 electron / pi / 文件系统，主进程与单测共用同一份规则。
 */

import { AGENT_ACTIVITIES, type AgentActivity } from './agent-profile'

/** 一条活动的模型选择（`null` = 用默认）。 */
export interface ActivityModelConfig {
  /** 默认模型：活动没单独指定时用它。`null` / 缺省 = 跟随会话当前模型。 */
  defaultModel?: string | null
  /** 按活动指定。 */
  byActivity?: Partial<Record<AgentActivity, string | null>>
}

export function emptyActivityModelConfig(): ActivityModelConfig {
  return { defaultModel: null, byActivity: {} }
}

const MAX_MODEL_LENGTH = 200

/** 认不出 / 空串一律当「没指定」（`null`），不编一个模型名。 */
function normalizeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_MODEL_LENGTH) return null
  return trimmed
}

/**
 * 读盘 / 写入用的清洗。
 *
 * 与其它设置同一立场：**认不出的丢掉**，绝不让一个乱字符串变成
 * 「这个活动用某个不存在的模型」。
 */
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

/** 这个配置是不是「什么都没配」（界面据此显示「跟默认」而不是一堆空行）。 */
export function isActivityModelConfigEmpty(config: ActivityModelConfig | undefined): boolean {
  if (!config) return true
  if (config.defaultModel) return false
  return !Object.values(config.byActivity ?? {}).some((value) => !!value)
}

/** 改一个活动的模型（`null` = 恢复成用默认）。 */
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

/** 模型最终是从哪一层来的（可解释性）。 */
export type ModelChoiceSource = 'activity' | 'default' | 'current' | 'none'

export interface ActivityModelResolution {
  activity: AgentActivity
  /** 最终该用哪个模型；`null` = 不指定，跟随会话。 */
  model: string | null
  source: ModelChoiceSource
  /** 配置的模型当前不可用，已回退。 */
  fellBack: boolean
  /** 一句话解释（界面与命令直接用）。 */
  note: string
}

export interface ResolveActivityModelInput {
  config: ActivityModelConfig | undefined
  activity: AgentActivity
  /** 会话当前模型（回退目标）。 */
  current?: string | null
  /**
   * 当前可用模型清单（模型 key，如 `deepseek/deepseek-v4.1-flash`）。
   * 空数组 / 缺省 = 不做可用性检查（此时不回退）。
   */
  available?: readonly string[]
}

/**
 * 解析某个活动该用哪个模型。
 *
 * 优先级：**活动指定 → 默认 → 跟随会话**。配置的模型不在可用清单里时回退到
 * 会话当前模型；连当前模型也没有就不指定（`source: 'none'`）——
 * 这里刻意不挑「清单里的第一个」：替用户随便挑一个模型，比不指定更糟。
 */
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

/**
 * 「换模型不改变任务身份与学习状态」—— 这句话固定下来，界面与命令共用。
 *
 * 它是有意的**文案约束**：不写清的话，用户会以为换模型等于换会话 / 重开课程。
 */
export const ACTIVITY_MODEL_SCOPE_NOTE =
  '换模型只影响「这一步用哪个模型」：不会新建会话、不会改当前活动与任务清单，也不会动课程与学习进度。'

export function activityModelScopeNote(): string {
  return ACTIVITY_MODEL_SCOPE_NOTE
}

/** 一句话说明（设置页与命令共用，含那条边界）。 */
export function activityModelText(resolution: ActivityModelResolution): string {
  return `${resolution.note}。${ACTIVITY_MODEL_SCOPE_NOTE}`
}

/** 设置页的一行：活动 + 它的当前选择说明。 */
export interface ActivityModelRow {
  activity: AgentActivity
  /** 配置里这一项的值（`null` = 跟默认）。 */
  configured: string | null
  resolution: ActivityModelResolution
}

/** 五个活动各自会用什么模型（设置页与命令的同一份视图）。 */
export function activityModelRows(input: Omit<ResolveActivityModelInput, 'activity'>): ActivityModelRow[] {
  const config = sanitizeActivityModelConfig(input.config)
  return AGENT_ACTIVITIES.map((activity) => ({
    activity,
    configured: config.byActivity?.[activity] ?? null,
    resolution: resolveActivityModel({ ...input, activity })
  }))
}
