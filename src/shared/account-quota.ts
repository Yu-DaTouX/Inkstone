import type { QuotaWindow } from './ipc'

export type AccountQuotaSource = 'yan' | 'codex-cli' | 'claude-code' | 'gemini-cli'
export type AccountQuotaCliSource = Exclude<AccountQuotaSource, 'yan'>
export const ACCOUNT_QUOTA_CLI_SOURCES: readonly AccountQuotaCliSource[] = ['codex-cli', 'claude-code', 'gemini-cli']

export interface AccountQuotaPrefs {
  sources: Record<AccountQuotaCliSource, boolean>
  labels: Record<string, string>
}

export type AccountQuotaStatus = 'ok' | 'limited' | 'expired' | 'error'

export interface AccountQuotaCard {
  key: string
  source: AccountQuotaSource
  provider: string
  name: string
  label?: string
  email?: string
  plan?: string
  active?: boolean
  switchable?: boolean
  alsoIn?: AccountQuotaSource[]
  status: AccountQuotaStatus
  hint?: string
  error?: string
  windows: QuotaWindow[]
  balance?: { label: string; amount: number; currency: string }
  checkedAt: number
}

export interface AccountQuotaReport {
  cards: AccountQuotaCard[]
  prefs: AccountQuotaPrefs
  checkedAt: number
}

export interface CodexAccountView {
  key: string
  email?: string
  plan?: string
  label?: string
  active: boolean
}

export const DEFAULT_ACCOUNT_QUOTA_PREFS: AccountQuotaPrefs = {
  sources: { 'codex-cli': false, 'claude-code': false, 'gemini-cli': false },
  labels: {}
}

export const ACCOUNT_LABEL_MAX = 40

export function normalizeAccountLabel(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, ACCOUNT_LABEL_MAX) : ''
}

export function normalizeAccountQuotaPrefs(raw: unknown): AccountQuotaPrefs {
  const src = (raw && typeof raw === 'object' ? raw : {}) as { sources?: unknown; labels?: unknown }
  const sources = { ...DEFAULT_ACCOUNT_QUOTA_PREFS.sources }
  if (src.sources && typeof src.sources === 'object') {
    for (const id of ACCOUNT_QUOTA_CLI_SOURCES) sources[id] = (src.sources as Record<string, unknown>)[id] === true
  }
  const labels: Record<string, string> = {}
  if (src.labels && typeof src.labels === 'object') {
    for (const [key, value] of Object.entries(src.labels as Record<string, unknown>)) {
      const label = normalizeAccountLabel(value)
      if (key && label) labels[key] = label
    }
  }
  return { sources, labels }
}

export function accountCardTitle(card: Pick<AccountQuotaCard, 'label' | 'email' | 'name'>): string {
  return card.label || card.email || card.name
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

export function decodeJwtClaims(token: unknown): Record<string, unknown> {
  if (typeof token !== 'string') return {}
  const part = token.split('.')[1]
  if (!part) return {}
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return obj(JSON.parse(new TextDecoder().decode(bytes))) ?? {}
  } catch {
    return {}
  }
}

export interface ChatGptIdentity {
  key?: string
  accountId?: string
  email?: string
  plan?: string
  expiresAt?: number
}

export function chatGptIdentity(accessToken: unknown, idToken?: unknown, fallbackAccountId?: string): ChatGptIdentity {
  const access = decodeJwtClaims(accessToken)
  const id = decodeJwtClaims(idToken)
  const authA = obj(access['https://api.openai.com/auth']) ?? {}
  const authI = obj(id['https://api.openai.com/auth']) ?? {}
  const profile = obj(access['https://api.openai.com/profile']) ?? {}
  const accountId = str(authA.chatgpt_account_id) ?? str(authI.chatgpt_account_id) ?? fallbackAccountId
  const email = str(profile.email) ?? str(id.email)
  const user = str(authA.chatgpt_user_id) ?? str(authI.chatgpt_user_id) ?? str(authA.user_id) ?? str(authI.user_id) ?? email ?? ''
  return {
    key: accountId ? `chatgpt:${accountId}:${user}` : undefined,
    accountId,
    email,
    plan: str(authA.chatgpt_plan_type) ?? str(authI.chatgpt_plan_type),
    expiresAt: typeof access.exp === 'number' ? access.exp * 1000 : undefined
  }
}

export function quotaWindowLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '额度'
  const hours = seconds / 3600
  if (hours < 24) return `${Math.round(hours)} 小时`
  const days = hours / 24
  if (days < 7) return `${Math.round(days)} 天`
  if (days < 30) return `${Math.round(days / 7)} 周`
  return `${Math.round(days / 30)} 个月`
}

interface CodexUsageWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
}

export interface CodexUsagePayload {
  plan_type?: string
  rate_limit?: {
    allowed?: boolean
    limit_reached?: boolean
    primary_window?: CodexUsageWindow
    secondary_window?: CodexUsageWindow
  } | null
}

export function codexUsageWindows(payload: CodexUsagePayload): { plan?: string; windows: QuotaWindow[]; limited: boolean } {
  const rl = payload?.rate_limit
  const windows: QuotaWindow[] = []
  const add = (id: string, w?: CodexUsageWindow): void => {
    if (!w || !Number.isFinite(Number(w.used_percent))) return
    windows.push({
      id,
      label: id === 'primary' ? '五小时' : id === 'secondary' ? '本周' : quotaWindowLabel(Number(w.limit_window_seconds)),
      used: Number(w.used_percent),
      total: 100,
      resetAt: Number.isFinite(Number(w.reset_at)) ? Number(w.reset_at) * 1000 : undefined,
      exceeded: false
    })
  }
  add('primary', rl?.primary_window)
  add('secondary', rl?.secondary_window)
  return {
    plan: typeof payload?.plan_type === 'string' && payload.plan_type ? payload.plan_type : undefined,
    windows,
    limited: !!rl && (rl.limit_reached === true || rl.allowed === false)
  }
}

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: '五小时',
  seven_day: '本周',
  seven_day_opus: '本周 · Opus',
  seven_day_sonnet: '本周 · Sonnet',
  seven_day_oauth_apps: '本周 · 第三方应用',
  extra_usage: '额外用量'
}

export function claudeUsageWindows(payload: unknown): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  for (const [key, value] of Object.entries(obj(payload) ?? {})) {
    const w = obj(value)
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue
    const resetAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
    const listed = key in CLAUDE_WINDOW_LABELS
    windows.push({
      id: key,
      ...(listed ? {} : { informational: true }),
      label: CLAUDE_WINDOW_LABELS[key] ?? `其他限额 · ${key.replace(/_/g, ' ')}`,
      used: w.utilization,
      total: 100,
      resetAt: Number.isFinite(resetAt) ? resetAt : undefined,
      exceeded: listed && w.utilization >= 100
    })
  }
  return windows
}

export function geminiQuotaWindows(payload: unknown): QuotaWindow[] {
  const buckets = obj(payload)?.buckets
  if (!Array.isArray(buckets)) return []
  const seen = new Set<string>()
  const windows: QuotaWindow[] = []
  for (const raw of buckets) {
    const b = obj(raw)
    const model = str(b?.modelId)
    if (!b || !model || typeof b.remainingFraction !== 'number') continue
    const type = str(b.tokenType)
    const label = type && type !== 'REQUESTS' ? `${model} (${type})` : model
    if (seen.has(label)) continue
    seen.add(label)
    const resetAt = typeof b.resetTime === 'string' ? Date.parse(b.resetTime) : NaN
    const used = Math.round((1 - b.remainingFraction) * 1000) / 10
    windows.push({ id: label, label, used, total: 100, resetAt: Number.isFinite(resetAt) ? resetAt : undefined, exceeded: b.remainingFraction <= 0 })
  }
  return windows.sort((a, b) => a.label.localeCompare(b.label))
}

export function mergeDuplicateCards(cards: AccountQuotaCard[]): AccountQuotaCard[] {
  const out: AccountQuotaCard[] = []
  const byKey = new Map<string, AccountQuotaCard>()
  for (const card of cards) {
    const kept = byKey.get(card.key)
    if (!kept) {
      const copy = { ...card }
      byKey.set(card.key, copy)
      out.push(copy)
      continue
    }
    if (kept.source !== card.source && !kept.alsoIn?.includes(card.source)) kept.alsoIn = [...(kept.alsoIn ?? []), card.source]
  }
  return out
}

export function orderAccountCardsForProvider(cards: readonly AccountQuotaCard[], provider: string): AccountQuotaCard[] {
  const want = provider.trim().toLowerCase()
  if (!want) return [...cards]
  const index = cards.findIndex((card) => card.provider.trim().toLowerCase() === want)
  if (index <= 0) return [...cards]
  return [cards[index], ...cards.slice(0, index), ...cards.slice(index + 1)]
}

export function cardPeakPercent(card: Pick<AccountQuotaCard, 'windows'>): number | null {
  let peak: number | null = null
  for (const w of card.windows) {
    if (!(w.total > 0)) continue
    const pct = (w.used / w.total) * 100
    if (peak === null || pct > peak) peak = pct
  }
  return peak
}
