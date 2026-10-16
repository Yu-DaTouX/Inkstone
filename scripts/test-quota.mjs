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

    ok(near(mo.used, 0.003778593), '本月：monthlyCredits 按「剩余」换算成已用（不是直接当已用）', `used=${mo.used}`)
    ok(mo.used < 1, '本月已用是「几乎没用过」的量级（方向没反）', `used=${mo.used}`)
    ok(mo.total === 70, '本月总额度 = weekly.cap × 2（推算，不写死 70）', `total=${mo.total}`)
    ok(mo.estimated === true, '本月上限标为「推算」（接口没有官方月额度字段）')
    ok(mo.exceeded === false, '没超限时不报 exceeded')
    ok(mo.resetAt === Date.UTC(2026, 9, 21), '本月窗口的重置时间来自订阅周期（调用方传入）')
    ok(!('estimated' in fh) && !('estimated' in wk), '5 小时 / 每周是官方字段，不该被标成推算')
  }

  {
    const mo = commandCodeWindows(
      { credits: { monthlyCredits: 35 }, windowLimits: { weekly: { used: 0, cap: 35 } } }
    ).find((w) => w.id === 'monthly')
    ok(near(mo.used, 35) && mo.total === 70, '剩余 35 ⇒ 已用 35 / 共 70（50%）', `${mo.used}/${mo.total}`)
    ok(mo.exceeded === false, '50% 不算超限')
  }

  {
    const mo = commandCodeWindows(
      { credits: { monthlyCredits: 0 }, windowLimits: { weekly: { used: 35, cap: 35 } } }
    ).find((w) => w.id === 'monthly')
    ok(near(mo.used, 70) && mo.exceeded === true, '剩余 0 ⇒ 已用 70 且标记 exceeded')
  }

  {
    const mo = commandCodeWindows(
      { credits: { monthlyCredits: 80 }, windowLimits: { weekly: { used: 0, cap: 35 } } }
    ).find((w) => w.id === 'monthly')
    ok(mo.used === 0 && mo.total === 80, '剩余超过推算上限时抬高总额度，已用夹在 0', `${mo.used}/${mo.total}`)
    ok(mo.exceeded === false, '这种情况不算超限')
  }

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
    [137, 'err']
  ]
  for (const [pct, want] of cases) {
    const got = quotaTone(pct)
    ok(got === want, `${pct}% → ${want}`, got === want ? '' : `实际 ${got}`)
  }

  ok(quotaTone(10, true) === 'err', '供应商报 exceeded ⇒ 恒红（哪怕百分比很低）')
  ok(quotaTone(Number.NaN) === 'ok', '拿不到比例（NaN）不误报红')
}
