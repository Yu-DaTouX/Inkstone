import { pick } from '../shared/ui-lang'
import { net } from 'electron'
import { createHash } from 'node:crypto'
import { customCommandCodeQuotaProviders, resolveQuotaProviderCredential } from './quota-credentials'
import { fetchCodexUsage, providerQuota } from './quota'
import { claudeUsage, forgetClaudeUsage } from './claude-usage'
import { quotaSamples } from './quota-samples'
import { codexAccountTargets, type CodexAccountTarget } from './codex-accounts'
import { oauthAccountTargets, type OAuthAccountTarget } from './oauth-accounts'
import {
  claudeResetCredits,
  claudeUsageWindows,
  CLAUDE_OAUTH_HEADERS,
  codexResetCredits,
  mergeDuplicateCards,
  type AccountQuotaCard,
  type AccountQuotaReport,
  type ResetCreditOutcome,
  type ResetCreditResult,
  type ResetCredits
} from '../shared/account-quota'

const TIMEOUT_MS = 12_000
const http = net.fetch.bind(net)

const KEY_PROVIDERS: Array<{ id: string; name: string }> = [
  { id: 'commandcode', name: 'Command Code' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openrouter', name: 'OpenRouter' }
]

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await http(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? pick(`登录已失效（HTTP ${res.status}）`, `Sign-in expired (HTTP ${res.status})`) : `HTTP ${res.status}`)
  return res.json()
}

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return pick('请求超时', 'Request timed out')
  if (/fetch failed|ERR_|ENOTFOUND|ECONN/i.test(msg)) return pick(`连不上服务器（${msg}）`, `Cannot reach the server (${msg})`)
  return msg
}

type CardBase = Omit<AccountQuotaCard, 'status' | 'windows' | 'checkedAt'>

async function settle(base: CardBase, run: () => Promise<Partial<AccountQuotaCard>>): Promise<AccountQuotaCard> {
  const card: AccountQuotaCard = { ...base, status: 'ok', windows: [], checkedAt: Date.now() }
  try {
    return { ...card, ...(await run()), checkedAt: Date.now() }
  } catch (e) {
    return { ...card, status: 'error', error: friendly(e) }
  }
}

const limitedIf = (windows: AccountQuotaCard['windows']): 'limited' | 'ok' => (windows.some((w) => !w.informational && w.total > 0 && w.used >= w.total) ? 'limited' : 'ok')

function yanCodexCard(t: CodexAccountTarget): Promise<AccountQuotaCard> {
  const base: CardBase = { key: t.key, source: 'yan', provider: 'openai-codex', name: 'ChatGPT', email: t.email, plan: t.plan, active: t.active, switchable: true }
  return settle(base, async () => {
    if (!t.credential) {
      return t.problem === 'expired'
        ? { status: 'expired', hint: pick('登录令牌已过期，下次对话时 pi 会自动刷新。', 'Sign-in token expired. pi refreshes it on the next chat.') }
        : { status: 'error', error: t.problem ?? pick('没有可用的登录凭证', 'No usable sign-in credentials') }
    }
    const [usage, resetCredits] = await Promise.all([
      fetchCodexUsage(t.credential.access, t.credential.accountId),
      codexCredits(t.credential.access, t.credential.accountId)
    ])
    return { plan: usage.plan ?? t.plan, windows: usage.windows, status: usage.limited ? 'limited' : 'ok', ...(resetCredits ? { resetCredits } : {}) }
  })
}

function yanClaudeCard(account: OAuthAccountTarget): Promise<AccountQuotaCard> {
  return settle({ key: account.key, source: 'yan', provider: 'anthropic', name: 'Claude', email: account.email, label: account.label, active: account.active, switchable: true }, async () => {
    if (account.credential.expires <= Date.now()) return { status: 'expired', hint: pick('登录令牌已过期，切换后用 Claude 模型对话时 pi 会自动刷新。', 'Sign-in token expired. pi refreshes it when you chat with a Claude model after switching.') }
    const usage = await claudeUsage(account.credential.access) as { cedar_ember?: unknown }
    const windows = claudeUsageWindows(usage)
    const resetCredits = claudeResetCredits(usage?.cedar_ember, Date.now())
    return { windows, status: limitedIf(windows), ...(resetCredits ? { resetCredits } : {}) }
  })
}

function yanOpenRouterCard(account: OAuthAccountTarget): Promise<AccountQuotaCard> {
  return settle({ key: account.key, source: 'yan', provider: 'openrouter', name: 'OpenRouter', email: account.email, label: account.label, active: account.active, switchable: true }, async () => {
    const payload = await getJson('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${account.credential.access}` } }) as { data?: { total_credits?: number; total_usage?: number } }
    const amount = Number(payload.data?.total_credits) - Number(payload.data?.total_usage)
    if (!Number.isFinite(amount)) throw new Error(pick('服务未返回余额', 'The service returned no balance'))
    return { balance: { label: pick('余额', 'Balance'), amount: Math.max(0, amount), currency: 'USD' } }
  })
}

async function yanKeyCard(provider: { id: string; name: string; quotaProvider?: string }): Promise<AccountQuotaCard | null> {
  const { secret, error } = await resolveQuotaProviderCredential(provider.id, { quotaProvider: provider.quotaProvider })
  if (error) return { key: `yan:${provider.id}:configuration`, source: 'yan', provider: provider.id, name: provider.name, status: 'error', windows: [], checkedAt: Date.now(), error }
  if (!secret) return null
  const identity = createHash('sha256').update(secret).digest('hex').slice(0, 24)
  return settle({ key: `yan:${provider.id}:${identity}`, source: 'yan', provider: provider.id, name: provider.name }, async () => {
    const q = await providerQuota(provider.quotaProvider ?? provider.id, undefined, secret)
    const windows = q.windows ?? []
    const hasData = windows.length > 0 || q.remaining !== undefined
    if (q.error && !hasData) return { status: 'error', error: q.error }
    const balance = !windows.length && q.remaining !== undefined ? { label: pick('余额', 'Balance'), amount: q.remaining, currency: q.currency ?? 'USD' } : undefined
    return { windows, balance, status: limitedIf(windows) }
  })
}

const CODEX_CREDIT_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const CLAUDE_API = 'https://api.anthropic.com'
const CLAUDE_HEADERS = { ...CLAUDE_OAUTH_HEADERS, 'Content-Type': 'application/json' }

function codexHeaders(accessToken: string, accountId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Chatgpt-Account-Id': accountId,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'OpenAI-Beta': 'codex-1',
    Originator: 'Codex Desktop'
  }
}

async function codexCredits(accessToken: string, accountId: string): Promise<ResetCredits | undefined> {
  try {
    return codexResetCredits(await getJson(CODEX_CREDIT_URL, { headers: codexHeaders(accessToken, accountId) }), Date.now())
  } catch {
    return undefined
  }
}

function stableRequestId(seed: string): string {
  const bytes = createHash('sha1').update(seed).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await http(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) })
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  return { status: res.status, json }
}

const CODEX_OUTCOMES: Record<string, ResetCreditOutcome> = { reset: 'reset', nothing_to_reset: 'nothingToReset', no_credit: 'noCredit', already_redeemed: 'alreadyRedeemed' }
const CLAUDE_OUTCOMES: Record<string, ResetCreditOutcome> = { reset: 'reset', not_limited: 'nothingToReset', already_used: 'alreadyRedeemed', ineligible: 'noCredit' }

async function consumeCodexCredit(key: string, creditId: string): Promise<ResetCreditResult> {
  const target = (await codexAccountTargets()).find((t) => t.key === key)
  if (!target?.credential) return { ok: false, error: pick('账号登录已失效', 'Account sign-in expired') }
  const { access, accountId } = target.credential
  const { status, json } = await postJson(`${CODEX_CREDIT_URL}/consume`, codexHeaders(access, accountId), {
    redeem_request_id: stableRequestId(`${accountId}:${creditId}`),
    credit_id: creditId
  })
  if (status === 401 || status === 403) return { ok: false, error: pick(`登录已失效（HTTP ${status}）`, `Sign-in expired (HTTP ${status})`) }
  const outcome = typeof json.code === 'string' ? CODEX_OUTCOMES[json.code] : undefined
  if (status < 200 || status >= 300 || !outcome) return { ok: false, error: `HTTP ${status}` }
  return { ok: true, outcome }
}

async function consumeClaudeCredit(key: string, grantId: string): Promise<ResetCreditResult> {
  if (!/^[a-z0-9_-]{1,40}$/.test(grantId)) return { ok: false, error: pick('重置卡编号无效', 'Invalid reset card id') }
  const account = (await oauthAccountTargets('anthropic')).find((a) => a.key === key)
  if (!account) return { ok: false, error: pick('找不到该账号', 'Account not found') }
  if (account.credential.expires <= Date.now()) return { ok: false, error: pick('登录令牌已过期', 'Sign-in token expired') }
  const headers = { Authorization: `Bearer ${account.credential.access}`, ...CLAUDE_HEADERS }
  const profile = await getJson(`${CLAUDE_API}/api/oauth/profile`, { headers }) as { organization?: { uuid?: unknown } }
  const organization = typeof profile.organization?.uuid === 'string' ? profile.organization.uuid : ''
  if (!organization) return { ok: false, error: pick('读不到账号所属组织', 'Cannot read the account organization') }
  const { status, json } = await postJson(`${CLAUDE_API}/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`, headers, {
    program: 'cedar_ember',
    grant_id: grantId,
    request_id: stableRequestId(`${key}:${grantId}`)
  })
  if (status === 401 || status === 403) return { ok: false, error: pick(`登录已失效（HTTP ${status}）`, `Sign-in expired (HTTP ${status})`) }
  if (status === 429) return { ok: false, error: pick('请求太频繁，稍后再试', 'Too many requests. Try again later') }
  if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}` }
  if (json.result === 'cooldown') return { ok: false, error: pick('重置冷却中，稍后再试', 'Reset is cooling down. Try again later') }
  const outcome = typeof json.result === 'string' ? CLAUDE_OUTCOMES[json.result] : undefined
  return outcome ? { ok: true, outcome } : { ok: false, error: pick('未确认是否重置成功，稍后刷新查看', 'Reset not confirmed. Refresh later to check') }
}

export async function consumeResetCredit(provider: string, key: string, creditId: string): Promise<ResetCreditResult> {
  try {
    if (!creditId) return { ok: false, error: pick('没有可用的重置卡', 'No reset card available') }
    const result = provider === 'openai-codex' ? await consumeCodexCredit(key, creditId)
      : provider === 'anthropic' ? await consumeClaudeCredit(key, creditId)
        : { ok: false, error: pick('该账号不支持重置卡', 'This account does not support reset cards') }
    if (result.ok) {
      invalidateAccountQuotaReport()
      lastGoodCards.clear()
      forgetClaudeUsage()
    }
    return result
  } catch (e) {
    return { ok: false, error: friendly(e) }
  }
}

let inflight: Promise<AccountQuotaReport> | null = null

export function invalidateAccountQuotaReport(): void {
  inflight = null
}

export function accountQuotaReport(): Promise<AccountQuotaReport> {
  if (!inflight) {
    const pending = buildReport().finally(() => {
      if (inflight === pending) inflight = null
    })
    inflight = pending
  }
  return inflight
}

async function buildReport(): Promise<AccountQuotaReport> {
  const [targets, claude, openrouter, commandCodeAliases] = await Promise.all([
    codexAccountTargets().catch(() => [] as CodexAccountTarget[]),
    oauthAccountTargets('anthropic').catch(() => [] as OAuthAccountTarget[]),
    oauthAccountTargets('openrouter').catch(() => [] as OAuthAccountTarget[]),
    customCommandCodeQuotaProviders()
  ])
  targets.sort((a, b) => Number(b.active) - Number(a.active))
  const keyProviders = [
    ...KEY_PROVIDERS.filter((p) => p.id !== 'openrouter' || !openrouter.some((a) => a.active)),
    ...commandCodeAliases.map((id) => ({ id, name: `Command Code · ${id}`, quotaProvider: 'commandcode' }))
  ]
  const jobs: Array<Promise<AccountQuotaCard | null>> = [...targets.map(yanCodexCard), ...claude.map(yanClaudeCard), ...openrouter.map(yanOpenRouterCard), ...keyProviders.map(yanKeyCard)]
  const settled = await Promise.all(jobs.map((job) => job.catch(() => null)))
  const merged = mergeDuplicateCards(settled.filter((c): c is AccountQuotaCard => !!c))
  const cards = await Promise.all(merged.map(withLastGood))
  return { cards, checkedAt: Date.now() }
}

const CARD_LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60_000
const lastGoodCards = new Map<string, AccountQuotaCard>()

async function withLastGood(card: AccountQuotaCard): Promise<AccountQuotaCard> {
  const lastGoodKey = `${card.source}|${card.key}`
  if (card.status !== 'error' && (card.windows.length || card.balance)) {
    const windows = card.windows.length ? await quotaSamples.withForecasts(`card|${lastGoodKey}`, card.windows, card.checkedAt) : card.windows
    const fresh = { ...card, windows }
    lastGoodCards.set(lastGoodKey, fresh)
    return fresh
  }
  const prior = lastGoodCards.get(lastGoodKey)
  if (card.status !== 'error' || !prior || card.checkedAt - prior.checkedAt > CARD_LAST_GOOD_MAX_AGE_MS) return card
  return { ...prior, active: card.active, switchable: card.switchable, staleError: card.error || pick('读取失败', 'Read failed') }
}
