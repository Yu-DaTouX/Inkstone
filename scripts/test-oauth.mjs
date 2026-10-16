import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

function fakeAccessToken(accountId) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`
}

export async function runOAuthTests(ok) {
  const dir = await mkdtemp(join(tmpdir(), 'yan-oauth-'))
  process.env.YAN_PI_DIR = dir
  const urlFile = join(dir, 'authorize-url.txt')
  process.env.YAN_TEST_OAUTH_URL_FILE = urlFile

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

  const realFetch = globalThis.fetch
  const tokenCalls = []
  const ACCOUNT_ID = 'acc-test-123'
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (!url.startsWith('https://auth.openai.com/')) {
      return realFetch(input, init)
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

  tokenCalls.length = 0
  const login = startCodexLogin()
  const raw = await waitForFile(urlFile)
  const authUrl = new URL(raw ?? 'http://invalid')
  const state = authUrl.searchParams.get('state')

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

  const cb = await realFetch(`http://127.0.0.1:1455/auth/callback?code=auth-code-1&state=${state}`)
  ok(cb.status === 200, '带正确 state 的回调返回 200', `实际 ${cb.status}`)
  const html = await cb.text()
  ok(/登录成功/.test(html), '回调页告诉用户成功了')
  const r = await login
  ok(r.ok === true, '登录流程成功返回', r.error)
  ok(r.accountId === ACCOUNT_ID, 'accountId 从 access token 的 claim 里取到', r.accountId)

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
  const verifier = body.get('code_verifier') ?? ''
  const challenge = Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64url')
  ok(verifier.length > 20, '带了 code_verifier')
  ok(challenge === authUrl.searchParams.get('code_challenge'), 'code_verifier 与 code_challenge 是同一对（PKCE 自洽）')

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
