import { pick } from '../shared/ui-lang'
import { net } from 'electron'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderQuota, QuotaWindow } from '../shared/ipc'
import { readAuthEntry, resolveCodexAccountId } from './credentials'
import { resolveQuotaProviderSecret } from './quota-credentials'
import { commandCodeWindows, type CommandCodeCredits } from './quota-commandcode'
import { hostImageCredentials } from './image-credentials'
import { chatGptIdentity, claudeUsageWindows, codexUsageWindows, type CodexUsagePayload } from '../shared/account-quota'
import { quotaSamples } from './quota-samples'
import { claudeUsage } from './claude-usage'

const http = net.fetch.bind(net)

async function claudeSubscriptionQuota(
  provider: string,
  accessToken: string,
  checkedAt: number,
  label: string,
  revoked: string
): Promise<ProviderQuota> {
  const windows = claudeUsageWindows(await claudeUsage(accessToken, revoked))
  if (!windows.length) return { provider, supported: true, error: pick('Claude 未返回额度窗口', 'Claude returned no quota windows'), checkedAt }
  const binding = [...windows].filter((window) => !window.informational).sort((a, b) => b.used / b.total - a.used / a.total)[0]
  return {
    provider, supported: true, windows, checkedAt,
    ...(binding ? {
      used: binding.used, total: binding.total, remaining: Math.max(0, binding.total - binding.used),
      currency: 'PERCENT', label
    } : {})
  }
}

export async function providerQuota(rawProvider: string, monthlyBudget?: number, resolvedSecret?: string): Promise<ProviderQuota> {
  const provider = rawProvider.trim().toLowerCase()
  const checkedAt = Date.now()
  if (provider === 'claude-bridge') {
    try {
      const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
      const auth = JSON.parse(await readFile(join(dir, '.credentials.json'), 'utf8')) as {
        claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown }
      }
      const credential = auth.claudeAiOauth
      if (typeof credential?.accessToken !== 'string') {
        return { provider, supported: true, error: pick('未找到 Claude Code 登录凭证', 'Claude Code sign-in credentials not found'), checkedAt }
      }
      if (Number(credential.expiresAt) <= Date.now()) {
        return { provider, supported: true, error: pick('Claude Code 登录令牌已过期，请先在终端使用一次 claude 刷新', 'Claude Code sign-in token expired. Run claude once in a terminal to refresh'), checkedAt }
      }
      return await claudeSubscriptionQuota(provider, credential.accessToken, checkedAt, pick('Claude Code 订阅', 'Claude Code subscription'), pick('Claude Code 登录已失效', 'Claude Code sign-in expired'))
    } catch (e) {
      const error = e instanceof Error && 'code' in e && e.code === 'ENOENT'
        ? pick('未找到 Claude Code 登录凭证', 'Claude Code sign-in credentials not found')
        : e instanceof Error ? e.message : String(e)
      return { provider, supported: true, error, checkedAt }
    }
  }
  if (provider === 'anthropic') {
    const entry = (await readAuthEntry('anthropic').catch(() => undefined)) as { type?: unknown; access?: unknown; expires?: unknown } | undefined
    if (entry?.type === 'oauth' && typeof entry.access === 'string') {
      if (Number(entry.expires) <= Date.now()) {
        return { provider, supported: true, error: pick('Claude 登录令牌已过期，下次用 Claude 模型对话时 pi 会自动刷新', 'Claude sign-in token expired. pi refreshes it the next time you chat with a Claude model'), checkedAt }
      }
      try {
        return await claudeSubscriptionQuota(provider, entry.access, checkedAt, pick('Claude 订阅', 'Claude subscription'), pick('Claude 登录已失效，请在设置里重新登录', 'Claude sign-in expired. Sign in again in settings'))
      } catch (e) {
        return { provider, supported: true, error: e instanceof Error ? e.message : String(e), checkedAt }
      }
    }
  }
  const isCodex = provider === 'openai-codex'
  const openai = provider === 'openai'
  const codexCredential = isCodex ? await hostImageCredentials.codex() : null
  const key = isCodex ? codexCredential?.access : openai ? (process.env.OPENAI_ADMIN_KEY || await resolveQuotaProviderSecret(provider)) : (resolvedSecret ?? await resolveQuotaProviderSecret(provider))
  const known = provider === 'openrouter' || provider === 'deepseek' || provider === 'commandcode' || isCodex || openai
  if (!key) return { provider, supported: known, error: openai ? pick('请设置 OPENAI_ADMIN_KEY 以查询组织费用', 'Set OPENAI_ADMIN_KEY to query organization costs') : pick('未找到该供应商的 API Key', 'No API key found for this provider'), checkedAt }
  try {
    if (isCodex) {
      const accountId = codexCredential?.accountId ?? await resolveCodexAccountId()
      if (!accountId) return { provider, supported: true, error: pick('凭证缺少 chatgpt-account-id，请重新登录 ChatGPT', 'Credential is missing chatgpt-account-id. Sign in to ChatGPT again'), checkedAt }
      const usage = await fetchCodexUsage(key, accountId)
      const windows: QuotaWindow[] = usage.windows
      if (windows.length === 0) return { provider, supported: true, error: pick('订阅未返回限速窗口', 'Subscription returned no rate limit windows'), checkedAt }
      const binding = [...windows].sort((a, b) => b.used / b.total - a.used / a.total)[0]
      const plan = usage.plan ? usage.plan.toUpperCase() : ''
      return {
        provider,
        supported: true,
        remaining: Math.max(0, binding.total - binding.used),
        used: binding.used,
        total: binding.total,
        currency: 'PERCENT',
        label: plan,
        windows,
        checkedAt
      }
    }
    if (provider === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json() as { data?: { total_credits?: number; total_usage?: number } }
      const total = Number(j.data?.total_credits ?? 0), used = Number(j.data?.total_usage ?? 0)
      return { provider, supported: true, total, used, remaining: Math.max(0, total - used), currency: 'USD', checkedAt }
    }
    if (openai) {
      const now = new Date()
      const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000)
      const r = await fetch(`https://api.openai.com/v1/organization/costs?start_time=${start}&limit=31`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000)
      })
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error(pick('需要 OpenAI 组织 Admin Key（OPENAI_ADMIN_KEY），普通 API Key 或 ChatGPT 订阅无法查询', 'An OpenAI organization Admin Key (OPENAI_ADMIN_KEY) is required. Regular API keys and ChatGPT subscriptions cannot query this'))
        throw new Error(`HTTP ${r.status}`)
      }
      const j = await r.json() as { data?: Array<{ results?: Array<{ amount?: { value?: number; currency?: string } }> }> }
      const used = (j.data ?? []).flatMap((x) => x.results ?? []).reduce((sum, x) => sum + Number(x.amount?.value ?? 0), 0)
      const budget = Number(monthlyBudget || process.env.OPENAI_MONTHLY_BUDGET)
      const hasBudget = Number.isFinite(budget) && budget > 0
      return {
        provider, supported: true, used, total: hasBudget ? budget : undefined,
        remaining: hasBudget ? Math.max(0, budget - used) : undefined,
        currency: 'USD', label: hasBudget ? pick('本月预算剩余', 'Budget left this month') : pick('本月组织费用', 'Organization cost this month'), checkedAt
      }
    }
    if (provider === 'deepseek') {
      const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json() as { is_available?: boolean; balance_infos?: Array<{ currency?: string; total_balance?: string }> }
      const infos = j.balance_infos ?? []
      const info = infos.find((x) => Number(x.total_balance) > 0) ?? infos[0]
      if (!info) return { provider, supported: true, error: pick('余额接口未返回数据', 'Balance API returned no data'), checkedAt }
      return { provider, supported: true, remaining: Number(info.total_balance ?? 0), currency: info.currency ?? 'USD', checkedAt }
    }
    if (provider === 'commandcode') {
      const cr = await fetch('https://api.commandcode.ai/alpha/billing/credits', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000)
      })
      if (!cr.ok) throw new Error(`HTTP ${cr.status}`)
      const credits = await cr.json() as CommandCodeCredits
      const wl = credits.windowLimits ?? {}
      const periodEnd = await fetch('https://api.commandcode.ai/alpha/billing/subscriptions', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000)
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((sub) => {
          const t = Date.parse((sub as { data?: { currentPeriodEnd?: string } } | null)?.data?.currentPeriodEnd ?? '')
          return Number.isFinite(t) ? t : undefined
        })
        .catch(() => undefined)
      const windows = commandCodeWindows(credits, periodEnd)

      if (windows.length === 0) {
        return { provider, supported: true, error: wl.limited === false ? pick('套餐未启用额度窗口', 'Plan has no quota windows enabled') : pick('未返回额度窗口', 'No quota windows returned'), checkedAt }
      }
      const binding = [...windows].sort(
        (a, b) => (a.total - a.used) / a.total - (b.total - b.used) / b.total
      )[0]
      const monthly = windows.find((w) => w.id === 'monthly')
      return {
        provider,
        supported: true,
        remaining: Math.max(0, (monthly ?? binding).total - (monthly ?? binding).used),
        used: monthly ? monthly.used : binding.used,
        total: (monthly ?? binding).total,
        currency: 'USD',
        label: monthly ? pick('本月已用', 'Used this month') : pick(`${binding.label}额度`, `${binding.label} quota`),
        windows,
        checkedAt
      }
    }
    return { provider, supported: false, error: pick('该供应商没有可用的公开余额 API', 'This provider has no public balance API'), checkedAt }
  } catch (e) {
    return { provider, supported: true, error: e instanceof Error ? e.message : String(e), checkedAt }
  }
}

const LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60_000
const lastGood = new Map<string, ProviderQuota>()

function hasQuotaData(q: ProviderQuota): boolean {
  return !!q.windows?.length || q.remaining !== undefined || q.used !== undefined
}

async function lastGoodKey(provider: string, monthlyBudget?: number): Promise<string> {
  if (provider === 'openai-codex') {
    const entry = await readAuthEntry(provider).catch(() => undefined) as { access?: unknown; accountId?: unknown } | undefined
    const accountId = typeof entry?.accountId === 'string' ? entry.accountId : undefined
    return `${provider}|${chatGptIdentity(entry?.access, undefined, accountId).key ?? ''}`
  }
  return `${provider}|${monthlyBudget ?? ''}`
}

export async function providerQuotaWithFallback(rawProvider: string, monthlyBudget?: number): Promise<ProviderQuota> {
  const provider = rawProvider.trim().toLowerCase()
  const fresh = await providerQuota(rawProvider, monthlyBudget)
  const key = await lastGoodKey(provider, monthlyBudget)
  if (fresh.windows?.length) fresh.windows = await quotaSamples.withForecasts(`provider|${key}`, fresh.windows, fresh.checkedAt)
  if (hasQuotaData(fresh)) {
    lastGood.set(key, fresh)
    return fresh
  }
  const prior = lastGood.get(key)
  if (!fresh.supported) lastGood.delete(key)
  if (!fresh.supported || !fresh.error || !prior || Date.now() - prior.checkedAt > LAST_GOOD_MAX_AGE_MS) return fresh
  return { ...prior, error: undefined, staleError: fresh.error }
}

export async function fetchCodexUsage(accessToken: string, accountId: string): Promise<{ plan?: string; windows: QuotaWindow[]; limited: boolean }> {
  const r = await http('https://chatgpt.com/backend-api/codex/usage', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': accountId,
      'Content-Type': 'application/json',
      originator: 'codex_cli_rs',
      'User-Agent': 'codex_cli_rs/0.1.0'
    },
    signal: AbortSignal.timeout(10_000)
  })
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? pick(`登录已失效（HTTP ${r.status}）`, `Sign-in expired (HTTP ${r.status})`) : `HTTP ${r.status}`)
  return codexUsageWindows(await r.json() as CodexUsagePayload)
}
