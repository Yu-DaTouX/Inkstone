/**
 * ChatGPT（Codex）OAuth 令牌的纯网络部分：解析 access token、用 refresh token 换新凭证。
 *
 * 从 oauth.ts 拆出来是为了不依赖 Electron：生图等主进程服务、以及单测 bundle
 * 都要用到刷新，但不该把登录流程（开浏览器、监听 1455 端口）一起带进来。
 * 常量与请求体逐字对齐内置 pi 的实现，见 oauth.ts 文件头。
 */

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/** pi 存在 auth.json 里的 ChatGPT 凭证形状。 */
export interface CodexOAuthCredential {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
}

/** 取 JWT 的 payload（access token 是 JWT，accountId 藏在自定义 claim 里）。 */
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

/**
 * 从 access token 里取 `chatgpt_account_id`。
 *
 * 拿不到就直接判失败 —— 缺 accountId 的凭证 pi 能存但用不了：额度查询会报
 * 「凭证缺少 chatgpt-account-id，请重新登录 ChatGPT」（见 quota.ts）。
 * 与其写一个残缺凭证让用户以后自己踩，不如当场报错。
 */
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

/**
 * 用 refresh token 换新凭证，请求体与 pi 的刷新逐字一致（grant_type / refresh_token / client_id）。
 * refresh token 会轮换，调用方必须马上保存返回的新凭证，否则这个账号要重新登录。
 */
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
