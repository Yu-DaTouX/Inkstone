/*
 * 额度刷新调度单测（src/shared/quota-refresh.ts，实施-20 U3）。
 *
 * 用假时钟覆盖「首次 / 周期 / 恢复窗口 / 重置点 / 并发 / 失败与切 provider」
 * 里**该不该发请求**的部分。真实 provider 的额度接口不在这里打。
 */

export async function runQuotaRefreshTests(ok, mod) {
  const { decideQuotaRefresh, hasDueQuotaWindow } = mod
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

  /* ── 首次进入：即使窗口不可见也要先查一次 ── */
  ok(decide({ trigger: 'initial' }).query === true, '首次进入就查一次')
  ok(decide({ trigger: 'initial' }).reason === 'initial', '首次进入的理由是 initial')
  ok(decide({ trigger: 'initial', visible: false }).query === true, '首次进入不受窗口可见性限制')

  /* ── 周期：新鲜就跳过，过期才发 ── */
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

  /* ── 窗口恢复焦点：过期才补查 ── */
  ok(
    decide({ trigger: 'focus', lastCheckedAt: base.now - 10_000 }).reason === 'skip-fresh',
    '恢复焦点：快照新鲜就不打扰接口'
  )
  ok(
    decide({ trigger: 'focus', lastCheckedAt: base.now - 120_000 }).reason === 'focus-stale',
    '恢复焦点：快照过期则补查一次'
  )

  /* ── 不支持 / 没 provider：一次都不自动查 ── */
  ok(decide({ supported: false }).reason === 'skip-unsupported', '接口不支持时跳过自动查询')
  ok(decide({ trigger: 'periodic', supported: false }).query === false, '不支持时周期刷新也跳过')
  ok(decide({ trigger: 'focus', supported: false }).query === false, '不支持时焦点刷新也跳过')
  ok(decide({ provider: '' }).query === false, '没有 provider 时不查')

  /* ── 并发：同一个 provider 只允许一笔在飞，切了就放行 ── */
  ok(
    decide({ trigger: 'periodic', inFlightProvider: 'deepseek', lastCheckedAt: 0 }).reason === 'skip-inflight',
    '同一 provider 已有请求在飞时不重复发'
  )
  ok(
    decide({ trigger: 'periodic', inFlightProvider: 'openai', lastCheckedAt: 0 }).query === true,
    '换成另一个 provider 时不受旧请求阻塞'
  )

  /* ── 重置点到点 ── */
  ok(decide({ trigger: 'reset' }).query === true, '重置点到点就查')
  ok(decide({ trigger: 'reset' }).reason === 'reset-due', '重置点到点的理由是 reset-due')

  /* ── hasDueQuotaWindow：到点只代表“该问一次”，不本地归零 ── */
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
}

export default runQuotaRefreshTests
