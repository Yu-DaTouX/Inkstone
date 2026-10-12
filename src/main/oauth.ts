/**
 * ChatGPT 订阅（OpenAI Codex）OAuth —— **桌面端自己发起登录**，不用回终端跑 `pi /login`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 参数从哪里来：逐字对齐内置 pi 的实现
 * ══════════════════════════════════════════════════════════════════
 * 来源 `resources/pi-runtime/dist/bundle/chunks/openai-codex.js`
 * （pi 的交互式 `/login` 走的就是它，也是唯一一处实现）。
 *
 * client_id / 授权端点 / 换 token 端点 / scope / 重定向地址 / 授权 URL 上那三个
 * 附加参数（`id_token_add_organizations`、`codex_cli_simplified_flow`、`originator`）
 * **必须完全一致** —— 少一个或改一个，OpenAI 签发的 token pi 就不认。
 *
 * 产出的凭证形状与 pi 完全相同，写进同一个 `auth.json`：
 * ```json
 * { "openai-codex": { "type": "oauth", "access": "…", "refresh": "…",
 *                     "expires": 1730000000000, "accountId": "…" } }
 * ```
 * 所以登录完成后 pi 直接可用，之后由 pi 自己刷新（`refresh` 字段就是干这个的）。
 * 桌面端的额度查询（quota.ts）也从这里读 `accountId`。
 *
 * ── 为什么是「浏览器 + 本地回调」这条路 ──
 * 重定向地址 `http://localhost:1455/auth/callback` 的**端口是固定的**，由
 * OpenAI 侧按 client_id 注册，改不了（pi 同样写死 1455）。所以这里必须能监听
 * 1455；端口被占（例如同时开着 pi 的 TUI 登录、或上一次没退干净）时给出明确
 * 报错并让用户退回 `pi /login`，而不是静默失败。
 * pi 另有一条 device code 流程（无需端口，`https://auth.openai.com/codex/device`）
 * 可作无端口回退，本次未接 —— 见 [HANDOFF 的「已知边界」]。
 */
import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { shell } from 'electron'
import type { CodexLoginResult } from '../shared/ipc'
import { mergeAuthEntry } from './credentials'
import { CLIENT_ID, TOKEN_URL, extractAccountId } from './codex-token'

export { refreshCodexCredential, type CodexOAuthCredential } from './codex-token'

/* ------------------------------------------------ 与 pi 逐字一致的常量 */

const AUTH_BASE_URL = 'https://auth.openai.com'
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
const SCOPE = 'openid profile email offline_access'
/** pi 传给 OpenAI 的调用方标识。保持一致 —— 别写 codex_cli_rs，那是 API 调用的伪装。 */
const ORIGINATOR = 'pi'
/** OAuth 回调必须绑定本机回环；拒绝环境变量注入非本机监听地址。 */
const configuredCallbackHost = process.env.PI_OAUTH_CALLBACK_HOST?.trim().toLowerCase()
const CALLBACK_HOST = configuredCallbackHost === 'localhost' || configuredCallbackHost === '127.0.0.1' ? configuredCallbackHost : '127.0.0.1'
/** 用户在浏览器里拖太久就放弃，免得本地端口一直被占着。 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/* ------------------------------------------------------------ 小工具 */

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** PKCE：verifier 是 32 字节随机数的 base64url，challenge = SHA256(verifier) 的 base64url。 */
function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * 回调页：与应用同源的配色与字体分工（设计规范 v0.5）—— 骨架等宽、标题无衬线，
 * 深浅跟随系统，零外链资源（浏览器打开的是本机回调地址，不能依赖应用的样式文件）。
 */
function resultPage(heading: string, message: string, details?: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(heading)}</title>
  <style>
    :root { color-scheme: dark; --bg: #151515; --bg2: #1b1b1a; --border: rgba(255,255,255,.1);
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

/**
 * 授权码 → 凭证。**一次授权码只能换一次**，所以全流程只从这里调一次。
 */
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

/* ------------------------------------------------------------ 主流程 */

/** 同一时刻只允许一次登录（端口只有一个，且避免两套 PKCE 互相踩）。 */
let active: { cancel: () => void } | null = null

/** 界面上的「取消」—— 让等待中的 Promise 立刻返回，端口随之释放。 */
export function cancelCodexLogin(): void {
  active?.cancel()
}

/**
 * 走完整个登录：起本地回调 → 开系统浏览器 → 等授权码 → 换 token → 写 auth.json。
 *
 * 返回的 Promise 在**流程结束时 resolve**（成功、失败、取消、超时都 resolve，
 * 不 reject）—— 渲染层就是 await 它来显示「等待浏览器授权…」。
 */
export async function startCodexLogin(): Promise<CodexLoginResult> {
  if (active) return { ok: false, error: '已有一次登录在进行中' }

  const { verifier, challenge } = createPkce()
  const state = base64url(randomBytes(16))
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  // 下面三个是 pi 的实现里带的，OpenAI 侧会看 —— 不能省。
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', ORIGINATOR)

  /* ---- 1. 等结果的信箱（回调线程和超时/取消都往这里投递，只认第一次） ---- */
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

  /* ---- 2. 本地回调服务 ---- */
  const server: Server = createServer((req, res) => {
    const reply = (status: number, html: string): void => {
      try {
        res.statusCode = status
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(html)
      } catch {
        /* 浏览器提前断开就算了 */
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
    /* state 必须对上：防的是别人伪造回调把授权码塞进来。 */
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
    /*
     * 先不回复浏览器：等换完 token 再回，这样页面能如实显示成功还是失败
     * （pi 是先回「成功」页再换 token，失败时那个页面会说谎）。
     */
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

  /* ---- 3. 开浏览器（这一步就是「不用回终端」的关键） ---- */
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

  /* ---- 4. 等回调跑完 ---- */
  try {
    return await outcome
  } finally {
    clearTimeout(timer)
    active = null
    try {
      server.close()
    } catch {
      /* 已经关了就算了 */
    }
  }
}

/** 给界面/日志用的：回调端口是固定值，端口被占时要能说清是哪个端口。 */
export { CALLBACK_PORT }
