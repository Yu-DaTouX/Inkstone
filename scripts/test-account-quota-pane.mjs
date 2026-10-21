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
  electron: `export const net = { fetch: async () => { throw new Error('test: no network') } }`,
  credentials: `
export const readAuthEntry = async (p) => globalThis.__acctScenario?.authEntry?.[p]
`,
  quota: `
export const providerQuota = async (p, budget) => globalThis.__acctScenario.quota(p, budget)
export const fetchCodexUsage = async () => { throw new Error('test: codex usage not stubbed') }
`,
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
      check(!r.cards.some((c) => c.provider === 'commandcode'), `models.json ${label} → 不产 Command Code 卡，也不取 key`)
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
      check(!r.cards.some((c) => c.provider === 'commandcode'), '代理条目 + auth/env key → 不产 Command Code 卡')
    } finally {
      if (priorKey === undefined) delete process.env.COMMANDCODE_API_KEY
      else process.env.COMMANDCODE_API_KEY = priorKey
    }
    await rm(modelsFile, { force: true })
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

  const main = await loadAccountQuotaMain()
  await runMainReportScenarios(check, main, join(iso, 'pi'))
} finally {
    await rm(iso, { recursive: true, force: true }).catch(() => undefined)
    if (priorData === undefined) delete process.env.YAN_DATA_DIR; else process.env.YAN_DATA_DIR = priorData
    if (priorPi === undefined) delete process.env.YAN_PI_DIR; else process.env.YAN_PI_DIR = priorPi
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
