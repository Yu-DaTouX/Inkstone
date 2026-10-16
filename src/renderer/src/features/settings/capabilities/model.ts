/**
 * 能力与插件设置的纯逻辑（WP-45 / S2）。
 *
 * 不 import React、不读 store、不碰 DOM：入参全是主进程返回值或 store 快照，
 * 便于 `scripts/test-v3-capability-settings.mjs` 在 Node 里直接钉死。
 * 组件只负责画、绑事件、调正式 IPC。
 *
 * 这里的分组 / 状态映射只做「如实投影」：不猜连接状态、不把目录信息当验证结果。
 */
import type {
  CapabilityMcpServerSettingView,
  CapabilitySkillSettingView,
  CapabilityVerificationStatus,
  SlashCommand
} from '../../../../../shared/ipc'

/* ── 技能：按来源分组 ───────────────────────────────────────── */

/** 分组顺序固定：本次会话在最前（可操作），其后是用户自装、随包、其它。 */
export const SKILL_ORIGIN_ORDER = ['session', 'user', 'bundled', 'other'] as const
export type SkillOrigin = (typeof SKILL_ORIGIN_ORDER)[number]

/** 老版本快照没有 `origin`：按 pi 原生 / 项目来源归到 `other`，不假装是随包。 */
export function skillOriginOf(origin: string | undefined): SkillOrigin {
  return (SKILL_ORIGIN_ORDER as readonly string[]).includes(origin ?? '')
    ? (origin as SkillOrigin)
    : 'other'
}

export interface SkillGroup {
  origin: SkillOrigin
  skills: CapabilitySkillSettingView[]
}

/** 空组不返回（界面不画空标题），组内保持主进程给的顺序。 */
export function groupSkills(
  skills: readonly CapabilitySkillSettingView[]
): SkillGroup[] {
  const buckets = new Map<SkillOrigin, CapabilitySkillSettingView[]>()
  for (const origin of SKILL_ORIGIN_ORDER) buckets.set(origin, [])
  for (const skill of skills) buckets.get(skillOriginOf(skill.origin))!.push(skill)
  return SKILL_ORIGIN_ORDER.map((origin) => ({ origin, skills: buckets.get(origin)! })).filter(
    (group) => group.skills.length > 0
  )
}

/* ── 提示词：从命令注册表里取 prompt 来源 ───────────────────── */

/**
 * 提示词没有独立设置接口，只能读当前 pi 会话的命令注册表（`yan:listCommands`）。
 * 未连接会话时返回空数组，界面必须显示「需要已连接会话」而不是「没有提示词」。
 */
export function promptCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.filter((command) => command.source === 'prompt')
}

/* ── MCP：状态色与导入资格 ─────────────────────────────────── */

export const WINDOWS_MCP_SERVER_ID = 'windows-mcp'

/**
 * 能否走「导入到 pi 原生」。
 * 已迁移的不重复导入；停用的不导入；windows-mcp 由电脑操作使用，按约定保留在砚里。
 */
export function canImportMcp(server: CapabilityMcpServerSettingView): boolean {
  return !server.migratedToNative && server.enabled && server.id !== WINDOWS_MCP_SERVER_ID
}

export type StatusTone = 'neutral' | 'accent' | 'run' | 'ask' | 'fail'

/** 快照里的连接状态 → 徽标色。`disconnected` 是「未连接」，不是失败。 */
export function mcpStatusTone(status: CapabilityMcpServerSettingView['status']): StatusTone {
  switch (status) {
    case 'ready':
      return 'run'
    case 'connecting':
      return 'accent'
    case 'needs-auth':
      return 'ask'
    case 'error':
      return 'fail'
    default:
      return 'neutral'
  }
}

/** 用户主动「检查」后的操作状态 → 徽标色。stale 不是成功也不是失败。 */
export function verificationTone(state: CapabilityVerificationStatus['state']): StatusTone {
  switch (state) {
    case 'ready':
      return 'run'
    case 'connecting':
      return 'accent'
    case 'error':
      return 'fail'
    default:
      return 'neutral'
  }
}

/* ── 市场：分页区间 ─────────────────────────────────────────── */

export const MARKET_PAGE_SIZE = 24

/** 翻页文案用的区间；总数 0 时 from 也是 0，界面据此不显示「1 – 0 / 0」。 */
export function marketRange(
  total: number,
  offset: number,
  size: number = MARKET_PAGE_SIZE
): { from: number; to: number; safeOffset: number } {
  const safeTotal = Math.max(0, Math.floor(total))
  const lastPageStart = safeTotal === 0 ? 0 : Math.floor((safeTotal - 1) / size) * size
  const safeOffset = Math.min(Math.max(0, Math.floor(offset)), lastPageStart)
  return {
    from: safeTotal === 0 ? 0 : safeOffset + 1,
    to: Math.min(safeTotal, safeOffset + size),
    safeOffset
  }
}
