import { net } from 'electron'
import type { ProviderQuota, QuotaWindow } from '../shared/ipc'
import { resolveCodexAccountId, resolveProviderSecret } from './credentials'

/**
 * 取额度用的 HTTP 客户端。
 *
 * ⚠️ 这里**必须用 Electron 的 net.fetch**，不能用全局 fetch。
 *    实测：同样的头，全局 fetch 请求 chatgpt.com 会被 Cloudflare 抦下
 *    （403 + “Just a moment…” 的 HTML 验证页），而 net.fetch 返回 200 ——
 *    因为 net.fetch 走的是 Chromium 的网络栈（有完整的 TLS 指纹/HTTP2）。
 *    探针里两种都试过，全局 fetch 解析 JSON 时会直接报 Unexpected token '<'。
 */
const http = net.fetch.bind(net)

/**
 * 供应商并没有统一的“余额”协议。这里只访问有公开、自助余额 API 的服务；
 * 不用模型调用来猜余额，也不把密钥发给渲染进程或第三方代理。
 */
export async function providerQuota(rawProvider: string, monthlyBudget?: number): Promise<ProviderQuota> {
  const provider = rawProvider.trim().toLowerCase()
  const checkedAt = Date.now()
  /*
   * ⚠️ openai 与 openai-codex 是**两条完全不同的路**：
   *   · openai       = 平台 API key，能读的是「组织费用」（要 Admin Key）
   *   · openai-codex = ChatGPT 订阅（OAuth），能读的是「套餐限速窗口」
   * 二者共用 gpt-5.6-luna 这类模型名，但额度口径完全不同，
   * 所以这里必须分开处理，不能拿 openai 那套去查订阅。
   */
  const isCodex = provider === 'openai-codex'
  const openai = provider === 'openai'
  const key = openai ? (process.env.OPENAI_ADMIN_KEY || await resolveProviderSecret(provider)) : await resolveProviderSecret(provider)
  const known = provider === 'openrouter' || provider === 'deepseek' || provider === 'commandcode' || isCodex || openai
  if (!key) return { provider, supported: known, error: openai ? '请设置 OPENAI_ADMIN_KEY 以查询组织费用' : '未找到该供应商的 API Key', checkedAt }
  try {
    /*
     * ChatGPT 订阅（Codex）的套餐限速窗口。
     * `/backend-api/codex/usage` 实测可用（返回 primary/secondary 两个窗口），
     * 只需 OAuth access token + chatgpt-account-id，不需要 Admin Key。
     * 数字是**百分比**（used_percent），不是美元 —— 所以用 0–100 当作 used/total，
     * 渲染层统一按百分比画，不用再乘换算系数。
     */
    if (isCodex) {
      const accountId = await resolveCodexAccountId()
      if (!accountId) return { provider, supported: true, error: '凭证缺少 chatgpt-account-id，请重新登录 ChatGPT', checkedAt }
      const r = await http('https://chatgpt.com/backend-api/codex/usage', {
        headers: {
          Authorization: `Bearer ${key}`,
          'chatgpt-account-id': accountId,
          'Content-Type': 'application/json',
          originator: 'codex_cli_rs',
          'User-Agent': 'codex_cli_rs/0.1.0'
        },
        signal: AbortSignal.timeout(10_000)
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json() as CodexUsage
      const rl = j.rate_limit
      if (!rl) return { provider, supported: true, error: '订阅未返回限速窗口', checkedAt }
      const windows: QuotaWindow[] = []
      const addWin = (id: string, w?: CodexWindow): void => {
        if (!w || !Number.isFinite(Number(w.used_percent))) return
        const secs = Number(w.limit_window_seconds)
        windows.push({
          id,
          // Codex 固定按短窗口和周窗口展示；用稳定名称而非“1 周”，更贴近套餐页面。
          label: id === 'primary' ? '五小时' : id === 'secondary' ? '本周' : windowLabel(secs),
          used: Number(w.used_percent),
          /* 百分比口径：满分 100 */
          total: 100,
          resetAt: Number.isFinite(Number(w.reset_at)) ? Number(w.reset_at) * 1000 : undefined,
          exceeded: false
        })
      }
      addWin('primary', rl.primary_window)
      addWin('secondary', rl.secondary_window)
      if (windows.length === 0) return { provider, supported: true, error: '订阅未返回限速窗口', checkedAt }
      /* 最紧的窗口当主数字（谁先满谁先卡） */
      const binding = [...windows].sort((a, b) => b.used / b.total - a.used / a.total)[0]
      const plan = typeof j.plan_type === 'string' ? j.plan_type.toUpperCase() : ''
      return {
        provider,
        supported: true,
        /* 百分比口径下 remaining 也是百分比（剩余可用百分比） */
        remaining: Math.max(0, binding.total - binding.used),
        used: binding.used,
        total: binding.total,
        /* 订阅没有金额；用 percent 让渲染层知道单位 */
        currency: 'PERCENT',
        // 套餐名称单独展示，避免与某个“最紧窗口”混在同一行。
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
      /*
       * DeepSeek 会同时返回多个币种（实测 USD 恒为 0.00，真实余额在 CNY）。
       * 之前「优先取 USD」会永远显示 $0.00 —— 所以改为**优先取有余额的那条**，
       * 没有正余额时再退回第一条。绝不能在解析失败时默认成 0：
       * 那会假装「余额是 0」，而不是如实报告错误。
       */
      const infos = j.balance_infos ?? []
      const info = infos.find((x) => Number(x.total_balance) > 0) ?? infos[0]
      if (!info) return { provider, supported: true, error: '余额接口未返回数据', checkedAt }
      return { provider, supported: true, remaining: Number(info.total_balance ?? 0), currency: info.currency ?? 'USD', checkedAt }
    }
    if (provider === 'commandcode') {
      /*
       * Command Code 是**订阅套餐**，没有「余额」，只有滚动窗口：
       *   5 小时 / 每周 / 每月，各自有上限，超了就 429。
       * `/alpha/billing/credits` 用 pi 里同一把 user_ key 就能读（实测）。
       *
       * ⚠️ 接口只返回 fiveHour / weekly 两个窗口，**月度是官网自己算的**：
       *    月度已用 = credits.monthlyCredits，分母 = 套餐额度的总额度。
       *    实测：34.9988 / 70 = 50% —— 与官网 usage 页显示的正好一致
       *    （GOAT=$70；weekly cap $35=一半、fiveHour cap $14=五分之一，
       *      所以那两个窗口的 cap 也确实是按套餐总额度切出来的）。
       *    之前只显示 5h/周，漏了月度 —— 而月度才是「这个月总共能用多少」，
       *    用户看官网时对不上就是这个原因。
       *
       * 没有硬编码 $70：分母由 weekly cap × 2 反推
       * （实测每个套餐都按固定比例切：weekly = 总额度的一半），
       * 反推不出来就只展示前两个窗口，绝不编一个数。
       */
      const cr = await fetch('https://api.commandcode.ai/alpha/billing/credits', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000)
      })
      if (!cr.ok) throw new Error(`HTTP ${cr.status}`)
      const credits = await cr.json() as CommandCodeCredits
      const wl = credits.windowLimits ?? {}
      /* 计费周期结束 = 月度窗口的重置时间。单独一个请求，失败就当没有（不影响前两个窗口） */
      const periodEnd = await fetch('https://api.commandcode.ai/alpha/billing/subscriptions', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000)
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((sub) => {
          const t = Date.parse((sub as { data?: { currentPeriodEnd?: string } } | null)?.data?.currentPeriodEnd ?? '')
          return Number.isFinite(t) ? t : undefined
        })
        .catch(() => undefined)
      const windows: QuotaWindow[] = []
      const add = (id: string, label: string, w?: CommandCodeWindow): void => {
        const cap = Number(w?.cap)
        if (!w || !Number.isFinite(cap) || cap <= 0) return
        windows.push({
          id,
          label,
          used: Number(w.used ?? 0),
          total: cap,
          resetAt: typeof w.resetAt === 'number' ? w.resetAt : undefined,
          exceeded: w.exceeded === true
        })
      }
      add('fiveHour', '5 小时', wl.fiveHour)
      add('weekly', '每周', wl.weekly)

      /*
       * 月度：分母反推。接口里 monthlyCredits 是**已用**，不是上限。
       * 套餐总额度 = 月度上限 = weekly.cap × 2（见上）。
       * 重置时间接口里没有，得从订阅周期拿（官网就是这么做的）—— 拿不到就不显示。
       */
      const planCredits = Number(wl.weekly?.cap) * 2
      const usedMonthly = Number(credits.credits?.monthlyCredits)
      if (Number.isFinite(planCredits) && planCredits > 0 && Number.isFinite(usedMonthly)) {
        windows.push({
          id: 'monthly',
          label: '本月',
          used: usedMonthly,
          total: planCredits,
          resetAt: periodEnd,
          exceeded: usedMonthly >= planCredits
        })
      }

      if (windows.length === 0) {
        return { provider, supported: true, error: wl.limited === false ? '套餐未启用额度窗口' : '未返回额度窗口', checkedAt }
      }
      /* 主数字取剩余比例最小（最紧）的窗口 —— 那才是用户当前真正撞得到的墙。 */
      const binding = [...windows].sort(
        (a, b) => (a.total - a.used) / a.total - (b.total - b.used) / b.total
      )[0]
      return {
        provider,
        supported: true,
        remaining: Math.max(0, binding.total - binding.used),
        used: binding.used,
        total: binding.total,
        currency: 'USD',
        label: `${binding.label}额度`,
        windows,
        checkedAt
      }
    }
    return { provider, supported: false, error: '该供应商没有可用的公开余额 API', checkedAt }
  } catch (e) {
    return { provider, supported: true, error: e instanceof Error ? e.message : String(e), checkedAt }
  }
}

/** Command Code `/alpha/billing/credits` 里单个窗口的形状 */
interface CommandCodeWindow {
  used?: number
  cap?: number
  exceeded?: boolean
  resetAt?: number
}

/** `/alpha/billing/credits` 的整体形状 */
interface CommandCodeCredits {
  credits?: {
    monthlyCredits?: number
    purchasedCredits?: number
    freeCredits?: number
  }
  windowLimits?: {
    limited?: boolean
    exceeded?: string
    fiveHour?: CommandCodeWindow
    weekly?: CommandCodeWindow
  }
}

/** ChatGPT 订阅用量接口（`/backend-api/codex/usage`）的形状 */
interface CodexUsage {
  plan_type?: string
  rate_limit?: {
    allowed?: boolean
    limit_reached?: boolean
    primary_window?: CodexWindow
    secondary_window?: CodexWindow
  } | null
}

interface CodexWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
  /** 秒级时间戳 */
  reset_at?: number
}

/**
 * 把窗口长度（秒）变成人话。
 * 不写死「5 小时 / 每周」：接口给的是秒数，万一以后套餐改了窗口长度，
 * 写死的标签会骗人。
 */
function windowLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '额度'
  const hours = seconds / 3600
  if (hours < 24) return `${Math.round(hours)} 小时`
  const days = hours / 24
  if (days < 7) return `${Math.round(days)} 天`
  if (days < 30) return `${Math.round(days / 7)} 周`
  return `${Math.round(days / 30)} 个月`
}
