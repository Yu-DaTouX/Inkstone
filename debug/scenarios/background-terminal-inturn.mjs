export const meta = { description: 'agent 起的后台命令在同一回合里跑完：通知直接插进当前回合，回合结束后不再另起一个回合，不调用真实模型' }

const NOTICE_HEAD = '[砚宿主通知：后台终端命令]'

const SHAPE = `(() => {
  const s = window.__yanStore.getState()
  return {
    running: !!(s.session?.isStreaming || s.session?.isAgentRunning),
    roles: s.messages.map((m) => m.role),
    notices: s.messages.map((m, index) => ({ index, role: m.role, text: String(m.text || '') })).filter((m) => m.role === 'user' && m.text.startsWith(${JSON.stringify(NOTICE_HEAD)})).map((m) => ({ index: m.index, head: m.text.slice(0, 200) }))
  }
})()`

export default async function run({ cdp, fake, box, check, report, sleep, shot, log, newSession, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  await newSession(box.project)
  const first = fake.requests.length
  await turn('BGTERMINAL BGSECONDS5 BGBUSY 边跑边干活', { timeout: 90000 })
  const ended = await ev(SHAPE)
  await shot('bg-inturn-ended')
  await sleep(8000)
  const later = await ev(SHAPE)
  const laterRequests = fake.requests.slice(first).map((item) => item.text).filter((text) => text.startsWith('BGTERMINAL') || text.startsWith(NOTICE_HEAD))
  const noticeAt = laterRequests.findIndex((text) => text.startsWith(NOTICE_HEAD))
  const busySteps = laterRequests.filter((text) => text.startsWith('BGTERMINAL')).length
  report.inturn = { ended, later: { running: later.running, roles: later.roles }, laterRequests, noticeAt, busySteps }
  log('inturn', report.inturn)
  const withNotice = laterRequests.filter((text) => text.startsWith(NOTICE_HEAD)).length
  check('通知在回合中途送达：原本 13 次的连续干活被它打断，之后没有再接着干', noticeAt > 0 && noticeAt === laterRequests.length - 1 && busySteps < 13, { noticeAt, busySteps })
  check('通知只送达一次，状态 completed', ended.notices.length === 1 && /状态：completed/.test(ended.notices[0].head), ended.notices)
  check('通知之后模型在同一回合里只回了一次', withNotice === 1, laterRequests)
  check('回合结束后 8 秒内没有再起回合', !later.running && later.roles.length === ended.roles.length, { ended: ended.roles, later: later.roles })
}
