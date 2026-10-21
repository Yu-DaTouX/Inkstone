import { net } from 'electron'
import { readAuthEntry } from './credentials'
import { resolveQuotaProviderSecret } from './quota-credentials'
import { fetchCodexUsage, providerQuota } from './quota'
import { quotaSamples } from './quota-samples'
import { codexAccountTargets, type CodexAccountTarget } from './codex-accounts'
import { claudeUsageWindows, mergeDuplicateCards, type AccountQuotaCard, type AccountQuotaReport } from '../shared/account-quota'

const TIMEOUT_MS = 12_000
const http = net.fetch.bind(net)

const KEY_PROVIDERS: Array<{ id: string; name: string }> = [
  { id: 'commandcode', name: 'Command Code' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openrouter', name: 'OpenRouter' }
]

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await http(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? `登录已失效（HTTP ${res.status}）` : `HTTP ${res.status}`)
  return res.json()
}

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return '请求超时'
  if (/fetch failed|ERR_|ENOTFOUND|ECONN/i.test(msg)) return `连不上服务器（${msg}）`
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
        ? { status: 'expired', hint: '登录令牌已过期，下次对话时 pi 会自动刷新。' }
        : { status: 'error', error: t.problem ?? '没有可用的登录凭证' }
    }
    const usage = await fetchCodexUsage(t.credential.access, t.credential.accountId)
    return { plan: usage.plan ?? t.plan, windows: usage.windows, status: usage.limited ? 'limited' : 'ok' }
  })
}

async function yanClaudeCard(): Promise<AccountQuotaCard | null> {
  const entry = (await readAuthEntry('anthropic')) as { type?: string; access?: unknown; expires?: unknown } | undefined
  if (entry?.type !== 'oauth' || typeof entry.access !== 'string') return null
  const access = entry.access
  return settle({ key: 'yan:anthropic', source: 'yan', provider: 'anthropic', name: 'Claude' }, async () => {
    if (Number(entry.expires) <= Date.now()) return { status: 'expired', hint: '登录令牌已过期，下次用 Claude 模型对话时 pi 会自动刷新。' }
    const windows = claudeUsageWindows(await claudeUsage(access))
    return { windows, status: limitedIf(windows) }
  })
}

async function yanKeyCard(provider: { id: string; name: string }): Promise<AccountQuotaCard | null> {
  if (!(await resolveQuotaProviderSecret(provider.id))) return null
  return settle({ key: `yan:${provider.id}`, source: 'yan', provider: provider.id, name: provider.name }, async () => {
    const q = await providerQuota(provider.id)
    const windows = q.windows ?? []
    const hasData = windows.length > 0 || q.remaining !== undefined
    if (q.error && !hasData) return { status: 'error', error: q.error }
    const balance = !windows.length && q.remaining !== undefined ? { label: '余额', amount: q.remaining, currency: q.currency ?? 'USD' } : undefined
    return { windows, balance, status: limitedIf(windows) }
  })
}

function claudeUsage(accessToken: string): Promise<unknown> {
  return getJson('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' }
  })
}

let inflight: Promise<AccountQuotaReport> | null = null

export function accountQuotaReport(): Promise<AccountQuotaReport> {
  inflight ??= buildReport().finally(() => {
    inflight = null
  })
  return inflight
}

async function buildReport(): Promise<AccountQuotaReport> {
  const targets = await codexAccountTargets().catch(() => [] as CodexAccountTarget[])
  targets.sort((a, b) => Number(b.active) - Number(a.active))
  const jobs: Array<Promise<AccountQuotaCard | null>> = [...targets.map(yanCodexCard), yanClaudeCard(), ...KEY_PROVIDERS.map(yanKeyCard)]
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
  return { ...prior, active: card.active, switchable: card.switchable, staleError: card.error || '读取失败' }
}
