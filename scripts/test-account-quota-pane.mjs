import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const OUT = resolve('.tmp/fix-validation-20261015/account-quota-pane')

const resetAt = Date.now() + 3_600_000

const CMD_WINDOWS = [
  { id: 'fiveHour', label: '5 小时', used: 0.7, total: 14, resetAt, exceeded: false },
  { id: 'weekly', label: '每周', used: 1.6, total: 35, resetAt, exceeded: false },
  { id: 'monthly', label: '本月', used: 1.6, total: 70, resetAt, exceeded: false, estimated: true }
]

const ccProviderQuota = (over = {}) => ({
  provider: 'commandcode',
  supported: true,
  used: 1.6,
  total: 70,
  currency: 'USD',
  label: '本月已用',
  windows: CMD_WINDOWS,
  checkedAt: 1_700_000_000_000,
  ...over
})

const ccCard = (over = {}) => ({
  key: 'yan:commandcode',
  source: 'yan',
  provider: 'commandcode',
  name: 'Command Code',
  status: 'ok',
  windows: CMD_WINDOWS,
  checkedAt: 1_700_000_000_000,
  ...over
})

const MAIN_STUBS = {
  electron: `export const net = { fetch: (...args) => globalThis.__acctScenario.fetch ? globalThis.__acctScenario.fetch(...args) : Promise.reject(new Error('test: no network')) }`,
  credentials: `
export const readAuthEntry = async (p) => globalThis.__acctScenario?.authEntry?.[p]
`,
  quota: `
export const providerQuota = async (p, budget, secret) => globalThis.__acctScenario.quota(p, budget, secret)
export const fetchCodexUsage = async (...args) => {
  if (globalThis.__acctScenario?.codexUsage) return globalThis.__acctScenario.codexUsage(...args)
  throw new Error('test: codex usage not stubbed')
}
`,
  'oauth-accounts': `export const oauthAccountTargets = async (provider) => globalThis.__acctScenario?.oauthTargets?.[provider] ?? []`,
  'codex-accounts': `
export const codexAccountTargets = async () => globalThis.__acctScenario?.codexTargets ?? []
export const switchCodexAccount = async () => ({ ok: false, error: 'test: not stubbed' })
`
}

async function loadAccountQuotaMain() {
  const outfile = join(OUT, 'account-quota-main.mjs')
  await build({
    entryPoints: ['src/main/account-quota.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'account-quota-main-stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'acct-main-stub' }))
        b.onResolve({ filter: /^\.\/credentials$/ }, () => ({ path: 'credentials', namespace: 'acct-main-stub' }))
        b.onResolve({ filter: /^\.\/quota$/ }, () => ({ path: 'quota', namespace: 'acct-main-stub' }))
        b.onResolve({ filter: /^\.\/codex-accounts$/ }, () => ({ path: 'codex-accounts', namespace: 'acct-main-stub' }))
        b.onResolve({ filter: /^\.\/oauth-accounts$/ }, () => ({ path: 'oauth-accounts', namespace: 'acct-main-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'acct-main-stub' }, (args) => ({ contents: MAIN_STUBS[args.path], loader: 'js' }))
      }
    }]
  })
  return import(pathToFileURL(outfile).href)
}

async function runMainReportScenarios(check, main, piDir) {
  const setScenario = (scenario) => { globalThis.__acctScenario = scenario }
  const modelsFile = join(piDir, 'models.json')
  await mkdir(piDir, { recursive: true })
  try {
    setScenario({
      authEntry: { commandcode: { type: 'api_key', key: 'user_test_key' } },
      quota: async (p) => (p === 'commandcode' ? ccProviderQuota() : { provider: p, supported: false, error: 'unsupported' })
    })
    let r = await main.accountQuotaReport()
    let cc = r.cards.find((c) => c.provider === 'commandcode')
    check(!!cc, '有 key → Command Code 卡出现')
    check(cc?.status === 'ok', '有 key → 卡片状态 ok')
    check(cc?.windows.map((w) => w.id).join(',') === 'fiveHour,weekly,monthly', '有 key → 5h / 周 / 月三个窗口')
    check(cc?.windows.find((w) => w.id === 'monthly')?.estimated === true, '月窗口标 estimated（推算，不是官方字段）')
    check(cc?.windows.filter((w) => w.id !== 'monthly').every((w) => !w.estimated), '官方 5h / 周窗口不标 estimated')

    setScenario({ authEntry: {}, quota: async () => { throw new Error('should not be called') } })
    r = await main.accountQuotaReport()
    check(!r.cards.some((c) => c.provider === 'commandcode'), '没有 key → 不生成 Command Code 卡')

    setScenario({ authEntry: { commandcode: { type: 'api_key', key: 'user_test_key' } }, quota: async () => { throw new Error('HTTP 429') } })
    r = await main.accountQuotaReport()
    cc = r.cards.find((c) => c.provider === 'commandcode')
    check(!!cc, '查询 reject → 卡片仍存在（不静默消失）')
    check(cc?.status === 'ok' && cc?.staleError === 'HTTP 429', '查询 reject 且有上次成功读数 → 保留旧读数并标出错误原因')
    check(cc?.windows.length === 3, '查询 reject 且有上次成功读数 → 沿用旧窗口')

    setScenario({
      authEntry: { commandcode: { type: 'api_key', key: 'different-account-key' } },
      quota: async (_provider, _budget, secret) => {
        check(secret === 'different-account-key', '换 key：查询绑定已解析的那份凭证，不二次读取其他账号的 key')
        throw new Error('new account offline')
      }
    })
    r = await main.accountQuotaReport()
    cc = r.cards.find((c) => c.provider === 'commandcode')
    check(cc?.status === 'error' && cc?.windows.length === 0 && !cc?.staleError, '换 key：不能把前一个账号的成功额度读数套给新账号')

    setScenario({
      authEntry: {
        commandcode: { type: 'api_key', key: 'user_test_key' },
        deepseek: { type: 'api_key', key: 'sk-test' }
      },
      quota: async (p) => p === 'commandcode'
        ? ccProviderQuota()
        : p === 'deepseek'
          ? { provider: 'deepseek', supported: true, remaining: 12.5, currency: 'CNY', checkedAt: 1 }
          : { provider: p, supported: false, error: 'unsupported' }
    })
    r = await main.accountQuotaReport()
    const byProvider = new Map(r.cards.map((c) => [c.provider, c]))
    check(byProvider.get('commandcode')?.windows.length === 3 && !byProvider.get('commandcode')?.balance, 'commandcode 卡只带自己的窗口')
    check(byProvider.get('deepseek')?.balance?.amount === 12.5 && byProvider.get('deepseek')?.windows.length === 0, 'deepseek 卡只带自己的余额，不串 commandcode 窗口')

    await writeFile(modelsFile, JSON.stringify({
      providers: { commandcode: { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_models_only' } }
    }))
    setScenario({ authEntry: {}, quota: async (p) => (p === 'commandcode' ? ccProviderQuota() : { provider: p, supported: false, error: 'unsupported' }) })
    r = await main.accountQuotaReport()
    cc = r.cards.find((c) => c.provider === 'commandcode')
    check(!!cc, 'models.json-only 官方 key → Command Code 卡出现（此前会整张消失）')
    check(cc?.status === 'ok' && cc?.windows.length === 3, 'models.json-only 官方 key → 拿到三窗口')

    await writeFile(modelsFile, '\uFEFF{\n// configuration accepted by pi\n"providers": {"commandcode": {"baseUrl": "https://api.commandcode.ai/provider/v1", /* key */ "apiKey": "user_jsonc"}}\n}')
    setScenario({ authEntry: {}, quota: async (p, _budget, secret) => {
      check(secret === 'user_jsonc', 'JSONC/BOM 配置只使用自身凭据')
      return ccProviderQuota()
    } })
    r = await main.accountQuotaReport()
    check(r.cards.some((c) => c.provider === 'commandcode' && c.status === 'ok' && c.windows.length === 3), 'JSONC/BOM 配置不再错误显示没有账号')

    for (const [label, entry] of [
      ['代理域', { baseUrl: 'https://api.commandcode.ai.evil.test/v1', apiKey: 'user_proxy_key' }],
      ['非 https', { baseUrl: 'http://api.commandcode.ai/provider/v1', apiKey: 'user_http_key' }],
      ['命令型', { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: '!echo secret' }],
      ['缺少 baseUrl', { apiKey: 'user_no_base_key' }],
      ['per-model 代理', { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_mixed_key', models: [{ id: 'cc', baseUrl: 'https://api.commandcode.ai.evil.test/v1' }] }]
    ]) {
      await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: entry } }))
      setScenario({ authEntry: {}, quota: async () => { throw new Error('should not be called') } })
      r = await main.accountQuotaReport()
      check(r.cards.some((c) => c.provider === 'commandcode' && c.status === 'error' && !c.windows.length), `models.json ${label} → 显示配置错误，不取 key 或查询额度`)
    }

    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai.evil.test/v1', apiKey: 'user_proxy_key' } } }))
    const priorKey = process.env.COMMANDCODE_API_KEY
    process.env.COMMANDCODE_API_KEY = 'user_env_sentinel'
    try {
      setScenario({
        authEntry: { commandcode: { type: 'api_key', key: 'user_auth_sentinel' } },
        quota: async () => { throw new Error('should not be called') }
      })
      r = await main.accountQuotaReport()
      check(r.cards.some((c) => c.provider === 'commandcode' && c.status === 'error' && !c.windows.length), '代理条目 + auth/env key → 显示配置错误，不发送凭据')
    } finally {
      if (priorKey === undefined) delete process.env.COMMANDCODE_API_KEY
      else process.env.COMMANDCODE_API_KEY = priorKey
    }
    await rm(modelsFile, { force: true })

    setScenario({
      authEntry: {},
      oauthTargets: { anthropic: [
        { key: 'claude-a', email: 'a@example.com', active: true, credential: { access: 'a', expires: Date.now() + 10000 } },
        { key: 'claude-b', email: 'b@example.com', active: false, credential: { access: 'b', expires: Date.now() + 10000 } }
      ] },
      fetch: async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 20, resets_at: new Date(Date.now() + 10000).toISOString() } }) })
    })
    r = await main.accountQuotaReport()
    check(r.cards.length === 2 && r.cards.every((c) => c.provider === 'anthropic' && c.switchable), 'Claude：每个已保存账号独立读取额度，允许切换')
    check(r.cards.find((c) => c.key === 'claude-a')?.active && !r.cards.find((c) => c.key === 'claude-b')?.active, 'Claude：当前与备用账号状态不混淆')

    let claudeCalls = 0
    setScenario({
      authEntry: {},
      oauthTargets: { anthropic: [{ key: 'claude-429', email: 'r@example.com', active: true, credential: { access: 'r', expires: Date.now() + 10000 } }] },
      fetch: async (url, init) => {
        claudeCalls++
        check(/^claude-cli\/\S+ \(external, cli\)$/.test(init.headers['User-Agent'] ?? ''), 'Claude：带 Claude Code 格式的 User-Agent，避免 429 并拿到重置卡')
        return { ok: false, status: 429, headers: { get: (name) => (name === 'retry-after' ? '120' : null) }, json: async () => ({}) }
      }
    })
    r = await main.accountQuotaReport()
    check(r.cards[0]?.status === 'error' && /429/.test(r.cards[0]?.error ?? ''), 'Claude 429：卡片说明太频繁')
    await main.accountQuotaReport()
    check(claudeCalls === 1, 'Claude 429：退避期间不再请求')

    setScenario({
      authEntry: { openrouter: { type: 'oauth', access: 'or-oauth' } },
      oauthTargets: { openrouter: [{ key: 'or-account', label: '个人', active: true, credential: { access: 'or-oauth' } }] },
      fetch: async (_url, init) => {
        check(init.headers.Authorization === 'Bearer or-oauth', 'OpenRouter：使用该账号自己的凭证查余额')
        return { ok: true, json: async () => ({ data: { total_credits: 20, total_usage: 5 } }) }
      },
      quota: async () => { throw new Error('duplicate key query') }
    })
    r = await main.accountQuotaReport()
    check(r.cards.length === 1 && r.cards[0].key === 'or-account' && r.cards[0].balance.amount === 15, 'OpenRouter：订阅登录与通用 key 卡片不会重复展示当前凭证')

    const soon = new Date(Date.now() + 86_400_000).toISOString()
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const posts = []
    setScenario({
      authEntry: {},
      codexTargets: [{ key: 'cx-a', email: 'x@example.com', active: true, credential: { access: 'cx-token', accountId: 'acct-1' } }],
      codexUsage: async () => ({ plan: 'plus', windows: [{ id: 'primary', label: '五小时', used: 10, total: 100 }], limited: false }),
      fetch: async (url, init = {}) => {
        if (String(url).endsWith('/rate-limit-reset-credits')) {
          check(init.headers['Chatgpt-Account-Id'] === 'acct-1', 'Codex 重置卡：带该账号自己的 account id')
          return { ok: true, status: 200, json: async () => ({ credits: [
            { id: 'c-late', status: 'available', reset_type: 'codex_rate_limits', expires_at: later },
            { id: 'c-soon', status: 'available', reset_type: 'codex_rate_limits', expires_at: soon },
            { id: 'c-used', status: 'redeemed', reset_type: 'codex_rate_limits', expires_at: later },
            { id: 'c-old', status: 'available', reset_type: 'codex_rate_limits', expires_at: new Date(Date.now() - 1000).toISOString() }
          ] }) }
        }
        if (String(url).endsWith('/rate-limit-reset-credits/consume')) {
          posts.push(JSON.parse(init.body))
          return { ok: true, status: 200, json: async () => ({ code: 'reset' }) }
        }
        throw new Error(`unexpected ${url}`)
      },
      quota: async (p) => ({ provider: p, supported: false })
    })
    r = await main.accountQuotaReport()
    const cx = r.cards.find((c) => c.key === 'cx-a')
    check(cx?.resetCredits?.count === 2, 'Codex 重置卡：只算可用且未过期的卡')
    check(cx?.resetCredits?.nextId === 'c-soon' && cx?.resetCredits?.nextExpiresAt === Date.parse(soon), 'Codex 重置卡：先用最早过期的一张')
    const used = await main.consumeResetCredit('openai-codex', 'cx-a', 'c-soon')
    check(used.ok && used.outcome === 'reset', 'Codex 重置卡：使用后返回结果')
    check(posts[0]?.credit_id === 'c-soon' && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(posts[0]?.redeem_request_id ?? ''), 'Codex 重置卡：带稳定的幂等请求号')
    await main.consumeResetCredit('openai-codex', 'cx-a', 'c-soon')
    check(posts[1]?.redeem_request_id === posts[0]?.redeem_request_id, 'Codex 重置卡：重试同一张卡复用请求号，不会重复扣')
    check((await main.consumeResetCredit('deepseek', 'x', 'y')).ok === false, '重置卡：不支持的账号不发请求')

    const deferred = () => {
      let resolve
      const promise = new Promise((done) => { resolve = done })
      return { promise, resolve }
    }
    const responses = [deferred(), deferred()]
    const starts = [deferred(), deferred()]
    let request = 0
    setScenario({
      authEntry: { commandcode: { type: 'api_key', key: 'user_test_key' } },
      quota: (p) => {
        if (p !== 'commandcode') return Promise.resolve({ provider: p, supported: false })
        const index = request++
        starts[index].resolve()
        return responses[index].promise
      }
    })
    const oldReport = main.accountQuotaReport()
    await starts[0].promise
    check(main.accountQuotaReport() === oldReport, '刷新：同一批额度查询复用进行中的请求')
    main.invalidateAccountQuotaReport()
    const newReport = main.accountQuotaReport()
    await starts[1].promise
    check(newReport !== oldReport, '刷新：账号变更后不复用变更前的额度查询')
    responses[0].resolve(ccProviderQuota())
    await oldReport
    check(main.accountQuotaReport() === newReport, '刷新：旧查询结束不会清掉新账号正在进行的查询')
    responses[1].resolve(ccProviderQuota({ windows: [{ id: 'fiveHour', label: '5 小时', used: 2, total: 14 }] }))
    const updated = await newReport
    check(updated.cards.find((c) => c.provider === 'commandcode')?.windows[0].used === 2, '刷新：账号变更后的请求返回新读数')
  } finally {
    delete globalThis.__acctScenario
  }
}

export async function runAccountQuotaPaneTests(ok) {
  const check = typeof ok === 'function'
    ? ok
    : (cond, label, extra = '') => { if (!cond) throw new Error(`账号额度磁贴：${label}${extra ? ' ' + extra : ''}`) }

  await mkdir(OUT, { recursive: true })

  const iso = await mkdtemp(join(tmpdir(), 'yan-acct-pane-'))
  const priorData = process.env.YAN_DATA_DIR
  const priorPi = process.env.YAN_PI_DIR
  const quotaEnv = ['COMMANDCODE_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
  const priorQuotaEnv = new Map(quotaEnv.map((name) => [name, process.env[name]]))
  for (const name of quotaEnv) delete process.env[name]
  process.env.YAN_DATA_DIR = iso
  process.env.YAN_PI_DIR = join(iso, 'pi')

  try {
    await build({ entryPoints: ['src/shared/account-quota.ts'], outfile: join(OUT, 'account-quota-shared.mjs'), bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
    const shared = await import(pathToFileURL(join(OUT, 'account-quota-shared.mjs')).href)
    {
    const d = { key: 'yan:deepseek', source: 'yan', provider: 'deepseek', name: 'DeepSeek', status: 'ok', windows: [], checkedAt: 0 }
    const ordered = shared.orderAccountCardsForProvider([d, ccCard(), { ...ccCard(), key: 'yan:openrouter', provider: 'openrouter' }], 'commandcode')
    check(ordered[0].provider === 'commandcode', '选择器：当前 provider 提到首位')
    check(ordered.slice(1).map((c) => c.provider).join(',') === 'deepseek,openrouter', '选择器：其余保持原有相对顺序（稳定）')
    const none = shared.orderAccountCardsForProvider([d], 'commandcode')
    check(none.length === 1 && none[0].provider === 'deepseek', '选择器：没有对应卡时不新建卡、顺序不变')
    check(shared.orderAccountCardsForProvider([d, ccCard()], '').map((c) => c.provider).join(',') === 'deepseek,commandcode', '选择器：没有当前 provider 时顺序不变')
    check(shared.orderAccountCardsForProvider([d, ccCard()], 'COMMANDCODE')[0].provider === 'commandcode', '选择器：provider 大小写不敏感')
    check(!shared.orderAccountCardsForProvider([d], 'unsupported').some((c) => c.provider === 'unsupported'), '选择器：未知 / 不支持的 provider 不伪造卡')
  }

  {
    const now = Date.now()
    const future = new Date(now + 3_600_000).toISOString()
    const claude = shared.claudeResetCredits({ eligible: true, next_grant_id: 'g1', grants: [
      { id: 'g1', resets_left: 2, ends_at: future, usable_now: true },
      { id: 'g2', resets_left: 1, usable_now: true },
      { id: 'g3', resets_left: 5, paused: true, usable_now: true },
      { id: 'BAD ID', resets_left: 9, usable_now: true }
    ] }, now)
    check(claude?.count === 8 && claude?.groups[0].nextId === 'g1' && claude?.groups[0].nextExpiresAt === Date.parse(future), 'Claude 重置卡：保留持有次数，暂停卡不作为使用目标，非法编号跳过')
    check(shared.claudeResetCredits({ eligible: false, grants: [] }, now) === undefined, 'Claude 重置卡：不符合资格时不显示')
    check(shared.claudeResetCredits({ eligible: true, next_grant_id: 'gone', grants: [{ id: 'g1', resets_left: 1, usable_now: true }] }, now)?.count === 1, 'Claude 重置卡：没有全局下一张时仍显示持有次数')
  }

  const main = await loadAccountQuotaMain()
  await runMainReportScenarios(check, main, join(iso, 'pi'))
} finally {
    await rm(iso, { recursive: true, force: true }).catch(() => undefined)
    if (priorData === undefined) delete process.env.YAN_DATA_DIR; else process.env.YAN_DATA_DIR = priorData
    if (priorPi === undefined) delete process.env.YAN_PI_DIR; else process.env.YAN_PI_DIR = priorPi
    for (const [name, value] of priorQuotaEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  let failed = 0
  const ok = (cond, label, extra = '') => {
    if (cond) console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`)
    else { failed++; console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`) }
  }
  try {
    await runAccountQuotaPaneTests(ok)
    console.log(failed ? `\n✗ 账号额度磁贴：失败 ${failed} 项` : '\n✓ 账号额度磁贴：全部通过')
    if (failed) process.exitCode = 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
