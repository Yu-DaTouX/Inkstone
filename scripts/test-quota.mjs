/**
 * Command Code 订阅额度的窗口解析（不联网、不用凭证）。
 *
 * 为什么值得单独测：`/alpha/billing/credits` 的同一个响应里，
 * `windowLimits.*.used` 是「已用」而 `credits.monthlyCredits` 是「本月剩余」——
 * 两个方向相反的字段。搞反的后果不是崩，而是**面板一直显示「本月已用 99.9%」**，
 * 用户以为额度用完了（2026-09-21 用户报的就是这个）。
 *
 * 这里的快照就是那天线上接口的原样字段（真账户、几乎没消耗）：
 *   monthlyCredits = 69.996221407，fiveHour.used = weekly.used = 0.003778593
 *   weekly.cap = 35 ⇒ 套餐总额度 70
 * 如果哪天有人把方向改回去，第一条断言就会红。
 */

/** 真实快照：本月几乎没消耗（2026-09-21 抓的线上响应） */
const LIVE_SNAPSHOT = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 69.996221407, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.003778593, cap: 14, exceeded: false, resetAt: 1790013986382 },
    weekly: { used: 0.003778593, cap: 35, exceeded: false, resetAt: 1790600786382 }
  }
}

const near = (a, b) => Math.abs(a - b) < 1e-6

export function runQuotaCommandCodeTests(ok, m) {
  const { commandCodeWindows } = m

  console.log('\n--- 额度：Command Code 窗口口径 ---')

  {
    const windows = commandCodeWindows(LIVE_SNAPSHOT, Date.UTC(2026, 9, 21))
    const byId = Object.fromEntries(windows.map((w) => [w.id, w]))

    ok(windows.length === 3, '三个窗口都产出（5 小时 / 每周 / 本月）', windows.map((w) => w.id).join(', '))

    const fh = byId.fiveHour
    const wk = byId.weekly
    const mo = byId.monthly
    ok(fh?.used === 0.003778593 && fh.total === 14, '5 小时窗口：used 直接取接口值', `${fh?.used} / ${fh?.total}`)
    ok(wk?.used === 0.003778593 && wk.total === 35, '每周窗口：used 直接取接口值', `${wk?.used} / ${wk?.total}`)
    ok(fh?.resetAt === 1790013986382 && wk?.resetAt === 1790600786382, '两个窗口的重置时间原样保留')

    /*
     * ★ 本次修复的核心断言。
     * monthlyCredits 是「剩余」：已用 = 总额度(weekly.cap×2=70) − 剩余。
     * 若按「已用」解释，这里会是 69.99 —— 面板就会显示「本月已用 99.99%」。
     */
    ok(near(mo.used, 0.003778593), '本月：monthlyCredits 按「剩余」换算成已用（不是直接当已用）', `used=${mo.used}`)
    ok(mo.used < 1, '本月已用是「几乎没用过」的量级（方向没反）', `used=${mo.used}`)
    ok(mo.total === 70, '本月总额度 = weekly.cap × 2（推算，不写死 70）', `total=${mo.total}`)
    ok(mo.estimated === true, '本月上限标为「推算」（接口没有官方月额度字段）')
    ok(mo.exceeded === false, '没超限时不报 exceeded')
    ok(mo.resetAt === Date.UTC(2026, 9, 21), '本月窗口的重置时间来自订阅周期（调用方传入）')
    ok(!('estimated' in fh) && !('estimated' in wk), '5 小时 / 每周是官方字段，不该被标成推算')
  }

  /* 用了一半：剩余 35 → 已用 35 */
  {
    const mo = commandCodeWindows(
      { credits: { monthlyCredits: 35 }, windowLimits: { weekly: { used: 0, cap: 35 } } }
    ).find((w) => w.id === 'monthly')
    ok(near(mo.used, 35) && mo.total === 70, '剩余 35 ⇒ 已用 35 / 共 70（50%）', `${mo.used}/${mo.total}`)
    ok(mo.exceeded === false, '50% 不算超限')
  }

  /* 用满：剩余 0 → exceeded */
  {
    const mo = commandCodeWindows(
      { credits: { monthlyCredits: 0 }, windowLimits: { weekly: { used: 35, cap: 35 } } }
    ).find((w) => w.id === 'monthly')
    ok(near(mo.used, 70) && mo.exceeded === true, '剩余 0 ⇒ 已用 70 且标记 exceeded')
  }

  /* 剩余比推算上限还大（比如另外买了额度包）：不能算出负数已用 */
  {
    const mo = commandCodeWindows(
      { credits: { monthlyCredits: 80 }, windowLimits: { weekly: { used: 0, cap: 35 } } }
    ).find((w) => w.id === 'monthly')
    ok(mo.used === 0 && mo.total === 80, '剩余超过推算上限时抬高总额度，已用夹在 0', `${mo.used}/${mo.total}`)
    ok(mo.exceeded === false, '这种情况不算超限')
  }

  /* 脏数据/缺字段：宁可少一个窗口，也不能编数字 */
  {
    const noWeeklyCap = commandCodeWindows({ credits: { monthlyCredits: 10 }, windowLimits: { fiveHour: { used: 1, cap: 14 } } })
    ok(noWeeklyCap.length === 1 && noWeeklyCap[0].id === 'fiveHour', 'weekly.cap 缺失 ⇒ 不产出月度窗口（不编分母）')

    const noMonthly = commandCodeWindows({ windowLimits: { weekly: { used: 1, cap: 35 } } })
    ok(noMonthly.length === 1 && noMonthly[0].id === 'weekly', 'monthlyCredits 缺失 ⇒ 只有官方窗口')

    const noUsed = commandCodeWindows({ windowLimits: { weekly: { cap: 35 } } })[0]
    ok(noUsed.used === 0, '窗口缺 used ⇒ 记 0（不是 NaN）')

    const badCap = commandCodeWindows({ windowLimits: { weekly: { used: 1, cap: 'x' } } })
    ok(badCap.length === 0, 'cap 不是数字 ⇒ 不产出该窗口')

    ok(commandCodeWindows({}).length === 0, '空响应 ⇒ 0 个窗口（由调用方给出「未返回额度窗口」）')
    ok(commandCodeWindows(LIVE_SNAPSHOT).find((w) => w.id === 'monthly').resetAt === undefined, '没传订阅周期 ⇒ 月度不显示重置时间')
  }
}

/**
 * 颜色分级（`src/shared/quota-tone.ts`）：<70% 绿 / 70–95% 黄 / ≥95% 红。
 *
 * 为什么用纯函数而不是 DOM 断言：真实额度不可能恰好落在 70 / 95 上，
 * 而边界恰恰是最容易写错的地方（`>` 还是 `>=`），所以直接钉住函数。
 * 「颜色真的显示成绿/黄/红」由 `test:live -- quota`（真实渲染）与视觉矩阵覆盖。
 */
export function runQuotaToneTests(ok, m) {
  const { quotaTone, QUOTA_WARN_PCT, QUOTA_ERR_PCT } = m

  console.log('\n--- 额度：颜色分级边界 ---')

  ok(QUOTA_WARN_PCT === 70 && QUOTA_ERR_PCT === 95, '阈值就是 70 / 95（用户口径）', `${QUOTA_WARN_PCT}/${QUOTA_ERR_PCT}`)

  const cases = [
    [0, 'ok'],
    [50, 'ok'],
    [69.9, 'ok'],
    [70, 'warn'],
    [70.1, 'warn'],
    [94.9, 'warn'],
    [95, 'err'],
    [99.9, 'err'],
    [100, 'err'],
    /* 超支也要如实红（不是夹取到 100 才红） */
    [137, 'err']
  ]
  for (const [pct, want] of cases) {
    const got = quotaTone(pct)
    ok(got === want, `${pct}% → ${want}`, got === want ? '' : `实际 ${got}`)
  }

  ok(quotaTone(10, true) === 'err', '供应商报 exceeded ⇒ 恒红（哪怕百分比很低）')
  ok(quotaTone(Number.NaN) === 'ok', '拿不到比例（NaN）不误报红')
}
