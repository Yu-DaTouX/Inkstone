import { mkdtemp, mkdir, readdir, readFile, rm, rmdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => `${b64({ alg: 'none' })}.${b64(payload)}.sig`

function credential({ account, user, email, plan = 'plus', expires = Date.now() + 86_400_000, tag = '1' }) {
  const access = jwt({
    exp: Math.floor(expires / 1000),
    tag,
    'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: user, chatgpt_plan_type: plan },
    'https://api.openai.com/profile': { email }
  })
  return { type: 'oauth', access, refresh: `refresh-${account}-${tag}`, expires, accountId: account }
}

export async function runAccountQuotaTests(ok) {
  const { build } = await import('esbuild')

  await build({ entryPoints: ['src/shared/account-quota.ts'], outfile: 'out/test/account-quota.mjs', bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
  const s = await import(pathToFileURL(join(process.cwd(), 'out/test/account-quota.mjs')).href)

  ok(s.decodeJwtClaims(jwt({ name: '砚' })).name === '砚', 'JWT：base64url 与中文都能解出')
  ok(Object.keys(s.decodeJwtClaims('not-a-jwt')).length === 0 && Object.keys(s.decodeJwtClaims(undefined)).length === 0, 'JWT：坏令牌返回空对象，不抛错')

  const a = credential({ account: 'acct-a', user: 'user-a', email: 'a@example.com' })
  const piId = s.chatGptIdentity(a.access, undefined, a.accountId)
  const cliId = s.chatGptIdentity(a.access, jwt({ email: 'a@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-a', chatgpt_user_id: 'user-a' } }))
  ok(piId.key === 'chatgpt:acct-a:user-a', '身份：key = 账号 + 用户')
  ok(piId.key === cliId.key, '身份：砚（只有 access token）与 Codex CLI（另有 id token）算出同一个 key，才能去重')
  ok(piId.email === 'a@example.com' && piId.plan === 'plus', '身份：邮箱与套餐来自令牌')
  const team = s.chatGptIdentity(credential({ account: 'team', user: 'u2', email: 'b@example.com' }).access)
  ok(team.key !== s.chatGptIdentity(credential({ account: 'team', user: 'u1', email: 'c@example.com' }).access).key, '身份：Team 工作区同一 account id 的两个人是两个账号')

  const codex = s.codexUsageWindows({
    plan_type: 'pro',
    rate_limit: { limit_reached: false, primary_window: { used_percent: 38, limit_window_seconds: 18000, reset_at: 1_800_000_000 }, secondary_window: { used_percent: 6, limit_window_seconds: 604800 } }
  })
  ok(codex.plan === 'pro' && codex.windows.length === 2 && !codex.limited, 'Codex：两个窗口 + 套餐')
  ok(codex.windows[0].label === '五小时' && codex.windows[1].label === '本周', 'Codex：窗口名与右栏额度一致')
  ok(codex.windows[0].used === 38 && codex.windows[0].total === 100 && codex.windows[0].resetAt === 1_800_000_000_000, 'Codex：百分比口径、秒级重置时间转毫秒')
  ok(s.codexUsageWindows({ rate_limit: { limit_reached: true } }).limited, 'Codex：limit_reached 标成已达上限')
  ok(s.codexUsageWindows({ rate_limit: null }).windows.length === 0, 'Codex：没有 rate_limit 时没有窗口（调用方报错，不编数字）')

  const claude = s.claudeUsageWindows({
    five_hour: { utilization: 12, resets_at: '2026-10-07T15:00:00+00:00' },
    seven_day: { utilization: 100, resets_at: null },
    seven_day_opus: null,
    extra_usage: { is_enabled: false, utilization: null }
  })
  ok(claude.length === 2, 'Claude：只取有 utilization 的窗口，null 与未开的额外用量跳过')
  ok(claude[0].label === '五小时' && claude[0].resetAt === Date.parse('2026-10-07T15:00:00+00:00'), 'Claude：窗口名与重置时间')
  ok(claude[1].exceeded === true && claude[1].resetAt === undefined, 'Claude：100% 标为已超限，缺重置时间不编')

  const gemini = s.geminiQuotaWindows({
    buckets: [
      { modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-10-08T00:00:00Z', tokenType: 'REQUESTS' },
      { modelId: 'gemini-2.5-flash', remainingFraction: 1 },
      { modelId: 'gemini-2.5-pro', remainingFraction: 0.1, tokenType: 'REQUESTS' },
      { modelId: 'gemini-x', remainingFraction: 0.5, tokenType: 'INPUT_TOKENS' },
      { remainingFraction: 0.5 }
    ]
  })
  ok(gemini.map((w) => w.label).join('|') === 'gemini-2.5-flash|gemini-2.5-pro|gemini-x (INPUT_TOKENS)', 'Gemini：按模型去重、排序，非请求数的桶标出类型')
  ok(gemini.find((w) => w.label === 'gemini-2.5-pro').used === 75, 'Gemini：剩余比例换成已用百分比')
  ok(s.geminiQuotaWindows({}).length === 0, 'Gemini：没有 buckets 时为空')

  const card = (key, source, extra = {}) => ({ key, source, provider: 'openai-codex', name: 'ChatGPT', status: 'ok', windows: [], checkedAt: 0, ...extra })
  const merged = s.mergeDuplicateCards([card('k', 'yan', { active: true }), card('k', 'codex-cli'), card('other', 'codex-cli')])
  ok(merged.length === 2 && merged[0].source === 'yan' && merged[0].alsoIn?.[0] === 'codex-cli', '去重：同一账号只留砚的卡，记下也在 Codex CLI 登录')
  ok(s.accountCardTitle({ label: '主号', email: 'a@x', name: 'ChatGPT' }) === '主号' && s.accountCardTitle({ email: 'a@x', name: 'ChatGPT' }) === 'a@x' && s.accountCardTitle({ name: 'ChatGPT' }) === 'ChatGPT', '标题：备注 > 邮箱 > 默认名')
  ok(s.cardPeakPercent({ windows: [{ used: 38, total: 100 }, { used: 6, total: 100 }] }) === 38 && s.cardPeakPercent({ windows: [] }) === null, '摘要：取最紧窗口')

  const root = await mkdtemp(join(tmpdir(), 'yan-accounts-'))
  const piDir = join(root, 'pi'), dataDir = join(root, 'yan')
  process.env.YAN_PI_DIR = piDir
  process.env.YAN_DATA_DIR = dataDir
  const authFile = join(piDir, 'auth.json'), lockDir = `${authFile}.lock`, storeFile = join(dataDir, 'codex-accounts.json')
  const readAuth = async () => JSON.parse(await readFile(authFile, 'utf8'))
  const writeAuth = async (data) => { await mkdir(piDir, { recursive: true }); await writeFile(authFile, JSON.stringify(data)) }
  const fetchCalls = []
  const realFetch = globalThis.fetch
  try {
    await build({
      entryPoints: ['src/main/codex-accounts.ts'], outfile: 'out/test/codex-accounts.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'electron-stub', setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app = { isPackaged: false, getPath: () => ${JSON.stringify(root)}, getLocale: () => 'zh-CN', getVersion: () => 'fixture' }; export const shell = { openExternal: async () => {} };` }))
      } }]
    })
    const m = await import(pathToFileURL(join(process.cwd(), 'out/test/codex-accounts.mjs')).href + `?t=${Date.now()}`)

    ok((await m.listCodexAccounts()).length === 0, '副本：没登录时没有账号')

    const A1 = credential({ account: 'acct-a', user: 'user-a', email: 'a@example.com' })
    await writeAuth({ 'openai-codex': A1, deepseek: { type: 'api_key', key: 'sk-test' } })
    let list = await m.listCodexAccounts({ 'chatgpt:acct-a:user-a': '主号' })
    ok(list.length === 1 && list[0].active && list[0].email === 'a@example.com' && list[0].label === '主号', '副本：当前账号被收进列表并带上备注')

    const B1 = credential({ account: 'acct-b', user: 'user-b', email: 'b@example.com' })
    await writeAuth({ 'openai-codex': B1, deepseek: { type: 'api_key', key: 'sk-test' } })
    list = await m.listCodexAccounts()
    ok(list.length === 2 && list.find((x) => x.email === 'b@example.com').active && !list.find((x) => x.email === 'a@example.com').active, '副本：登录第二个账号后两个都在，当前是新账号')

    const B2 = credential({ account: 'acct-b', user: 'user-b', email: 'b@example.com', tag: '2', expires: Date.now() + 2 * 86_400_000 })
    await writeAuth({ 'openai-codex': B2, deepseek: { type: 'api_key', key: 'sk-test' } })
    let r = await m.switchCodexAccount('chatgpt:acct-a:user-a')
    let auth = await readAuth()
    ok(r.ok && auth['openai-codex'].access === A1.access, '切换：auth.json 换成目标账号的凭证')
    ok(auth.deepseek?.key === 'sk-test', '切换：auth.json 里其它服务的凭证原样保留')
    let store = JSON.parse(await readFile(storeFile, 'utf8'))
    ok(store.accounts.find((x) => x.key === 'chatgpt:acct-b:user-b').credential.refresh === B2.refresh, '切换：切走前收回了 pi 刚刷新的令牌（轮换后的 refresh token 没丢）')
    ok(!(await m.switchCodexAccount('chatgpt:nobody:x')).ok, '切换：不存在的账号拒绝')

    await mkdir(lockDir)
    const started = Date.now()
    setTimeout(() => void rmdir(lockDir), 250)
    r = await m.switchCodexAccount('chatgpt:acct-b:user-b')
    ok(r.ok && Date.now() - started >= 200, '锁：auth.json.lock 被占用时等待，不与 pi 的刷新交叉写')
    ok((await readAuth())['openai-codex'].refresh === B2.refresh, '锁：放开后照常切换')

    await mkdir(lockDir)
    const old = new Date(Date.now() - 60_000)
    await utimes(lockDir, old, old)
    r = await m.switchCodexAccount('chatgpt:acct-a:user-a')
    ok(r.ok && (await readAuth())['openai-codex'].access === A1.access, '锁：超时残留的锁会被清掉')

    const Aexpired = { ...A1, expires: Date.now() - 1000 }
    await writeAuth({ 'openai-codex': Aexpired, deepseek: { type: 'api_key', key: 'sk-test' } })
    store = JSON.parse(await readFile(storeFile, 'utf8'))
    store.accounts.find((x) => x.key === 'chatgpt:acct-b:user-b').credential.expires = Date.now() - 1000
    await writeFile(storeFile, JSON.stringify(store))
    const B3 = credential({ account: 'acct-b', user: 'user-b', email: 'b@example.com', tag: '3' })
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ access_token: B3.access, refresh_token: B3.refresh, expires_in: 864000 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const targets = await m.codexAccountTargets()
    const ta = targets.find((x) => x.key === 'chatgpt:acct-a:user-a'), tb = targets.find((x) => x.key === 'chatgpt:acct-b:user-b')
    ok(ta.active && !ta.credential && ta.problem === 'expired', '额度：当前账号过期时不抢 pi 的刷新')
    ok(tb.credential?.access === B3.access, '额度：非当前账号过期时由砚刷新')
    ok(fetchCalls.length === 1 && /grant_type=refresh_token/.test(fetchCalls[0].body) && /client_id=/.test(fetchCalls[0].body) && fetchCalls[0].body.includes(encodeURIComponent(B2.refresh)), '额度：刷新请求与 pi 同形（grant_type / refresh_token / client_id），只发一次')
    store = JSON.parse(await readFile(storeFile, 'utf8'))
    ok(store.accounts.find((x) => x.key === 'chatgpt:acct-b:user-b').credential.refresh === B3.refresh, '额度：轮换后的 refresh token 已落盘')
    ok((await readAuth())['openai-codex'].access === Aexpired.access, '额度：查额度不改 auth.json')

    r = await m.removeCodexAccount('chatgpt:acct-a:user-a')
    auth = await readAuth()
    ok(r.ok && r.wasActive && !('openai-codex' in auth) && auth.deepseek?.key === 'sk-test', '移除：当前账号从 auth.json 退出，其它服务保留')
    list = await m.listCodexAccounts()
    ok(list.length === 1 && list[0].email === 'b@example.com' && !list[0].active, '移除：列表只剩另一个账号，且不是当前账号')

    await writeFile(storeFile, '{ not json')
    let rejected = null
    try { await m.listCodexAccounts() } catch (error) { rejected = error }
    ok(!!rejected && /格式无效/.test(rejected.message), '损坏：读取时明确报错，不默默清空账号')
    for (let i = 0; i < 3; i += 1) await m.listCodexAccounts().catch(() => undefined)
    const backups = (await readdir(dataDir)).filter((name) => name.startsWith('codex-accounts.json.corrupt'))
    ok(backups.length === 1 && backups[0] === 'codex-accounts.json.corrupt.bak', '损坏：反复读取只留一份固定名的备份')
    const switched = await m.switchCodexAccount('chatgpt:acct-b:user-b')
    ok(switched.ok === false && typeof switched.error === 'string' && /格式无效/.test(switched.error), '损坏：切换账号返回 ok:false 而不是 reject')
  } finally {
    globalThis.fetch = realFetch
    await rm(root, { recursive: true, force: true })
  }
}

export default runAccountQuotaTests

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0
  let passed = 0
  const ok = (cond, name) => {
    if (cond) passed++
    else {
      failed++
      console.error(`✗ ${name}`)
    }
  }
  await runAccountQuotaTests(ok)
  console.log(failed ? `✗ ${failed} 失败，${passed} 通过` : `✓ 账号额度：${passed} 项通过`)
  process.exit(failed ? 1 : 0)
}
