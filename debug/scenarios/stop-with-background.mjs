export const meta = { description: '回合进行中且有后台命令时点停止，弹二次确认；取消不停；一起停止连后台命令一起停，不调用真实模型' }

const JOBS = `window.yan.terminal.jobs().then((jobs) => jobs.map((job) => ({ id: job.id, state: job.state, command: job.command })))`
const RUNNING = `(() => { const s = window.__yanStore.getState(); return !!(s.session?.isStreaming || s.session?.isAgentRunning) })()`
const DIALOG = `!!document.querySelector('[data-testid="stop-background-confirm"]')`

export default async function run({ cdp, box, check, report, sleep, shot, log, newSession, until }) {
  const ev = (expr) => cdp.evaluate(expr)
  await newSession(box.project)
  await ev(`void window.__yanStore.getState().send('BGTERMINAL BGSECONDS600 BGBUSY 后台服务')`)
  let jobs = []
  for (let i = 0; i < 120; i++) {
    jobs = await ev(JOBS)
    if (jobs.some((job) => job.state === 'running') && (await ev(RUNNING))) break
    await sleep(250)
  }
  report.jobsBefore = jobs
  check('回合进行中且有运行中的后台命令', jobs.some((job) => job.state === 'running') && (await ev(RUNNING)), jobs)

  await ev(`void window.__yanStore.getState().abort()`)
  await until(DIALOG, 5000)
  await sleep(500)
  await shot('stop-bg-dialog')
  check('点停止弹出二次确认', await ev(DIALOG))
  const text = await ev(`document.querySelector('[data-testid="stop-background-confirm"]')?.innerText ?? ''`)
  report.dialogText = text
  log('dialog', text)

  await ev(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(600)
  check('Esc 关闭确认框', !(await ev(DIALOG)))
  check('Esc 后回合仍在运行、后台命令仍在运行', (await ev(RUNNING)) && (await ev(JOBS)).some((job) => job.state === 'running'))

  await ev(`void window.__yanStore.getState().abort()`)
  await until(DIALOG, 5000)
  await ev(`document.querySelector('[data-testid="stop-background-together"]')?.click()`)
  let after = []
  for (let i = 0; i < 60; i++) {
    after = await ev(JOBS)
    if (!(await ev(RUNNING)) && after.every((job) => job.state !== 'running' && job.state !== 'stopping')) break
    await sleep(250)
  }
  report.jobsAfter = after
  await shot('stop-bg-after-together')
  check('一起停止后回合结束', !(await ev(RUNNING)))
  check('一起停止后后台命令为 stopped', after.length > 0 && after.every((job) => job.state === 'stopped'), after)
}
