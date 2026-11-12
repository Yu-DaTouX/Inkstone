export const meta = { description: '审批卡 1 分钟倒计时：停表、超时交模型审阅放行与拦下、回执显示审阅结果（假模型，约 3 分钟）' }

const CARD = `document.querySelector('[data-testid="v3-approval"]')`
const COUNTDOWN = `document.querySelector('[data-testid="v3-approval-countdown"]')?.textContent ?? ''`
const MODEL_RECEIPT = `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="v3-turn-approval-line"][data-reviewer="model"], [data-testid="v3-approval-receipt"][data-reviewer="model"]')]
  return nodes.map((node) => ({ choice: node.dataset.choice ?? '', text: node.textContent ?? '' }))
})()`

export default async function run({ cdp, waitFor, check, report, sleep, newSession, shot, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  const idle = `(() => { const s = window.__yanStore.getState(); return !!s.session && !s.session.isAgentRunning && !s.session.isStreaming && s.approvals.length === 0 })()`
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })

  const startApproval = async (prompt) => {
    await newSession()
    await sleep(800)
    await ev(`window.__yanStore.getState().send(${JSON.stringify(prompt)})`)
    await waitFor(`!!${CARD}`, 60000, 50)
    await sleep(800)
  }

  await startApproval('APPROVAL REVIEWALLOW 超时后让模型审阅放行')
  const pending = await ev(`window.__yanStore.getState().approvals[0]`)
  report.pending = { expiresAt: pending?.expiresAt, createdAt: pending?.createdAt, onTimeout: pending?.onTimeout, held: pending?.held }
  check('审批请求带 1 分钟到期时间', pending && pending.expiresAt - pending.createdAt === 60000, report.pending)
  check('审批档守卫超时交模型审阅', pending?.onTimeout === 'review', report.pending)
  const countdown = await ev(COUNTDOWN)
  check('卡片显示倒计时和超时去向', /\d{2}:\d{2}/.test(countdown) && countdown.includes('交模型审阅'), countdown)
  report.countdownShot = await shot('danger-review-countdown')
  await waitFor(idle, 120000, 200)
  await sleep(1500)
  const allowed = await ev(MODEL_RECEIPT)
  log('allowed', allowed)
  check('超时后模型审阅放行并留回执', allowed.some((item) => item.choice === 'once' && item.text.includes('模型审阅后放行')), allowed)
  report.allowedShot = await shot('danger-review-allowed')

  await startApproval('APPROVAL 超时后让模型审阅拦下')
  await waitFor(idle, 120000, 200)
  await sleep(1500)
  const denied = await ev(MODEL_RECEIPT)
  log('denied', denied)
  check('超时后模型审阅拦下并留回执和理由', denied.some((item) => item.choice === 'deny' && item.text.includes('模型审阅后拦下') && item.text.includes('没有要求删除注册表项')), denied)
  report.deniedShot = await shot('danger-review-denied')

  await startApproval('APPROVAL 碰卡停表')
  await ev(`(() => { const body = document.querySelector('[data-testid="v3-approval"] .v3-approval-body'); body?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })) })()`)
  await waitFor(`!!window.__yanStore.getState().approvals[0]?.held`, 10000, 50)
  await sleep(1200)
  const held = await ev(`window.__yanStore.getState().approvals[0]`)
  const heldText = await ev(COUNTDOWN)
  check('碰卡后停表', held?.held === true && held.expiresAt - Date.now() > 25 * 60_000, { held: held?.held, left: held ? held.expiresAt - Date.now() : null })
  check('停表后卡片显示等你处理', heldText.includes('已停表'), heldText)
  report.heldShot = await shot('danger-review-held')
  await ev(`(() => { const s = window.__yanStore.getState(); const a = s.approvals[0]; if (a) void s.answerApproval(a.id, 'deny', { ...(a.owner ? { owner: a.owner } : {}), revision: a.revision }) })()`)
  await waitFor(idle, 60000, 200)
  check('停表后仍能按原版本拒绝', await ev(`window.__yanStore.getState().approvals.length === 0`), null)
}
