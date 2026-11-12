import { runSuite } from './lib/test-suite.mjs'
import { claudeQuotaFixture } from './fixtures/claude-quota.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { claudeUsageWindows, claudeResetCredits } = await compile('src/shared/account-quota.ts')
  const now = Date.UTC(2026, 10, 11, 12)
  const payload = claudeQuotaFixture(now)
  const windows = claudeUsageWindows(payload)
  const fable = windows.find((window) => window.label === 'Fable')
  ok(windows.length === 3, '会话、全模型周额度和 Fable 独立显示')
  ok(fable?.used === 99 && fable.total === 100, 'limits.percent 已是百分比，不重复乘百')
  ok(fable?.durationMs === 7 * 86_400_000 && fable.resetAt === Date.parse(payload.limits[0].resets_at), 'Fable 使用自身重置时间和周周期')
  ok(!fable?.informational, '模型周限额不是仅供参考的未知窗口')
  const scoped = (limit) => claudeUsageWindows({ limits: [limit] })
  ok(scoped({ ...payload.limits[0], percent: 100 })[0]?.exceeded === true, 'Fable 用满标记超限')
  ok(scoped({ ...payload.limits[0], percent: 0 })[0]?.used === 0, 'Fable 零用量仍显示')
  ok(scoped({ ...payload.limits[0], resets_at: 'bad' })[0]?.resetAt === undefined, '坏重置时间不编日期')
  for (const raw of [null, [], { ...payload.limits[0], percent: '99' }, { ...payload.limits[0], percent: NaN }, { ...payload.limits[0], scope: {} }, { ...payload.limits[0], kind: 'unknown' }]) {
    ok(scoped(raw).length === 0, '忽略没有有效百分比或模型作用域的条目')
  }
  ok(claudeUsageWindows({ limits: [...payload.limits, ...payload.limits] }).length === 1, '重复模型窗口不重复渲染')
  const read = (grants, extra = {}) => claudeResetCredits({ ...payload.cedar_ember, grants, ...extra }, now)
  const all = read(payload.cedar_ember.grants)
  ok(all.count === 3 && all.groups.length === 2, 'Fable 与普通卡分别归组，次数不混')
  ok(all.groups[0].kind === 'fable' && all.groups[0].count === 1 && all.groups[0].nextId === 'fable-grant', 'Fable 选择自己的 grant，不被全局 next_grant_id 替换')
  ok(all.groups[1].kind === 'full' && all.groups[1].count === 2 && all.groups[1].nextId === 'normal-grant', '普通卡有独立次数和使用目标')
  ok(all.groups[0].clears.join() === 'seven_day_overage_included', '保留所选卡的重置范围')
  const normal = payload.cedar_ember.grants[0]
  for (const change of [{ usable_now: false }, { paused: true }, { starts_at: new Date(now + 1000).toISOString() }, { blocking: ['five_hour'] }]) {
    const held = read([{ ...normal, ...change }])
    ok(held.count === 2 && !held.groups[0].nextId, '持有但当前不可用：仍显示次数，不给使用目标')
  }
  const cooling = read([normal], { cooldown_until: new Date(now + 1000).toISOString() })
  ok(cooling.count === 2 && !cooling.groups[0].nextId, '冷却中的卡不隐藏也不可使用')
  ok(read([normal], { next_grant_id: null }).groups[0].nextId === normal.id, '未提供全局下一张时按该类可用卡选择')
  for (const change of [{ id: 'BAD ID' }, { resets_left: '2' }, { resets_left: null }, { resets_left: -1 }, { resets_left: 0 }, { resets_left: 0.5 }, { ends_at: new Date(now - 1).toISOString() }, { ends_at: 'bad' }]) {
    ok(read([{ ...normal, ...change }]).count === 0, '过期、耗尽或畸形 grant 不生成可用库存')
  }
  ok(read([{ ...normal, ends_at: null }]).count === 2, '无到期时间不当作过期')
  ok(read([normal], { eligible: false }) === undefined, '不符合资格不伪造重置卡')
  const monthly = { id: 'full-reset-2611', resets_total: 1, resets_left: 1, starts_at: new Date(now - 1000).toISOString(), ends_at: new Date(now + 86_400_000).toISOString(), clears: ['five_hour', 'seven_day', 'seven_day_overage_included'], paused: false, usable_now: true, blocking: [], type: 'full', unavailable_reason: null, gives_back_weekly: false }
  const spentFable = { ...monthly, id: 'launch-2610-fable', resets_left: 0, usable_now: false, clears: ['five_hour', 'seven_day_overage_included'], unavailable_reason: 'unavailable', gives_back_weekly: true }
  const live = read([monthly, spentFable], { next_grant_id: 'full-reset-2611', cooldown_until: null })
  ok(live.count === 1 && live.groups.length === 1 && live.groups[0].kind === 'full' && live.groups[0].nextId === 'full-reset-2611', '实际返回形状：月度完整重置可用，已用完的 Fable 卡不显示', live)
  const earlier = { ...normal, id: 'earlier', ends_at: new Date(now + 1000).toISOString() }
  const ordered = read([normal, earlier], { next_grant_id: null })
  ok(ordered.groups[0].nextId === 'earlier', '同种卡优先最早到期，除非服务端指定下一张')
  ok(read([normal, earlier]).groups[0].nextId === normal.id, '保留同种卡内服务端的下一张顺序')
  const types = read([
    { ...normal, id: 'session', type: undefined, clears: ['five_hour'] },
    { ...normal, id: 'weekly', type: undefined, clears: ['seven_day'] }
  ])
  ok(types.groups.map((group) => group.kind).join() === 'session,weekly', '普通卡仍区分仅五小时和仅每周的作用范围')

  const requests = []
  const prior = globalThis.__claudeQuotaTest
  globalThis.__claudeQuotaTest = {
    account: { key: 'fixture-account', active: true, credential: { access: 'fixture-token', expires: Date.now() + 60_000 } },
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), ...init })
      const body = init.method === 'POST' ? { result: 'reset' }
        : String(url).endsWith('/profile') ? { organization: { uuid: 'fixture-org' } } : claudeQuotaFixture()
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  }
  try {
    const stubs = {
      electron: 'export const net = { fetch: (...args) => globalThis.__claudeQuotaTest.fetch(...args) }',
      './quota-credentials': 'export const customCommandCodeQuotaProviders = async () => []; export const resolveQuotaProviderCredential = async () => ({})',
      './quota': 'export const providerQuota = async () => ({}); export const fetchCodexUsage = async () => ({ windows: [] })',
      './quota-samples': 'export const quotaSamples = { withForecasts: async (_key, windows) => windows }',
      './codex-accounts': 'export const codexAccountTargets = async () => []',
      './oauth-accounts': 'export const oauthAccountTargets = async (provider) => provider === "anthropic" ? [globalThis.__claudeQuotaTest.account] : []'
    }
    const main = await compile('src/main/account-quota.ts', {
      plugins: [{ name: 'claude-quota-isolated', setup(build) {
        build.onResolve({ filter: /^(electron|\.\/(quota-credentials|quota|quota-samples|codex-accounts|oauth-accounts))$/ }, (args) => ({ path: args.path, namespace: 'claude-fixture' }))
        build.onLoad({ filter: /.*/, namespace: 'claude-fixture' }, (args) => ({ contents: stubs[args.path] }))
      } }]
    })
    const report = await main.accountQuotaReport()
    ok(report.cards[0].windows.some((window) => window.label === 'Fable' && window.used === 99), '宿主报告贯通 Fable 真实解析路径')
    ok(report.cards[0].resetCredits.groups.length === 2, '宿主报告保留两种重置卡')
    ok(requests[0].url.includes('cedar_ember=1') && requests[0].headers['User-Agent'] === 'claude-cli/2.1.322 (external, cli)', '查询携带重置卡参数，并用 Claude Code 的 UA 格式通过来源端资格判定')
    for (const grantId of ['fable-grant', 'normal-grant']) {
      const result = await main.consumeResetCredit('anthropic', 'fixture-account', grantId)
      const request = requests.findLast((request) => request.method === 'POST')
      const body = JSON.parse(request.body)
      ok(result.ok && body.grant_id === grantId && body.program === 'cedar_ember', '两类卡使用各自 grant_id，不回退到另一类卡')
      ok(request.url === 'https://api.anthropic.com/api/organizations/fixture-org/reset_rate_limits', '使用目标账号所属组织的重置接口')
    }
    const posts = requests.filter((request) => request.method === 'POST').length
    ok(!(await main.consumeResetCredit('anthropic', 'fixture-account', 'BAD ID')).ok && requests.filter((request) => request.method === 'POST').length === posts, '非法卡编号不发送重置请求')
  } finally {
    if (prior === undefined) delete globalThis.__claudeQuotaTest
    else globalThis.__claudeQuotaTest = prior
  }
})
