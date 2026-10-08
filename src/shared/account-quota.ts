/**
 * 「账号额度」磁贴的共享类型与纯函数：主进程拼数据、渲染端显示、单测共用同一份口径。
 * 这里不碰文件、网络和密钥；令牌只在主进程里解出身份，不会出现在这些类型里。
 */
import type { QuotaWindow } from './ipc'

/** 账号来源：砚自己登录的，或本机其它 CLI 的登录文件（只读，砚不刷新它们的令牌）。 */
export type AccountQuotaSource = 'yan' | 'codex-cli' | 'claude-code' | 'gemini-cli'
export type AccountQuotaCliSource = Exclude<AccountQuotaSource, 'yan'>
export const ACCOUNT_QUOTA_CLI_SOURCES: readonly AccountQuotaCliSource[] = ['codex-cli', 'claude-code', 'gemini-cli']

export interface AccountQuotaPrefs {
  /** 本机 CLI 来源开关；缺省全部关闭（读别的程序的登录文件要用户自己打开）。 */
  sources: Record<AccountQuotaCliSource, boolean>
  /** 账号 key → 用户备注 */
  labels: Record<string, string>
}

export type AccountQuotaStatus = 'ok' | 'limited' | 'expired' | 'error'

export interface AccountQuotaCard {
  /** 稳定身份，备注按它存。同一个 ChatGPT 账号在砚和 Codex CLI 里 key 相同。 */
  key: string
  source: AccountQuotaSource
  /** pi 的 provider 名或 CLI 的服务名，渲染端据此选字母标识 */
  provider: string
  /** 没有备注、也没有邮箱时显示的名字 */
  name: string
  label?: string
  email?: string
  plan?: string
  /** 砚当前正在用的 ChatGPT 账号 */
  active?: boolean
  /** 砚保存的 ChatGPT 账号：可切换、可移除 */
  switchable?: boolean
  /** 同一个账号还在哪些来源里登录着（去重后合并到砚的那张卡上） */
  alsoIn?: AccountQuotaSource[]
  status: AccountQuotaStatus
  /** expired 时告诉用户去哪里刷新 */
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

/** 设置页用的砚 ChatGPT 账号列表（不含凭证）。 */
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

/** 备注上限：一行能放下，又足够写「主号 · 公司」这类说明。 */
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

/** 卡片标题：备注 > 邮箱 > 默认名。 */
export function accountCardTitle(card: Pick<AccountQuotaCard, 'label' | 'email' | 'name'>): string {
  return card.label || card.email || card.name
}

/* ------------------------------------------------------------ ChatGPT 身份 */

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** 只取 JWT 的 payload，不校验签名（身份只用于显示与去重，不用于授权）。 */
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
  /** `chatgpt:<账号>:<用户>`。Team 工作区多人共用 account id，所以要连同用户一起区分。 */
  key?: string
  accountId?: string
  email?: string
  plan?: string
  /** access token 的过期时间（毫秒） */
  expiresAt?: number
}

/**
 * 从 ChatGPT 令牌里取身份。pi 的凭证只有 access token，Codex CLI 另有 id token；
 * 用户标识优先取 access token 里的，保证两边算出的 key 一样，才能去重。
 */
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

/* ------------------------------------------------------------ 用量响应解析 */

/**
 * 窗口长度（秒）→ 人话。接口给的是秒数，不写死「5 小时 / 每周」：
 * 套餐改了窗口长度时，写死的标签会骗人。
 */
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
  /** 秒级时间戳 */
  reset_at?: number
}

/** ChatGPT 订阅用量接口（`/backend-api/codex/usage`）的形状 */
export interface CodexUsagePayload {
  plan_type?: string
  rate_limit?: {
    allowed?: boolean
    limit_reached?: boolean
    primary_window?: CodexUsageWindow
    secondary_window?: CodexUsageWindow
  } | null
}

/** 数字是百分比（used_percent），所以 used/total 用 0–100 表示。 */
export function codexUsageWindows(payload: CodexUsagePayload): { plan?: string; windows: QuotaWindow[]; limited: boolean } {
  const rl = payload?.rate_limit
  const windows: QuotaWindow[] = []
  const add = (id: string, w?: CodexUsageWindow): void => {
    if (!w || !Number.isFinite(Number(w.used_percent))) return
    windows.push({
      id,
      // Codex 固定按短窗口和周窗口展示；用稳定名称而非“1 周”，更贴近套餐页面。
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

/** Claude 订阅用量（`/api/oauth/usage`）：每个窗口 `{ utilization: 百分比, resets_at }`，没开的窗口是 null。 */
export function claudeUsageWindows(payload: unknown): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  for (const [key, value] of Object.entries(obj(payload) ?? {})) {
    const w = obj(value)
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue
    const resetAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
    windows.push({
      id: key,
      label: CLAUDE_WINDOW_LABELS[key] ?? key.replace(/_/g, ' '),
      used: w.utilization,
      total: 100,
      resetAt: Number.isFinite(resetAt) ? resetAt : undefined,
      exceeded: w.utilization >= 100
    })
  }
  return windows
}

/** Gemini CLI 的 Code Assist 配额：按模型分桶，给的是**剩余**比例。 */
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

/* ------------------------------------------------------------ 汇总 */

/**
 * 同一个账号出现在多个来源时只留第一张（砚的卡排在前面），其余来源记进 `alsoIn`。
 * 额度按账号计，两张一样的卡只会让人以为有两份额度。
 */
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

/** 摘要用：一张卡里用得最多的窗口百分比；没有窗口时为 null。 */
export function cardPeakPercent(card: Pick<AccountQuotaCard, 'windows'>): number | null {
  let peak: number | null = null
  for (const w of card.windows) {
    if (!(w.total > 0)) continue
    const pct = (w.used / w.total) * 100
    if (peak === null || pct > peak) peak = pct
  }
  return peak
}
