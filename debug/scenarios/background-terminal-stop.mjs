export const meta = { description: '回合收尾后用户在后台任务里停掉 agent 起的后台命令：不再起新回合，通知留到用户下一条消息时一起交给模型，不调用真实模型' }

const JOBS = `window.yan.terminal.jobs().then((jobs) => jobs.map((job) => ({ id: job.id, state: job.state })))`

const NOTICES = `(() => {
  const msgs = window.__yanStore.getState().messages
  return msgs.map((m, index) => ({ index, role: m.role, text: String(m.text || '') })).filter((m) => m.role === 'user' && m.text.startsWith('[砚宿主通知：后台终端命令]'))
})()`

const SHAPE = `(() => {
  const s = window.__yanStore.getState()
  return { messages: s.messages.length, running: !!(s.session?.isStreaming || s.session?.isAgentRunning), roles: s.messages.map((m) => m.role) }
})()`

export default async function run({ cdp, fake, box, check, report, sleep, shot, log, newSession, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  await newSession(box.project)
  await turn('BGTERMINAL BGSECONDS600 后台服务', { timeout: 60000 })
  const jobs = await ev(JOBS)
  const job = jobs.find((item) => item.state === 'running')
  report.jobs = jobs
  check('回合收尾时后台命令还在运行', !!job, jobs)

  const before = await ev(SHAPE)
  const requestsBefore = fake.requests.length
  const stopped = await ev(`window.yan.terminal.stopJob(${JSON.stringify(job?.id ?? '')})`)
  let after = []
  for (let i = 0; i < 40; i++) {
    after = await ev(JOBS)
    if (after.find((item) => item.id === job?.id)?.state === 'stopped') break
    await sleep(250)
  }
  check('用户停止后任务记为 stopped', stopped === true && after.find((item) => item.id === job?.id)?.state === 'stopped', after)

  await sleep(9000)
  const idle = await ev(SHAPE)
  const idleNotices = await ev(NOTICES)
  report.idle = { before, idle, requests: fake.requests.length - requestsBefore, notices: idleNotices.length }
  log('idle', report.idle)
  await shot('bg-stopped-idle')
  check('停止后 9 秒内没有新的模型请求', fake.requests.length === requestsBefore, fake.requests.slice(requestsBefore).map((item) => item.text))
  check('停止后会话保持空闲，消息数不变，没有冒出通知', !idle.running && idle.messages === before.messages && idleNotices.length === 0, { before, idle })

  const next = await turn('接着说', { timeout: 60000 })
  const notices = await ev(NOTICES)
  const shape = await ev(SHAPE)
  const firstRequest = fake.requests[requestsBefore]
  const requestTexts = fake.requests.slice(requestsBefore).map((item) => item.text)
  const replies = shape.roles.slice(before.messages).filter((role) => role === 'assistant').length
  report.next = { requests: next.requests, requestTexts, notices: notices.map((item) => ({ index: item.index, head: item.text.slice(0, 120) })), roles: shape.roles }
  log('next', report.next)
  await shot('bg-stopped-next-turn')
  check('下一条用户消息只换来一条回复，通知没有另起一次回答', replies === 1 && requestTexts.filter((text) => text.startsWith('[砚宿主通知：后台终端命令]')).length === 1, { replies, requestTexts })
  check('这次请求里通知排在用户消息之后一起送达', String(firstRequest?.text ?? '').startsWith('[砚宿主通知：后台终端命令]'), firstRequest?.text)
  check('通知状态是 stopped，在会话里显示为宿主提示', notices.length === 1 && /状态：stopped/.test(notices[0].text) && !!(await ev(`!!document.querySelector('[data-testid="v3-host-notice"]')`)), notices[0]?.text?.slice(0, 300))
}
