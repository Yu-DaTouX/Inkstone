export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

export interface CodexOAuthCredential {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const parsed = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function extractAccountId(accessToken: string): string | null {
  const claim = decodeJwtPayload(accessToken)?.[JWT_CLAIM_PATH]
  if (!claim || typeof claim !== 'object') return null
  const id = (claim as Record<string, unknown>).chatgpt_account_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

export function isCodexCredential(v: unknown): v is CodexOAuthCredential {
  const c = v as Partial<CodexOAuthCredential> | null
  return !!c && c.type === 'oauth' && typeof c.access === 'string' && typeof c.refresh === 'string' && typeof c.accountId === 'string'
}

export async function refreshCodexCredential(refresh: string, storedAccountId?: string): Promise<CodexOAuthCredential> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(res.status === 400 || res.status === 401 ? '登录已失效，请重新登录这个账号' : `刷新登录失败（${res.status}）${body ? '：' + body.slice(0, 120) : ''}`)
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null
  if (!json || typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string' || typeof json.expires_in !== 'number') {
    throw new Error('刷新登录的响应缺字段')
  }
  const accountId = extractAccountId(json.access_token) ?? storedAccountId
  if (!accountId) throw new Error('刷新后的令牌里没有 accountId，且没有已存 accountId 可回退')
  return { type: 'oauth', access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000, accountId }
}
