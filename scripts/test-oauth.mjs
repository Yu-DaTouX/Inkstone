/**
 * 应用内登录 ChatGPT 订阅（Codex）—— **全流程测试，不联网、不开浏览器**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么值得测到这个程度
 * ══════════════════════════════════════════════════════════════════
 * 这条流程里**所有参数都是「写错就静默坏」的**：
 *   · client_id / redirect_uri / scope / 那三个附加参数错了 → OpenAI 直接拒，
 *     或者签发的 token pi 不认（而 pi 只在下次真正调用模型时才暴露）；
 *   · PKCE 的 verifier 与 challenge 对不上 → 换 token 才失败；
 *   · state 不校验 → 任何人都能把授权码塞进回调；
 *   · 换 token 的响应字段名错了 → 写进 auth.json 的凭证残缺。
 * 这些都不适合靠「手工点一次浏览器」来验，也不该每次都真去 OpenAI 走一遍。
 *
 * 做法：把两个外部依赖换成桩 ——
 *   · `electron` 的 `shell.openExternal` → 把授权 URL 写到文件（测试从中读 state/参数）
 *   · 全局 `fetch` → 只拦 `auth.openai.com` 的换 token 请求，回一个我们自造的 JWT；
 *     打到本机 1455 回调的请求**原样放行**（那是被测代码自己的 HTTP 服务）
 * 于是：本地回调服务、state 校验、PKCE 一致性、换 token 的请求体、
 * accountId 提取、auth.json 的写入形状 —— 全部真实执行。
 */
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** 造一个 access token（真实流程里它是 JWT，accountId 藏在自定义 claim 里）。 */
function fakeAccessToken(accountId) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`
}

export async function runOAuthTests(ok) {
  const dir = await mkdtemp(join(tmpdir(), 'yan-oauth-'))
  /* ⚠️ 必须在 import 之前设：credentials.ts（被 oauth.ts 引用）在模块顶层算 AUTH_FILE */
  process.env.YAN_PI_DIR = dir
  const urlFile = join(dir, 'authorize-url.txt')
  process.env.YAN_TEST_OAUTH_URL_FILE = urlFile

  /* ---- electron 桩：openExternal 只记账，不开浏览器 ---- */
  const electronStub = join(dir, 'electron-stub.mjs')
  await writeFile(
    electronStub,
    [
      "import { writeFileSync } from 'node:fs'",
      'export const shell = {',
      '  async openExternal(url) {',
      '    writeFileSync(process.env.YAN_TEST_OAUTH_URL_FILE, url)',
      '  }',
      '}'
    ].join('\n')
  )

  await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
    build({
      entryPoints: ['src/main/oauth.ts'],
      outfile: 'out/test/oauth.mjs',
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
      alias: { electron: electronStub }
    })
  )
  const { startCodexLogin, cancelCodexLogin } = await import('../out/test/oauth.mjs')

  /* ---- fetch 桩：拦 OpenAI 的换 token，放行本机回调 ---- */
  const realFetch = globalThis.fetch
  const tokenCalls = []
  const ACCOUNT_ID = 'acc-test-123'
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (!url.startsWith('https://auth.openai.com/')) {
      return realFetch(input, init) // 本机 1455 回调交给真实实现
    }
    tokenCalls.push({ url, init })
    return new Response(
      JSON.stringify({ access_token: fakeAccessToken(ACCOUNT_ID), refresh_token: 'rt-test', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const waitForFile = async (path, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        return await readFile(path, 'utf8')
      } catch {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    return null
  }

  /* ================= 1. 负例：state 不匹配必须被拒 ================= */
  {
    let login = startCodexLogin()
    const raw = await waitForFile(urlFile)
    if (!raw) {
      ok(false, '登录流程把授权 URL 交给了浏览器（openExternal 被调用）')
      cancelCodexLogin()
      await login
      return
    }
    const res = await realFetch('http://127.0.0.1:1455/auth/callback?code=fake&state=WRONG')
    ok(res.status === 400, 'state 不匹配的回调被拒（400）', `实际 ${res.status}`)
    const r = await login
    ok(r.ok === false && /state/.test(r.error ?? ''), 'state 不匹配时登录返回错误而不是成功', r.error)
  }

  /* ================= 2. 正例：参数 → 回调 → 换 token → 写入 ================= */
  tokenCalls.length = 0
  const login = startCodexLogin()
  const raw = await waitForFile(urlFile)
  const authUrl = new URL(raw ?? 'http://invalid')
  const state = authUrl.searchParams.get('state')

  /* ---- 2.1 授权 URL 的参数必须与 pi 完全一致（错一个 pi 就不认这个 token） ---- */
  ok(authUrl.origin + authUrl.pathname === 'https://auth.openai.com/oauth/authorize', '授权端点是 auth.openai.com/oauth/authorize')
  ok(authUrl.searchParams.get('client_id') === 'app_EMoamEEZ73f0CkXaXp7hrann', 'client_id 与 pi 一致')
  ok(
    authUrl.searchParams.get('redirect_uri') === 'http://localhost:1455/auth/callback',
    'redirect_uri 是注册过的固定回调地址'
  )
  ok(authUrl.searchParams.get('scope') === 'openid profile email offline_access', 'scope 与 pi 一致')
  ok(authUrl.searchParams.get('code_challenge_method') === 'S256', 'PKCE 用 S256')
  ok(authUrl.searchParams.get('response_type') === 'code', 'response_type=code')
  ok(
    authUrl.searchParams.get('id_token_add_organizations') === 'true' &&
      authUrl.searchParams.get('codex_cli_simplified_flow') === 'true' &&
      !!authUrl.searchParams.get('originator'),
    '三个附加参数都在（id_token_add_organizations / codex_cli_simplified_flow / originator）'
  )
  ok(!!state && state.length >= 16, 'state 是随机串（防伪造回调）', String(state).slice(0, 8) + '…')

  /* ---- 2.2 回调 ---- */
  const cb = await realFetch(`http://127.0.0.1:1455/auth/callback?code=auth-code-1&state=${state}`)
  ok(cb.status === 200, '带正确 state 的回调返回 200', `实际 ${cb.status}`)
  const html = await cb.text()
  ok(/登录成功/.test(html), '回调页告诉用户成功了')
  const r = await login
  ok(r.ok === true, '登录流程成功返回', r.error)
  ok(r.accountId === ACCOUNT_ID, 'accountId 从 access token 的 claim 里取到', r.accountId)

  /* ---- 2.3 换 token 的请求体 ---- */
  ok(tokenCalls.length === 1, '只换了一次 token（授权码只能用一次）', `实际 ${tokenCalls.length} 次`)
  const body = new URLSearchParams(String(tokenCalls[0]?.init?.body ?? ''))
  ok(tokenCalls[0]?.url === 'https://auth.openai.com/oauth/token', '换 token 打到 auth.openai.com/oauth/token')
  ok(body.get('grant_type') === 'authorization_code', 'grant_type=authorization_code')
  ok(body.get('code') === 'auth-code-1', '带上回调里的授权码')
  ok(body.get('client_id') === 'app_EMoamEEZ73f0CkXaXp7hrann', '换 token 也带同一个 client_id')
  ok(
    body.get('redirect_uri') === 'http://localhost:1455/auth/callback',
    '换 token 的 redirect_uri 与授权时完全一致（不一致会被拒）'
  )
  /* PKCE 一致性：verifier 的 SHA256 必须等于授权 URL 上的 challenge */
  const verifier = body.get('code_verifier') ?? ''
  const challenge = Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64url')
  ok(verifier.length > 20, '带了 code_verifier')
  ok(challenge === authUrl.searchParams.get('code_challenge'), 'code_verifier 与 code_challenge 是同一对（PKCE 自洽）')

  /* ---- 2.4 写进 auth.json 的形状必须与 pi 期望的一致 ---- */
  const written = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
  const cred = written['openai-codex']
  ok(!!cred, '凭证写进 openai-codex 这个键')
  ok(cred?.type === 'oauth', 'type=oauth（pi 按这个分辨订阅制）')
  ok(cred?.access === fakeAccessToken(ACCOUNT_ID), 'access 是换回来的 access token')
  ok(cred?.refresh === 'rt-test', 'refresh 存下来了（以后由 pi 续期）')
  ok(
    typeof cred?.expires === 'number' && cred.expires > Date.now() && cred.expires < Date.now() + 3700_000,
    'expires 是按 expires_in 算出的绝对时间戳'
  )
  ok(cred?.accountId === ACCOUNT_ID, 'accountId 一并存下（额度查询要用）')

  /* ================= 3. 流程结束后端口必须释放 ================= */
  {
    const again = startCodexLogin()
    const raw2 = await waitForFile(urlFile)
    const url2 = new URL(raw2 ?? 'http://invalid')
    ok(url2.searchParams.get('state') !== state, '第二次登录用新的 state（不复用）')
    cancelCodexLogin()
    const r2 = await again
    ok(r2.ok === false, '取消登录返回失败而不是挂住', r2.error)
  }

  globalThis.fetch = realFetch
  await mkdir(join(dir, 'done'), { recursive: true })
}
