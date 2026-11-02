import { net } from 'electron'
import { CLAUDE_OAUTH_HEADERS } from '../shared/account-quota'

const CLAUDE_MIN_GAP_MS = 60_000
const CLAUDE_BACKOFF_MS = 5 * 60_000
const claudeUsageCache = new Map<string, { at: number; usage: unknown }>()
const claudeCooldown = new Map<string, number>()

function retryAfterMs(value: string | null): number {
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const at = value ? Date.parse(value) : NaN
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : CLAUDE_BACKOFF_MS
}

export function forgetClaudeUsage(): void {
  claudeUsageCache.clear()
}

export async function claudeUsage(accessToken: string, revoked = '登录已失效'): Promise<unknown> {
  const now = Date.now()
  const cached = claudeUsageCache.get(accessToken)
  if (cached && now - cached.at < CLAUDE_MIN_GAP_MS) return cached.usage
  const until = claudeCooldown.get(accessToken) ?? 0
  if (until > now) throw new Error(`查询太频繁，${Math.ceil((until - now) / 60_000)} 分钟后重试`)
  const res = await net.fetch('https://api.anthropic.com/api/oauth/usage?cedar_ember=1', {
    headers: { Authorization: `Bearer ${accessToken}`, ...CLAUDE_OAUTH_HEADERS },
    signal: AbortSignal.timeout(10_000)
  })
  if (res.status === 429) {
    const wait = Math.min(30 * 60_000, Math.max(CLAUDE_MIN_GAP_MS, retryAfterMs(res.headers.get('retry-after'))))
    claudeCooldown.set(accessToken, Date.now() + wait)
    throw new Error(`查询太频繁（HTTP 429），${Math.ceil(wait / 60_000)} 分钟后重试`)
  }
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? revoked : `HTTP ${res.status}`)
  const usage = await res.json()
  claudeCooldown.delete(accessToken)
  claudeUsageCache.set(accessToken, { at: Date.now(), usage })
  return usage
}
