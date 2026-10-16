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

const http = net.fetch.bind(net)

export async function providerQuota(rawProvider: string, monthlyBudget?: number): Promise<ProviderQuota> {
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
        return { provider, supported: true, error: '未找到 Claude Code 登录凭证', checkedAt }
      }
      if (Number(credential.expiresAt) <= Date.now()) {
        return { provider, supported: true, error: 'Claude Code 登录令牌已过期，请先在终端使用一次 claude 刷新', checkedAt }
      }
      const response = await http('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${credential.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Claude Code 登录已失效' : `HTTP ${response.status}`)
      const windows = claudeUsageWindows(await response.json())
      if (!windows.length) return { provider, supported: true, error: 'Claude 未返回额度窗口', checkedAt }
      const binding = [...windows].filter((window) => !window.informational).sort((a, b) => b.used / b.total - a.used / a.total)[0]
      return {
        provider, supported: true, windows, checkedAt,
        ...(binding ? {
          used: binding.used, total: binding.total, remaining: Math.max(0, binding.total - binding.used),
          currency: 'PERCENT', label: 'Claude Code 订阅'
        } : {})
      }
    } catch (e) {
      const error = e instanceof Error && 'code' in e && e.code === 'ENOENT'
        ? '未找到 Claude Code 登录凭证'
        : e instanceof Error ? e.message : String(e)
      return { provider, supported: true, error, checkedAt }
    }
  }
  const isCodex = provider === 'openai-codex'
  const openai = provider === 'openai'
  const codexCredential = isCodex ? await hostImageCredentials.codex() : null
  const key = isCodex ? codexCredential?.access : openai ? (process.env.OPENAI_ADMIN_KEY || await resolveQuotaProviderSecret(provider)) : await resolveQuotaProviderSecret(provider)
  const known = provider === 'openrouter' || provider === 'deepseek' || provider === 'commandcode' || isCodex || openai
  if (!key) return { provider, supported: known, error: openai ? '请设置 OPENAI_ADMIN_KEY 以查询组织费用' : '未找到该供应商的 API Key', checkedAt }
  try {
    if (isCodex) {
      const accountId = codexCredential?.accountId ?? await resolveCodexAccountId()
      if (!accountId) return { provider, supported: true, error: '凭证缺少 chatgpt-account-id，请重新登录 ChatGPT', checkedAt }
      const usage = await fetchCodexUsage(key, accountId)
      const windows: QuotaWindow[] = usage.windows
      if (windows.length === 0) return { provider, supported: true, error: '订阅未返回限速窗口', checkedAt }
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
        if (r.status === 401 || r.status === 403) throw new Error('需要 OpenAI 组织 Admin Key（OPENAI_ADMIN_KEY），普通 API Key 或 ChatGPT 订阅无法查询')
        throw new Error(`HTTP ${r.status}`)
      }
      const j = await r.json() as { data?: Array<{ results?: Array<{ amount?: { value?: number; currency?: string } }> }> }
      const used = (j.data ?? []).flatMap((x) => x.results ?? []).reduce((sum, x) => sum + Number(x.amount?.value ?? 0), 0)
      const budget = Number(monthlyBudget || process.env.OPENAI_MONTHLY_BUDGET)
      const hasBudget = Number.isFinite(budget) && budget > 0
      return {
        provider, supported: true, used, total: hasBudget ? budget : undefined,
        remaining: hasBudget ? Math.max(0, budget - used) : undefined,
        currency: 'USD', label: hasBudget ? '本月预算剩余' : '本月组织费用', checkedAt
      }
    }
    if (provider === 'deepseek') {
      const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json() as { is_available?: boolean; balance_infos?: Array<{ currency?: string; total_balance?: string }> }
      const infos = j.balance_infos ?? []
      const info = infos.find((x) => Number(x.total_balance) > 0) ?? infos[0]
      if (!info) return { provider, supported: true, error: '余额接口未返回数据', checkedAt }
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
        return { provider, supported: true, error: wl.limited === false ? '套餐未启用额度窗口' : '未返回额度窗口', checkedAt }
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
        label: monthly ? '本月已用' : `${binding.label}额度`,
        windows,
        checkedAt
      }
    }
    return { provider, supported: false, error: '该供应商没有可用的公开余额 API', checkedAt }
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
  if (hasQuotaData(fresh)) {
    lastGood.set(key, fresh)
    return fresh
  }
  const prior = lastGood.get(key)
  if (!fresh.error || !prior || Date.now() - prior.checkedAt > LAST_GOOD_MAX_AGE_MS) return fresh
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
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `登录已失效（HTTP ${r.status}）` : `HTTP ${r.status}`)
  return codexUsageWindows(await r.json() as CodexUsagePayload)
}
