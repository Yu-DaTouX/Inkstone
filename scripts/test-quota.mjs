
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
    [70, 'ask'],
    [70.1, 'ask'],
    [94.9, 'ask'],
    [95, 'fail'],
    [99.9, 'fail'],
    [100, 'fail'],
    [137, 'fail']
  ]
  for (const [pct, want] of cases) {
    const got = quotaTone(pct)
    ok(got === want, `${pct}% → ${want}`, got === want ? '' : `实际 ${got}`)
  }

  ok(quotaTone(10, true) === 'fail', '供应商报 exceeded ⇒ 恒红（哪怕百分比很低）')
  ok(quotaTone(Number.NaN) === 'ok', '拿不到比例（NaN）不误报红')
}

export async function runQuotaResumeTests(report) {
  const ok = (label, cond) => report(!!cond, label)
  const m = await import('../out/test/quota-resume.mjs')
  const NOW = 1_000_000_000_000
  const win = (id, used, resetAt, extra = {}) => ({ id, label: id, used, total: 100, resetAt, ...extra })

  ok('额度窗口用尽的报错值得等', m.isQuotaWaitError("Claude rate limit (five_hour) — resets 10:30 pm: You've hit your session limit"))
  ok('每日免费次数用尽值得等', m.isQuotaWaitError("You've used all 100 free requests for today"))
  ok('余额不足不挂续跑', !m.isQuotaWaitError('insufficient balance'))
  ok('额外用量用尽不挂续跑', !m.isQuotaWaitError('400 Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.'))
  ok('频率限流不挂续跑', !m.isQuotaWaitError('429 Too many requests, rate limit exceeded'))
  ok('鉴权错误不挂续跑', !m.isQuotaWaitError('401 Unauthorized'))
  ok('空错误不挂续跑', !m.isQuotaWaitError(''))
  ok('Anthropic 429 rate_limit_error \u5f52\u4e3a\u9650\u6d41\uff0c\u5f85\u6838\u5bf9\u989d\u5ea6\u7a97\u53e3', m.isRateLimitError('429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}'))
  ok('\u989d\u5ea6\u7528\u5c3d\u4e0d\u7b97\u9650\u6d41', !m.isRateLimitError("You've used all 100 free requests for today"))
  ok('\u9274\u6743\u9519\u8bef\u4e0d\u7b97\u9650\u6d41', !m.isRateLimitError('401 Unauthorized'))

  ok('已用满的窗口算被卡住', m.blockedQuotaWindows([win('a', 100), win('b', 40)]).map((w) => w.id).join() === 'a')
  ok('exceeded 标记算被卡住', m.blockedQuotaWindows([win('a', 10, undefined, { exceeded: true })]).length === 1)
  ok('仅供参考的窗口不算', m.blockedQuotaWindows([win('a', 100, undefined, { informational: true })]).length === 0)

  ok('没有窗口被卡住 → 可续跑', m.decideQuotaResume([win('a', 60), win('b', 99.9)], NOW).ready)
  const wait = m.decideQuotaResume([win('five', 100, NOW + 3_600_000), win('week', 100, NOW + 86_400_000)], NOW)
  ok('多个窗口都满 → 等最晚的那个', !wait.ready && wait.resetAt === NOW + 86_400_000)
  ok('离重置很远按固定间隔轮询', wait.nextCheckAt === NOW + m.QUOTA_RESUME_POLL_MS)
  const soon = m.decideQuotaResume([win('five', 100, NOW + 20_000)], NOW)
  ok('快到点时对准重置时间再查', soon.nextCheckAt === NOW + 25_000)
  const past = m.decideQuotaResume([win('five', 100, NOW - 1000)], NOW)
  ok('重置时间已过但接口仍报满 → 继续等，不本地放行', !past.ready && past.nextCheckAt === NOW + m.QUOTA_RESUME_POLL_MS)
  ok('没有重置时间 → 仍按间隔轮询', m.decideQuotaResume([win('five', 100)], NOW).nextCheckAt === NOW + m.QUOTA_RESUME_POLL_MS)
}

export async function runQuotaMiniTests(ok, mod) {
  const { money, quotaCompactWindows, windowPct, CURRENCY_SYMBOL } = mod

  ok(money(9.92, 'USD') === '$9.92', 'money：美元用 $ 前缀')
  ok(money(9.92, 'CNY') === '¥9.92', 'money：人民币用 ¥（DeepSeek 余额的真实场景）')
  ok(money(28, 'PERCENT') === '28.0%', 'money：PERCENT 伪币种渲染成百分比而不是 $28.00')
  ok(money(12.5, 'XYZ') === '12.50 XYZ', 'money：未知币种退回「数字 + 代码」，不猜符号')
  ok(money(3) === '$3.00', 'money：缺省币种按美元')
  ok(Object.keys(CURRENCY_SYMBOL).includes('JPY'), 'money：符号表含 JPY')

  const w = (id, label, used, total) => ({ id, label, used, total })
  const five = w('fiveHour', '5 小时', 25, 100)
  const week = w('weekly', '每周', 40, 100)
  const month = w('monthly', '本月', 100, 1000)

  const fiveWeek = quotaCompactWindows([five, week, month])
  ok(fiveWeek.length === 2, '紧凑栏：有小时窗口时只显示「小时 + 周」，不塞进来月')
  ok(fiveWeek[0].label === '5h', '紧凑栏：小时窗口标签缩成 5h')
  ok(fiveWeek[1].label === '周', '紧凑栏：周窗口标签为 周')
  ok(fiveWeek[0].window.id === 'fiveHour', '紧凑栏：标签是显示用的，window 仍是原对象')

  const weekMonth = quotaCompactWindows([week, month])
  ok(
    weekMonth.length === 2 && weekMonth[0].label === '周' && weekMonth[1].label === '月',
    '紧凑栏：没有小时窗口时退成「周 + 月」'
  )
  ok(quotaCompactWindows([]).length === 0, '紧凑栏：没有窗口就是空（不推算缺失窗口）')
  ok(
    quotaCompactWindows([w('primary', '已用', 1, 10)])[0].label === '5h',
    '紧凑栏：primary 无数字标签时仍给出 5h'
  )

  ok(windowPct(w('x', 'x', 5, 0)) === null, 'windowPct：total 为 0 时返回 null（不假装 0%）')
  ok(windowPct(w('x', 'x', 25, 100)) === 25, 'windowPct：整数百分比在 0 位下是 25')
  ok(windowPct(w('x', 'x', 25, 100), 1) === 25, 'windowPct：同一次除法在 1 位下仍是 25')
  ok(windowPct(w('x', 'x', 1, 3)) === 33, 'windowPct：1/3 在 0 位下四舍五入到 33')
  ok(windowPct(w('x', 'x', 1, 3), 1) === 33.3, 'windowPct：1/3 在 1 位下是 33.3')
  ok(
    windowPct(w('x', 'x', 1, 3)) === Number(windowPct(w('x', 'x', 1, 3), 1).toFixed(0)),
    'windowPct：摘要（0 位）与明细（1 位）来自同一次除法，不会各算一次'
  )
  ok(windowPct(w('x', 'x', 150, 100), 1) === 150, 'windowPct：超过 100% 如实返回（不夹取）')
}

export default runQuotaMiniTests


