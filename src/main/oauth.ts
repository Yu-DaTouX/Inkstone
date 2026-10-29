import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { shell } from 'electron'
import type { CodexLoginResult } from '../shared/ipc'
import { encodeBase64Url } from '../shared/base64url'
import { escapeHtml } from '../shared/escape'
import { mergeAuthEntry } from './credentials'
import { CLIENT_ID, TOKEN_URL, extractAccountId } from './codex-token'

export { refreshCodexCredential, type CodexOAuthCredential } from './codex-token'

const AUTH_BASE_URL = 'https://auth.openai.com'
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
const SCOPE = 'openid profile email offline_access'
const ORIGINATOR = 'pi'
const configuredCallbackHost = process.env.PI_OAUTH_CALLBACK_HOST?.trim().toLowerCase()
const CALLBACK_HOST = configuredCallbackHost === 'localhost' || configuredCallbackHost === '127.0.0.1' ? configuredCallbackHost : '127.0.0.1'
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

function createPkce(): { verifier: string; challenge: string } {
  const verifier = encodeBase64Url(randomBytes(32))
  const challenge = encodeBase64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function resultPage(heading: string, message: string, details?: string): string {
  const esc = escapeHtml
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(heading)}</title>
  <style>
    :root { color-scheme: dark; --bg: #171717; --bg2: #1b1b1a; --border: rgba(255,255,255,.1);
            --fg: #ecece8; --dim: #b4b4ac; --mute: #92928a; --accent: #93a4f4;
            --mono: "Maple Mono CN", ui-monospace, Consolas, monospace;
            --sans: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif; }
    @media (prefers-color-scheme: light) {
      :root { color-scheme: light; --bg: #fcfcfa; --bg2: #f3f3f0; --border: rgba(0,0,0,.13);
              --fg: #252522; --dim: #66665f; --mute: #73736b; --accent: #5264c8; }
    }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
           padding: 24px; box-sizing: border-box; background: var(--bg); color: var(--fg);
           font-family: var(--mono); font-size: 13px; }
    main { width: min(520px, 100%); padding: 24px; border: 1px solid var(--border); border-radius: 12px;
           background: var(--bg2); }
    .brand { margin: 0 0 16px; color: var(--mute); font-size: 12px; }
    .brand b { color: var(--accent); font-weight: 600; }
    h1 { margin: 0 0 8px; font-family: var(--sans); font-size: 18px; font-weight: 600; }
    p { margin: 0; color: var(--dim); font-family: var(--sans); font-size: 14px; line-height: 1.7; }
    .details { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--mute);
               font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <main>
    <p class="brand"><b>›</b> 砚 · Inkstone</p>
    <h1>${esc(heading)}</h1>
    <p>${esc(message)}</p>
    ${details ? `<div class="details">${esc(details)}</div>` : ''}
  </main>
</body>
</html>`
}

async function exchangeCode(code: string, verifier: string, signal: AbortSignal): Promise<CodexLoginResult> {
  let tokenRes: Response
  try {
    tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI
      }),
      signal
    })
  } catch (e) {
    return { ok: false, error: `网络请求失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (!tokenRes.ok) {
    return { ok: false, error: `换取 token 失败（HTTP ${tokenRes.status}）` }
  }
  const json = (await tokenRes.json().catch(() => null)) as
    | { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
    | null
  if (!json) return { ok: false, error: 'token 响应缺少必需字段：access_token、refresh_token、expires_in' }
  const missing = [
    ...(typeof json.access_token !== 'string' ? ['access_token'] : []),
    ...(typeof json.refresh_token !== 'string' ? ['refresh_token'] : []),
    ...(typeof json.expires_in !== 'number' ? ['expires_in'] : [])
  ]
  if (missing.length) return { ok: false, error: `token 响应缺少必需字段：${missing.join(', ')}` }
  if (typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string' || typeof json.expires_in !== 'number') {
    return { ok: false, error: 'token 响应缺少必需字段' }
  }
  const accountId = extractAccountId(json.access_token)
  if (!accountId) return { ok: false, error: '无法从 token 里取到 accountId，登录未完成' }

  if (signal.aborted) return { ok: false, error: '已取消登录' }
  const written = await mergeAuthEntry('openai-codex', {
    type: 'oauth',
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId
  }, signal)
  if (!written.ok) return { ok: false, error: written.error ?? '写入 auth.json 失败' }
  return { ok: true, accountId }
}

let active: { cancel: () => void } | null = null

export function cancelCodexLogin(): void {
  active?.cancel()
}

export async function startCodexLogin(): Promise<CodexLoginResult> {
  if (active) return { ok: false, error: '已有一次登录在进行中' }

  const { verifier, challenge } = createPkce()
  const state = encodeBase64Url(randomBytes(16))
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', ORIGINATOR)

  let settle: (r: CodexLoginResult) => void = () => {}
  const outcome = new Promise<CodexLoginResult>((resolve) => {
    let done = false
    settle = (r) => {
      if (done) return
      done = true
      resolve(r)
    }
  })

  const controller = new AbortController()

  const server: Server = createServer((req, res) => {
    const reply = (status: number, html: string): void => {
      try {
        res.statusCode = status
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(html)
      } catch {
      }
    }
    let reqUrl: URL
    try {
      reqUrl = new URL(req.url || '', 'http://localhost')
    } catch {
      reply(400, resultPage('登录失败', '回调地址无法解析。'))
      settle({ ok: false, error: '回调地址无法解析' })
      return
    }
    if (reqUrl.pathname !== CALLBACK_PATH) {
      reply(404, resultPage('登录失败', '回调路由不存在。'))
      return
    }
    if (reqUrl.searchParams.get('state') !== state) {
      reply(400, resultPage('登录失败', 'state 不匹配，已拒绝这个回调。'))
      settle({ ok: false, error: 'state 不匹配，已拒绝这个回调' })
      return
    }
    const err = reqUrl.searchParams.get('error')
    if (err) {
      const desc = reqUrl.searchParams.get('error_description') ?? ''
      const detail = `${err}${desc ? ': ' + desc : ''}`
      reply(400, resultPage('登录失败', '授权被拒绝。', detail))
      settle({ ok: false, error: detail })
      return
    }
    const code = reqUrl.searchParams.get('code')
    if (!code) {
      reply(400, resultPage('登录失败', '回调里没有授权码。'))
      settle({ ok: false, error: '回调里没有授权码' })
      return
    }
    void (async () => {
      const r = await exchangeCode(code, verifier, controller.signal)
      if (r.ok) reply(200, resultPage('登录成功', 'ChatGPT 已接入，可以关闭这个页面回到砚。'))
      else reply(500, resultPage('登录失败', '换取凭证失败。', r.error))
      settle(r)
    })()
  })

  const listenError = await new Promise<string | null>((resolve) => {
    server.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'unknown'))
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve(null))
  })
  if (listenError) {
    server.close()
    if (listenError === 'EADDRINUSE') {
      return {
        ok: false,
        error: `本地端口 ${CALLBACK_PORT} 被占用（可能上一次登录还没结束，或 pi 的 TUI 正在登录）。稍后重试，或退回终端跑 pi → /login。`
      }
    }
    return { ok: false, error: `无法监听本地回调端口 ${CALLBACK_PORT}：${listenError}` }
  }

  const timer = setTimeout(() => {
    controller.abort()
    settle({ ok: false, error: '登录超时（5 分钟未完成）' })
  }, LOGIN_TIMEOUT_MS)
  active = { cancel: () => {
    controller.abort()
    settle({ ok: false, error: '已取消登录' })
  } }

  try {
    await shell.openExternal(url.toString())
  } catch (e) {
    clearTimeout(timer)
    active = null
    server.close()
    return { ok: false, error: `打不开浏览器：${e instanceof Error ? e.message : String(e)}` }
  }

  try {
    return await outcome
  } finally {
    clearTimeout(timer)
    active = null
    try {
      server.close()
    } catch {
    }
  }
}

export { CALLBACK_PORT }
