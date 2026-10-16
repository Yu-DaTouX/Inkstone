export async function runQuotaRefreshTests(ok, mod) {
  const { claimDueQuotaWindows, decideQuotaRefresh, hasDueQuotaWindow } = mod
  const base = {
    now: 1_000_000,
    lastCheckedAt: null,
    intervalMs: 60_000,
    visible: true,
    supported: null,
    provider: 'deepseek',
    inFlightProvider: null
  }
  const decide = (over) => decideQuotaRefresh({ ...base, ...over })

  ok(decide({ trigger: 'initial' }).query === true, '首次进入就查一次')
  ok(decide({ trigger: 'initial' }).reason === 'initial', '首次进入的理由是 initial')
  ok(decide({ trigger: 'initial', visible: false }).query === true, '首次进入不受窗口可见性限制')

  ok(
    decide({ trigger: 'periodic', lastCheckedAt: base.now - 30_000 }).reason === 'skip-fresh',
    '周期刷新：快照还新鲜（30s < 60s）时不发请求'
  )
  ok(
    decide({ trigger: 'periodic', lastCheckedAt: base.now - 60_000 }).query === true,
    '周期刷新：到了间隔就发'
  )
  ok(decide({ trigger: 'periodic', lastCheckedAt: null }).query === true, '周期刷新：从没成功过也要发')
  ok(
    decide({ trigger: 'periodic', visible: false }).reason === 'skip-hidden',
    '周期刷新：页面不可见时跳过（不打断阅读）'
  )

  ok(
    decide({ trigger: 'focus', lastCheckedAt: base.now - 10_000 }).reason === 'skip-fresh',
    '恢复焦点：快照新鲜就不打扰接口'
  )
  ok(
    decide({ trigger: 'focus', lastCheckedAt: base.now - 120_000 }).reason === 'focus-stale',
    '恢复焦点：快照过期则补查一次'
  )

  ok(decide({ supported: false }).reason === 'skip-unsupported', '接口不支持时跳过自动查询')
  ok(decide({ trigger: 'periodic', supported: false }).query === false, '不支持时周期刷新也跳过')
  ok(decide({ trigger: 'focus', supported: false }).query === false, '不支持时焦点刷新也跳过')
  ok(decide({ provider: '' }).query === false, '没有 provider 时不查')

  ok(
    decide({ trigger: 'periodic', inFlightProvider: 'deepseek', lastCheckedAt: 0 }).reason === 'skip-inflight',
    '同一 provider 已有请求在飞时不重复发'
  )
  ok(
    decide({ trigger: 'periodic', inFlightProvider: 'openai', lastCheckedAt: 0 }).query === true,
    '换成另一个 provider 时不受旧请求阻塞'
  )

  ok(decide({ trigger: 'reset' }).query === true, '重置点到点就查')
  ok(decide({ trigger: 'reset' }).reason === 'reset-due', '重置点到点的理由是 reset-due')

  const win = (over) => ({ id: 'x', label: 'x', used: 1, total: 10, ...over })
  ok(
    hasDueQuotaWindow([win({ resetAt: base.now - 1 })], base.now) === true,
    '窗口已过重置时间 → 需要重查'
  )
  ok(hasDueQuotaWindow([win({ resetAt: base.now + 1 })], base.now) === false, '还没到重置时间 → 不查')
  ok(
    hasDueQuotaWindow([win({ resetAt: base.now - 1, exceeded: true })], base.now) === false,
    '已超限的窗口不再按“到点”重复触发'
  )
  ok(hasDueQuotaWindow([win({})], base.now) === false, '没有 resetAt 的窗口不触发')
  ok(hasDueQuotaWindow([], base.now) === false, '没有窗口时不触发')

  const attempted = new Set()
  const expired = [win({ resetAt: base.now - 1 })]
  ok(claimDueQuotaWindows(expired, base.now, attempted), '过期窗口首次允许补查')
  ok(!claimDueQuotaWindows(expired.map(w => ({ ...w })), base.now, attempted), '新响应对象保留相同过期窗口，不自驱动重复查询')
  for (let n = 0; n < 20; n++) {
    ok(!claimDueQuotaWindows(expired, base.now + n, attempted), '重复成功响应不形成连续请求循环')
  }
  ok(claimDueQuotaWindows([win({ resetAt: base.now - 2 })], base.now, attempted), '同窗口新的重置时间仍可补查')
  ok(attempted.size === 1, '已消失的窗口标识从闸门移除，集合保持有界')
  attempted.clear()
  ok(claimDueQuotaWindows(expired, base.now, attempted), '切 provider 清空闸门，新账号不会继承旧抑制')
  ok(!claimDueQuotaWindows([win({ resetAt: base.now + 100 })], base.now, attempted), '未来窗口不提前占用一次性补查机会')
}

export default runQuotaRefreshTests
