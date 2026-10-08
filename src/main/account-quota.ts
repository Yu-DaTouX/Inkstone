/**
 * 「账号额度」磁贴的数据：把砚登录的各个账号、以及用户选择显示的本机 CLI 账号的额度汇成一张表。
 *
 * 来源与边界：
 *   · 砚的 ChatGPT 账号：每个保存的账号各查一次（`codex-accounts.ts` 负责凭证）。
 *   · 砚的其它服务（Claude 订阅、Command Code、DeepSeek、OpenRouter）：沿用右栏额度的查询。
 *   · 本机 CLI（Codex CLI、Claude Code、Gemini CLI）：默认关闭，用户在磁贴里打开。
 *     只读它们的登录文件、从不刷新或改写 —— 刷新会让那个 CLI 自己的登录失效。
 * 令牌只在主进程里用来发请求，返回给渲染端的只有身份、窗口百分比和余额。
 */
import { net } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { readAuthEntry, resolveProviderSecret } from './credentials'
import { fetchCodexUsage, providerQuota } from './quota'
import { codexAccountTargets, type CodexAccountTarget } from './codex-accounts'
import {
  chatGptIdentity,
  claudeUsageWindows,
  geminiQuotaWindows,
  mergeDuplicateCards,
  normalizeAccountLabel,
  normalizeAccountQuotaPrefs,
  type AccountQuotaCard,
  type AccountQuotaCliSource,
  type AccountQuotaPrefs,
  type AccountQuotaReport
} from '../shared/account-quota'

const PREFS_FILE = join(YAN_DIR, 'account-quota.json')
const TIMEOUT_MS = 12_000
const http = net.fetch.bind(net)

/** 有自助额度 / 余额接口、且用 API key 的服务（与右栏额度同一份查询）。 */
const KEY_PROVIDERS: Array<{ id: string; name: string }> = [
  { id: 'commandcode', name: 'Command Code' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openrouter', name: 'OpenRouter' }
]

/* ------------------------------------------------------------ 偏好：来源开关与备注 */

let prefsChain: Promise<unknown> = Promise.resolve()

export async function readAccountQuotaPrefs(): Promise<AccountQuotaPrefs> {
  try {
    return normalizeAccountQuotaPrefs(JSON.parse(await readFile(PREFS_FILE, 'utf8')))
  } catch {
    return normalizeAccountQuotaPrefs(undefined)
  }
}

function updatePrefs(fn: (prefs: AccountQuotaPrefs) => void): Promise<AccountQuotaPrefs> {
  const next = prefsChain.then(async () => {
    const prefs = await readAccountQuotaPrefs()
    fn(prefs)
    await mkdir(YAN_DIR, { recursive: true })
    await writeFile(PREFS_FILE, JSON.stringify(prefs, null, 2) + '\n', 'utf8')
    return prefs
  })
  prefsChain = next.catch(() => undefined)
  return next
}

export function setAccountQuotaSource(source: AccountQuotaCliSource, enabled: boolean): Promise<AccountQuotaPrefs> {
  return updatePrefs((prefs) => {
    if (source in prefs.sources) prefs.sources[source] = !!enabled
  })
}

/** 空备注 = 恢复默认名。 */
export function setAccountLabel(key: string, label: string): Promise<AccountQuotaPrefs> {
  return updatePrefs((prefs) => {
    const value = normalizeAccountLabel(label)
    if (!key) return
    if (value) prefs.labels[key] = value
    else delete prefs.labels[key]
  })
}

/* ------------------------------------------------------------ 小工具 */

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

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

/** 把一张卡的查询包起来：任何失败都只影响这一张。 */
async function settle(base: CardBase, run: () => Promise<Partial<AccountQuotaCard>>): Promise<AccountQuotaCard> {
  const card: AccountQuotaCard = { ...base, status: 'ok', windows: [], checkedAt: Date.now() }
  try {
    return { ...card, ...(await run()), checkedAt: Date.now() }
  } catch (e) {
    return { ...card, status: 'error', error: friendly(e) }
  }
}

const limitedIf = (windows: AccountQuotaCard['windows']): 'limited' | 'ok' => (windows.some((w) => w.total > 0 && w.used >= w.total) ? 'limited' : 'ok')

/* ------------------------------------------------------------ 砚的账号 */

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

/** 砚里登录的 Claude 订阅（pi 的 `anthropic` OAuth 条目）；过期时等 pi 刷新。 */
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
  if (!(await resolveProviderSecret(provider.id))) return null
  return settle({ key: `yan:${provider.id}`, source: 'yan', provider: provider.id, name: provider.name }, async () => {
    const q = await providerQuota(provider.id)
    const windows = q.windows ?? []
    const hasData = windows.length > 0 || q.remaining !== undefined
    if (q.error && !hasData) return { status: 'error', error: q.error }
    const balance = !windows.length && q.remaining !== undefined ? { label: '余额', amount: q.remaining, currency: q.currency ?? 'USD' } : undefined
    return { windows, balance, status: limitedIf(windows) }
  })
}

/* ------------------------------------------------------------ 本机 CLI（只读） */

function claudeUsage(accessToken: string): Promise<unknown> {
  return getJson('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' }
  })
}

async function codexCliCard(): Promise<AccountQuotaCard | null> {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  const tokens = (await readJson(join(home, 'auth.json')))?.tokens as { access_token?: unknown; id_token?: unknown; account_id?: unknown } | undefined
  if (typeof tokens?.access_token !== 'string') return null
  const access = tokens.access_token
  const id = chatGptIdentity(access, tokens.id_token, typeof tokens.account_id === 'string' ? tokens.account_id : undefined)
  return settle({ key: id.key ?? 'codex-cli', source: 'codex-cli', provider: 'openai-codex', name: 'ChatGPT', email: id.email, plan: id.plan }, async () => {
    if (id.expiresAt && id.expiresAt <= Date.now()) return { status: 'expired', hint: 'Codex CLI 的登录令牌已过期：在 Codex 里用一次就会刷新。' }
    if (!id.accountId) return { status: 'error', error: '登录文件里没有 ChatGPT 账号 id' }
    const usage = await fetchCodexUsage(access, id.accountId)
    return { plan: usage.plan ?? id.plan, windows: usage.windows, status: usage.limited ? 'limited' : 'ok' }
  })
}

async function claudeCodeCard(): Promise<AccountQuotaCard | null> {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const cred = (await readJson(join(dir, '.credentials.json')))?.claudeAiOauth as
    | { accessToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown; rateLimitTier?: unknown }
    | undefined
  if (typeof cred?.accessToken !== 'string') return null
  const access = cred.accessToken
  const profile = (await readJson(join(homedir(), '.claude.json')))?.oauthAccount as { emailAddress?: unknown; accountUuid?: unknown } | undefined
  const tier = typeof cred.rateLimitTier === 'string' ? cred.rateLimitTier.match(/max_(\d+x)/)?.[1] : undefined
  const plan = [typeof cred.subscriptionType === 'string' ? cred.subscriptionType : '', tier].filter(Boolean).join(' ') || undefined
  const base: CardBase = {
    key: `claude-code:${typeof profile?.accountUuid === 'string' ? profile.accountUuid : 'default'}`,
    source: 'claude-code',
    provider: 'anthropic',
    name: 'Claude',
    email: typeof profile?.emailAddress === 'string' ? profile.emailAddress : undefined,
    plan
  }
  return settle(base, async () => {
    if (Number(cred.expiresAt) <= Date.now()) return { status: 'expired', hint: 'Claude Code 的登录令牌已过期：在终端运行一次 claude 并发一句话就会刷新。' }
    const windows = claudeUsageWindows(await claudeUsage(access))
    return { windows, status: limitedIf(windows) }
  })
}

const CODE_ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal'

async function geminiCliCard(): Promise<AccountQuotaCard | null> {
  const dir = join(homedir(), '.gemini')
  const cred = await readJson(join(dir, 'oauth_creds.json'))
  if (typeof cred?.access_token !== 'string') return null
  const access = cred.access_token
  const active = (await readJson(join(dir, 'google_accounts.json')))?.active
  const email = typeof active === 'string' ? active : undefined
  return settle({ key: `gemini-cli:${email ?? 'default'}`, source: 'gemini-cli', provider: 'gemini', name: 'Gemini', email }, async () => {
    if (Number(cred.expiry_date) <= Date.now()) return { status: 'expired', hint: 'Gemini CLI 的登录令牌只有 1 小时有效期：运行一次 gemini 问一句就会刷新。' }
    const headers = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json' }
    const metadata = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
    const loaded = (await getJson(`${CODE_ASSIST}:loadCodeAssist`, { method: 'POST', headers, body: JSON.stringify({ metadata }) })) as {
      cloudaicompanionProject?: string | { id?: string }
      currentTier?: { name?: string; id?: string }
    }
    const companion = loaded.cloudaicompanionProject
    const project = typeof companion === 'string' ? companion : companion?.id
    if (!project) return { status: 'error', error: '拿不到 Gemini Code Assist 的项目 ID' }
    const windows = geminiQuotaWindows(await getJson(`${CODE_ASSIST}:retrieveUserQuota`, { method: 'POST', headers, body: JSON.stringify({ project }) }))
    return { plan: loaded.currentTier?.name ?? loaded.currentTier?.id, windows, status: limitedIf(windows) }
  })
}

const CLI_CARDS: Record<AccountQuotaCliSource, () => Promise<AccountQuotaCard | null>> = {
  'codex-cli': codexCliCard,
  'claude-code': claudeCodeCard,
  'gemini-cli': geminiCliCard
}

/* ------------------------------------------------------------ 汇总 */

let inflight: Promise<AccountQuotaReport> | null = null

/** 同时只跑一次：磁贴打开、切换后刷新、定时刷新撞在一起时共用同一份结果。 */
export function accountQuotaReport(): Promise<AccountQuotaReport> {
  inflight ??= buildReport().finally(() => {
    inflight = null
  })
  return inflight
}

async function buildReport(): Promise<AccountQuotaReport> {
  const prefs = await readAccountQuotaPrefs()
  const targets = await codexAccountTargets().catch(() => [] as CodexAccountTarget[])
  /* 当前账号排最前，其余按保存顺序 */
  targets.sort((a, b) => Number(b.active) - Number(a.active))
  const jobs: Array<Promise<AccountQuotaCard | null>> = [
    ...targets.map(yanCodexCard),
    yanClaudeCard(),
    ...KEY_PROVIDERS.map(yanKeyCard),
    ...(Object.keys(CLI_CARDS) as AccountQuotaCliSource[]).filter((s) => prefs.sources[s]).map((s) => CLI_CARDS[s]())
  ]
  const settled = await Promise.all(jobs.map((job) => job.catch(() => null)))
  const cards = mergeDuplicateCards(settled.filter((c): c is AccountQuotaCard => !!c))
  for (const card of cards) {
    const label = prefs.labels[card.key]
    if (label) card.label = label
  }
  return { cards, prefs, checkedAt: Date.now() }
}
