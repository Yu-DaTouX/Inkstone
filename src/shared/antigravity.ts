export const ANTIGRAVITY_PROVIDER = 'antigravity'
export const ANTIGRAVITY_QUOTA_REFRESH_MS = 60_000
export const ANTIGRAVITY_QUOTA_STALE_MS = 5 * ANTIGRAVITY_QUOTA_REFRESH_MS

export interface AntigravityQuotaWindow {
  id: string
  name: string
  period: string
  remainingFraction: number
  resetAt?: number
}

export interface AntigravityQuotaGroup {
  name: string
  models: string[]
  windows: AntigravityQuotaWindow[]
}

export interface AntigravityQuotaSnapshot {
  checkedAt: number
  groups: AntigravityQuotaGroup[]
  error?: string
  staleSince?: number
}

export function antigravityQuotaFailure(previous: AntigravityQuotaSnapshot | undefined, checkedAt: number, error: string): AntigravityQuotaSnapshot {
  const staleSince = previous?.staleSince ?? previous?.checkedAt
  return previous?.groups.length && staleSince !== undefined && checkedAt - staleSince < ANTIGRAVITY_QUOTA_STALE_MS
    ? { checkedAt, groups: previous.groups, error, staleSince }
    : { checkedAt, groups: [], error }
}

export interface AntigravityModel {
  id: string
  name: string
}

export interface AntigravityImage {
  data: string
  mimeType: string
}

export interface AntigravityModels {
  current: string | null
  available: AntigravityModel[]
  thinking?: AntigravityChoice
  mode?: string
  modes?: AntigravityChoice
  supportsImages?: boolean
  supportsEmbeddedContext?: boolean
}

export interface AntigravityChoice { current: string; options: AntigravityModel[] }
export interface AntigravityContext { used: number; size: number }
export interface AntigravityUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  cost?: number
  visibleOutput?: number
}

export interface AntigravityTurnData {
  context?: AntigravityContext
  usage?: AntigravityUsage
  outputSpanMs?: number
}

export interface AntigravitySessionView {
  thinking?: AntigravityChoice
  mode?: string
  modes?: AntigravityChoice
  bridgeConfigured?: boolean
  mcpServers?: string[]
}

export const ANTIGRAVITY_APPROVAL_MODE = 'default'
export function isAntigravityMode(mode: unknown): mode is string {
  return mode === ANTIGRAVITY_APPROVAL_MODE || mode === 'accept-edits' || mode === 'auto' || mode === 'plan'
}

export interface AntigravityPlanEntry {
  content: string
  status: 'pending' | 'running' | 'done'
  priority?: string
}

export type AntigravityEvent =
  | { type: 'text' | 'thought'; text: string }
  | ({ type: 'context' } & AntigravityContext)
  | { type: 'usage'; usage: AntigravityUsage }
  | { type: 'plan'; entries: AntigravityPlanEntry[] }
  | { type: 'tool'; id: string; title?: string; status?: string; kind?: string; args?: unknown; output?: string; diffs: Array<{ path: string; oldText: string | null; newText: string }> }
  | { type: 'models'; models: AntigravityModels }
  | { type: 'permission'; id: number; title: string; detail: string; blocked?: string; options: Array<{ id: string; name: string; allow: boolean }> }
  | { type: 'permission-cleared'; id: number }
  | { type: 'closed'; error: string }

export const ANTIGRAVITY_PROMPT_LIMIT = 100_000

export interface AntigravityBridge {
  discover(cwd: string): Promise<AntigravityModels>
  quota(force?: boolean): Promise<AntigravityQuotaSnapshot>
  setMode(mode: string, expected: import('./ipc').ExpectedRuntimeOwner): Promise<{ ok: boolean; error?: string }>
}
