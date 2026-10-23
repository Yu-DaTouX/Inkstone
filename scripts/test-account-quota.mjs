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

async function runCodexAuthIpcTests(ok, build) {
  const names = [
    'getSettings', 'resolvePi', 'discoverCustomProviderModels', 'listCustomProviders', 'removeCustomProvider',
    'saveCustomProvider', 'testCustomProviderBillable', 'testCustomProviderEndpoint', 'authFileInfo', 'clearAuth',
    'listAuthProviders', 'setApiKey', 'addApiKey', 'clearApiKeys', 'listApiKeyPools', 'removeApiKey', 'renameApiKey',
    'switchApiKey', 'detectToolchain', 'detectLocalModelServers', 'cancelCodexLogin', 'startCodexLogin',
    'answerOAuthPrompt', 'cancelOAuthLogin', 'startOAuthLogin', 'accountQuotaReport', 'invalidateAccountQuotaReport',
    'captureActiveCodexAccount', 'clearCodexAccounts', 'listCodexAccounts', 'removeCodexAccount', 'switchCodexAccount',
    'captureActiveApiKey', 'captureActiveOAuthAccount', 'clearOAuthAccounts', 'listOAuthAccounts', 'removeOAuthAccount',
    'renameOAuthAccount', 'switchOAuthAccount'
  ]
  await build({
    entryPoints: ['src/main/ipc/auth-ipc.ts'], outfile: 'out/test/codex-auth-ipc.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'auth-deps-stub', setup(b) {
      b.onResolve({ filter: /^\.\.\// }, (args) => args.importer.replaceAll('\\', '/').endsWith('/ipc/auth-ipc.ts') && !args.path.endsWith('/shared/oauth-accounts') ? { path: 'deps', namespace: 'stub' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: names.map((name) => `export const ${name} = (...args) => {
        const state = globalThis.__codexIpcTest;
        state.calls.push([${JSON.stringify(name)}, ...args]);
        const result = state.results[${JSON.stringify(name)}];
        return typeof result === 'function' ? result(...args) : result ?? { ok: true };
      };`).join('\n') }))
    } }]
  })
  const { registerAuthIpc } = await import(pathToFileURL(join(process.cwd(), 'out/test/codex-auth-ipc.mjs')).href + `?t=${Date.now()}`)
  const handlers = new Map()
  const state = { calls: [], results: {} }
  const previous = globalThis.__codexIpcTest
  globalThis.__codexIpcTest = state
  const reset = (results = {}) => { state.calls = []; state.results = { getSettings: {}, resolvePi: { args: ['fixture.js'] }, ...results } }
  const called = (name) => state.calls.filter((entry) => entry[0] === name)
  registerAuthIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    restartAgent: async (reason) => { state.calls.push(['restartAgent', reason]) }, sendOAuthEvent: () => {}
  })
  try {
    const views = [{ key: 'chatgpt:a:u', email: 'a@example.com', active: true }]
    reset({ listCodexAccounts: views })
    ok(await handlers.get('yan:codexAccounts')() === views, 'IPC：账号管理读取安全账号列表')

    reset()
    let r = await handlers.get('yan:clearAuth')('openai-codex')
    ok(r.ok && called('clearCodexAccounts').length === 1 && called('clearAuth').length === 0, 'IPC：移除 ChatGPT 服务走账号池清理，不只删除当前登录')
    ok(called('invalidateAccountQuotaReport').length === 1 && called('restartAgent').length === 1, 'IPC：移除登录后失效额度查询并刷新运行实例')
    reset({ clearCodexAccounts: { ok: false, error: 'blocked' } })
    r = await handlers.get('yan:clearAuth')('openai-codex')
    ok(!r.ok && called('restartAgent').length === 0, 'IPC：清理失败不假报成功、不刷新运行实例')
    reset()
    await handlers.get('yan:clearAuth')('deepseek')
    ok(called('clearAuth')[0]?.[1] === 'deepseek' && called('clearApiKeys')[0]?.[1] === 'deepseek', 'IPC：其他服务的原有移除流程不变')

    reset()
    r = await handlers.get('yan:codexAccountSwitch')('chatgpt:a:u')
    ok(r.ok && called('switchCodexAccount')[0]?.[1] === 'chatgpt:a:u' && called('restartAgent').length === 1 && called('invalidateAccountQuotaReport').length === 1, 'IPC：切换账号后刷新凭证与额度，不只改磁盘文件')
    reset({ switchCodexAccount: { ok: false, error: 'missing' } })
    await handlers.get('yan:codexAccountSwitch')('missing')
    ok(called('restartAgent').length === 0 && called('invalidateAccountQuotaReport').length === 0, 'IPC：切换失败不影响当前运行实例')

    reset({ removeCodexAccount: { ok: true, wasActive: false } })
    await handlers.get('yan:codexAccountRemove')('old')
    ok(called('invalidateAccountQuotaReport').length === 1 && called('restartAgent').length === 0, 'IPC：删除旧账号只刷新额度，不打扰当前登录')
    reset({ removeCodexAccount: { ok: true, wasActive: true } })
    await handlers.get('yan:codexAccountRemove')('current')
    ok(called('restartAgent').length === 1, 'IPC：删除当前账号后刷新凭证')

    reset({ captureActiveCodexAccount: () => { throw new Error('store broken') } })
    r = await handlers.get('yan:codexLogin')()
    ok(!r.ok && called('startCodexLogin').length === 0, 'IPC：无法保留旧账号时拒绝开始新登录')
    reset()
    r = await handlers.get('yan:codexLogin')()
    ok(r.ok && called('captureActiveCodexAccount').length === 2 && called('restartAgent').length === 1, 'IPC：添加账号前后都保存登录，成功后刷新凭证')
    let captures = 0
    reset({ captureActiveCodexAccount: () => { if (++captures === 2) throw new Error('write blocked') } })
    r = await handlers.get('yan:codexLogin')()
    ok(!r.ok && /已登录.*保存账号列表失败/.test(r.error), 'IPC：登录后保存列表失败会明确提示，不静默吞掉')

    for (const provider of ['anthropic', 'github-copilot', 'xai', 'openrouter']) {
      reset()
      r = await handlers.get('yan:oauthLogin')(provider)
      ok(r.ok && called('captureActiveApiKey').length === 1 && called('captureActiveOAuthAccount').length === 2, `IPC：${provider} 添加登录前保留现有 key 和订阅账号，登录后再入库`)
      reset({ captureActiveApiKey: { ok: false, error: 'key store broken' } })
      r = await handlers.get('yan:oauthLogin')(provider)
      ok(!r.ok && called('startOAuthLogin').length === 0, `IPC：${provider} 无法保留旧 key 时不覆盖它`)
      reset()
      r = await handlers.get('yan:oauthAccountSwitch')(provider, 'backup')
      ok(r.ok && called('captureActiveApiKey').length === 1 && called('switchOAuthAccount')[0]?.[2] === 'backup', `IPC：${provider} 换号前也保留当前 API key`)
      reset()
      await handlers.get('yan:clearAuth')(provider)
      ok(called('clearOAuthAccounts').length === 1 && called('clearApiKeys').length === 1, `IPC：${provider} 整体移除会清理两个保存池`)
    }
    const protectedCredential = { type: 'oauth', access: 'protected', refresh: 'r', expires: 1 }
    reset({ captureActiveOAuthAccount: { key: 'saved', credential: protectedCredential } })
    await handlers.get('yan:addApiKey')('anthropic', 'new-key', 'API')
    ok(called('addApiKey')[0]?.[4] === protectedCredential, 'IPC：添加 key 的覆盖许可只绑定已保存的那份 OAuth 凭证')
    reset({ captureActiveOAuthAccount: () => { throw new Error('broken') } })
    let blocked = false
    try { await handlers.get('yan:switchApiKey')('anthropic', 'key') } catch { blocked = true }
    ok(blocked && called('switchApiKey').length === 0, 'IPC：无法安全保存 OAuth 时不执行 key 切换')
    reset({ clearApiKeys: { ok: false, error: 'cannot clear saved keys' } })
    r = await handlers.get('yan:clearAuth')('xai')
    ok(!r.ok && called('restartAgent').length === 1, 'IPC：登录槽已清理但 key 池清理失败时如实报错，并刷新已变化的运行状态')
    reset({ removeApiKey: { ok: true, wasActive: true } })
    await handlers.get('yan:removeApiKey')('openai', 'key')
    ok(called('restartAgent').length === 1 && called('invalidateAccountQuotaReport').length === 1, 'IPC：删除当前 API key 后刷新运行实例与额度')
  } finally {
    if (previous === undefined) delete globalThis.__codexIpcTest
    else globalThis.__codexIpcTest = previous
  }
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
    ok(!JSON.stringify(list).includes(A1.access) && !JSON.stringify(list).includes(A1.refresh), '列表：只向界面返回账号信息，不返回令牌')
    ok((await m.listCodexAccounts()).length === 1, '重复登录：同一账号不会新增条目')

    const initialStore = JSON.parse(await readFile(storeFile, 'utf8'))
    initialStore.accounts.push({ ...initialStore.accounts[0], key: 'chatgpt:acct-a:legacy-user' })
    const sparse = {
      ...A1,
      access: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-a' }, 'https://api.openai.com/profile': { email: 'A@EXAMPLE.COM' } }),
      expires: A1.expires - 1000,
      refresh: 'old-sparse-refresh'
    }
    initialStore.accounts.push({ key: 'chatgpt:acct-a:A@EXAMPLE.COM', email: 'A@EXAMPLE.COM', credential: sparse, savedAt: 0 })
    await writeFile(storeFile, JSON.stringify(initialStore))
    list = await m.listCodexAccounts()
    ok(list.length === 1 && list[0].key === 'chatgpt:acct-a:user-a' && list[0].active, '迁移：旧 key、缺用户 ID 和邮箱大小写差异不会把同一账号显示多次')
    ok((await m.codexAccountTargets()).length === 1, '额度：旧账号重复记录也只生成一个查询目标')

    const freshSparse = { ...sparse, expires: A1.expires + 5000, refresh: 'new-sparse-refresh' }
    await writeAuth({ 'openai-codex': freshSparse, deepseek: { type: 'api_key', key: 'sk-test' } })
    const sparseList = await m.listCodexAccounts()
    list = await m.listCodexAccounts()
    ok(list.length === 1 && list[0].active && list[0].key === sparseList[0].key, '兼容：新令牌暂缺用户 ID 时，列表 key 不会在两次读取之间跳变')
    await writeFile(storeFile, JSON.stringify(initialStore))

    const rotated = { ...A1, refresh: 'refresh-a-rotated' }
    await writeAuth({ 'openai-codex': rotated, deepseek: { type: 'api_key', key: 'sk-test' } })
    await m.captureActiveCodexAccount()
    ok(JSON.parse(await readFile(storeFile, 'utf8')).accounts[0].credential.refresh === rotated.refresh, '轮换：access 不变但 refresh 改变时也保存新令牌')
    await writeAuth({ 'openai-codex': A1, deepseek: { type: 'api_key', key: 'sk-test' } })
    await m.captureActiveCodexAccount()

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
    ok(!(await m.removeCodexAccount('chatgpt:missing:x')).ok && (await m.listCodexAccounts()).length === 1, '移除：过时或不存在的账号请求报错，不影响其他账号')
    r = await m.removeCodexAccount('chatgpt:acct-b:user-b')
    ok(r.ok && !r.wasActive && (await m.listCodexAccounts()).length === 0, '移除：可以单独删除未激活的旧账号')

    await writeAuth({ 'openai-codex': A1, deepseek: { type: 'api_key', key: 'sk-test' } })
    await m.captureActiveCodexAccount()
    await writeAuth({ 'openai-codex': B1, deepseek: { type: 'api_key', key: 'sk-test' } })
    await m.captureActiveCodexAccount()
    r = await m.clearCodexAccounts()
    auth = await readAuth()
    ok(r.ok && !auth['openai-codex'] && auth.deepseek?.key === 'sk-test', '服务移除：退出 ChatGPT，不动其他服务凭证')
    ok((await m.listCodexAccounts()).length === 0 && (await m.codexAccountTargets()).length === 0, '服务移除：同时清空账号列表和额度查询目标，不会重新出现残留账号')
    await writeAuth({ 'openai-codex': A1, deepseek: { type: 'api_key', key: 'sk-test' } })
    list = await m.listCodexAccounts()
    ok(list.length === 1 && list[0].active, '重新登录：移除全部后再登录一次，只显示一个账号')

    const teammate = credential({ account: 'acct-a', user: 'other-user', email: 'other@example.com' })
    await writeAuth({ 'openai-codex': teammate, deepseek: { type: 'api_key', key: 'sk-test' } })
    list = await m.listCodexAccounts()
    ok(list.length === 2 && list.filter((x) => x.active).length === 1, '去重边界：同工作区不同用户仍是两个账号')
    ok((await m.removeCodexAccount('chatgpt:acct-a:user-a')).ok && (await readAuth())['openai-codex'].access === teammate.access, '移除边界：删除同工作区另一用户不会退出当前用户')

    await m.clearCodexAccounts()
    await writeAuth({ 'openai-codex': A1, deepseek: { type: 'api_key', key: 'sk-test' } })
    await m.captureActiveCodexAccount()
    const refreshStore = JSON.parse(await readFile(storeFile, 'utf8'))
    refreshStore.accounts.push({
      key: 'chatgpt:acct-b:b@example.com', email: 'b@example.com', savedAt: 0,
      credential: { ...B1, expires: 0, access: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-b' }, 'https://api.openai.com/profile': { email: 'b@example.com' } }) }
    })
    await writeFile(storeFile, JSON.stringify(refreshStore))
    const refreshedTargets = await m.codexAccountTargets()
    const refreshedTarget = refreshedTargets.find((x) => !x.active)
    ok(refreshedTarget?.key === 'chatgpt:acct-b:user-b', '令牌刷新：补齐用户 ID 后同步更新额度卡片的账号 key')
    ok((await m.switchCodexAccount(refreshedTarget.key)).ok && (await readAuth())['openai-codex'].accountId === 'acct-b', '令牌刷新：额度卡片的新 key 可以直接用于切换账号')
    await writeAuth({ 'openai-codex': teammate, deepseek: { type: 'api_key', key: 'sk-test' } })

    await writeFile(storeFile, '{ not json')
    let rejected = null
    try { await m.listCodexAccounts() } catch (error) { rejected = error }
    ok(!!rejected && /格式无效/.test(rejected.message), '损坏：读取时明确报错，不默默清空账号')
    for (let i = 0; i < 3; i += 1) await m.listCodexAccounts().catch(() => undefined)
    const backups = (await readdir(dataDir)).filter((name) => name.startsWith('codex-accounts.json.corrupt'))
    ok(backups.length === 1 && backups[0] === 'codex-accounts.json.corrupt.bak', '损坏：反复读取只留一份固定名的备份')
    const switched = await m.switchCodexAccount('chatgpt:acct-b:user-b')
    ok(switched.ok === false && typeof switched.error === 'string' && /格式无效/.test(switched.error), '损坏：切换账号返回 ok:false 而不是 reject')
    ok(!(await m.removeCodexAccount('chatgpt:acct-a:other-user')).ok, '损坏：删除账号返回失败，不静默丢弃列表')
    ok(!(await m.clearCodexAccounts()).ok && (await readAuth())['openai-codex'].access === teammate.access, '损坏：清除服务不会先退出当前账号再报列表错误')
  } finally {
    globalThis.fetch = realFetch
    await rm(root, { recursive: true, force: true })
  }
  await runCodexAuthIpcTests(ok, build)
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
