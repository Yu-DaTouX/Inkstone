export async function runQuotaResumeTests(report) {
  const ok = (label, cond) => report(!!cond, label)
  const m = await import('../out/test/quota-resume.mjs')
  const NOW = 1_000_000_000_000
  const win = (id, used, resetAt, extra = {}) => ({ id, label: id, used, total: 100, resetAt, ...extra })

  ok('额度窗口用尽的报错值得等', m.isQuotaWaitError("Claude rate limit (five_hour) — resets 10:30 pm: You've hit your session limit"))
  ok('每日免费次数用尽值得等', m.isQuotaWaitError("You've used all 100 free requests for today"))
  ok('余额不足不挂续跑', !m.isQuotaWaitError('insufficient balance'))
  ok('频率限流不挂续跑', !m.isQuotaWaitError('429 Too many requests, rate limit exceeded'))
  ok('鉴权错误不挂续跑', !m.isQuotaWaitError('401 Unauthorized'))
  ok('空错误不挂续跑', !m.isQuotaWaitError(''))

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
