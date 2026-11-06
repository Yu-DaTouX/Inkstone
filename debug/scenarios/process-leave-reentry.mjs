export const meta = { description: '过程区收起动画未结束时同一回合重新进入运行态，再结束且高度差不足 2px：不应残留旧高度的占位块' }

export default async function run({ cdp, box, sleep, check, report, log, autoApprove, newSession, turn }) {
  const ev = (expression) => cdp.evaluate(expression)
  await autoApprove()
  await newSession(box.project)
  await turn('MANYTOOLS 先跑一批工具', { timeout: 120000 })
  await sleep(1500)
  const setRunning = (value) => ev(`window.__yanStore.setState((s) => ({ session: { ...s.session, isAgentRunning: ${value}, isStreaming: false } }))`)
  const leaves = () => ev(`[...document.querySelectorAll('.v3-process-leave')].map((el) => Math.round(el.getBoundingClientRect().height))`)
  const processState = () => ev(`(() => { const el = [...document.querySelectorAll('[data-testid="v3-process"]')].pop(); return el ? { live: el.dataset.live === '1' || el.hasAttribute('data-live'), open: el.hasAttribute('data-open'), h: Math.round(el.getBoundingClientRect().height) } : null })()`)

  await setRunning(true)
  await sleep(500)
  const live = await processState()
  await setRunning(false)
  await sleep(40)
  const firstLeave = await leaves()
  await setRunning(true)
  await sleep(120)
  await ev(`[...document.querySelectorAll('[data-testid="v3-process-toggle"]')].pop().click()`)
  await sleep(400)
  const opened = await processState()
  await setRunning(false)
  const samples = []
  for (let i = 0; i < 12; i += 1) {
    samples.push(await leaves())
    await sleep(60)
  }
  const stale = samples.flat().filter((h) => h > 2)
  report.case = { live, firstLeave, opened, samples, stale }
  log('leave-reentry', report.case)
  check('第一次结束产生收起占位（场景前提）', firstLeave.length > 0 && firstLeave[0] > 2, report.case)
  check('重新进入运行态再结束后没有残留旧高度占位', stale.length === 0, report.case)
}
