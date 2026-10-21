import type {
  CapabilityMcpServerSettingView,
  CapabilitySkillSettingView,
  CapabilityVerificationStatus,
  SlashCommand
} from '../../../../../shared/ipc'

export const SKILL_ORIGIN_ORDER = ['session', 'user', 'pi', 'other'] as const
export type SkillOrigin = (typeof SKILL_ORIGIN_ORDER)[number]

export function skillOriginOf(origin: string | undefined): SkillOrigin | 'bundled' {
  if (origin === 'bundled') return 'bundled'
  return (SKILL_ORIGIN_ORDER as readonly string[]).includes(origin ?? '')
    ? (origin as SkillOrigin)
    : 'other'
}

export interface SkillGroup {
  origin: SkillOrigin
  skills: CapabilitySkillSettingView[]
}

export function groupSkills(
  skills: readonly CapabilitySkillSettingView[]
): SkillGroup[] {
  const buckets = new Map<SkillOrigin, CapabilitySkillSettingView[]>()
  for (const origin of SKILL_ORIGIN_ORDER) buckets.set(origin, [])
  for (const skill of skills) {
    const origin = skillOriginOf(skill.origin)
    if (origin !== 'bundled') buckets.get(origin)!.push(skill)
  }
  return SKILL_ORIGIN_ORDER.map((origin) => ({ origin, skills: buckets.get(origin)! })).filter(
    (group) => group.skills.length > 0
  )
}

export function promptCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.filter((command) => command.source === 'prompt')
}

export const WINDOWS_MCP_SERVER_ID = 'windows-mcp'

export function canImportMcp(server: CapabilityMcpServerSettingView): boolean {
  return (
    !server.migratedToNative &&
    server.enabled &&
    server.ownedBy !== 'inkstone' &&
    server.id !== WINDOWS_MCP_SERVER_ID
  )
}

export type StatusTone = 'neutral' | 'accent' | 'run' | 'ask' | 'fail'

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

export const MARKET_PAGE_SIZE = 24

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
