import { maximizeWindow } from '../lib/user-ui.mjs'

export const meta = { description: '守卫审阅界面：多原因审批卡、「模型审阅中」卡片、回执「等 N 项」、子代理审批与审阅回执进主流、子代理行审阅徽章；窗口最大化、右栏 360、深浅各拍（假模型，约 4 分钟）' }

const IDLE = `(() => { const s = window.__yanStore.getState(); return !!s.session && !s.session.isAgentRunning && !s.session.isStreaming && s.approvals.length === 0 && s.approvalReviews.length === 0 })()`
const MODEL_RECEIPTS = `[...document.querySelectorAll('[data-testid="v3-turn-approval-line"][data-reviewer="model"], [data-testid="v3-approval-receipt"][data-reviewer="model"]')].map((node) => node.textContent ?? '')`

export default async function run({ cdp, waitFor, check, report, sleep, newSession, shot, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  const theme = async (value) => {
    await ev(`window.__yanStore.getState().patchSettings({ theme: '${value}' })`)
    await sleep(700)
  }
  const both = async (name) => {
    for (const value of ['dark', 'light']) {
      await theme(value)
      report[`${name}-${value}`] = await shot(`${name}-${value}`)
    }
  }
  const openPanel = async () => {
    await waitFor(`!!window.__yanStore.getState().session?.sessionId`, 30000, 50)
    const open = () => ev(`document.querySelector('.v3-root')?.dataset.panel`)
    if ((await open()) === 'closed' || !(await open())) {
      await ev(`document.querySelector('[data-testid="v3-head-panel-toggle"]')?.click()`)
      await sleep(1400)
    }
    if ((await open()) === 'closed') {
      await ev(`(() => { const id = window.__yanStore.getState().session?.sessionId; const p = window.__yanRightPanel.getState(); if (id) p.load(id); p.setOpen(true); if (id) p.open({ id: 'files', kind: 'files' }) })()`)
      await sleep(1200)
    }
    await ev(`window.__yanRightPanel?.getState().setWidth(360)`)
    await sleep(800)
    return ev(`({ panel: document.querySelector('.v3-root')?.dataset.panel, width: window.__yanRightPanel?.getState().width, box: Math.round(document.querySelector('[data-testid="rp"]')?.getBoundingClientRect().width ?? 0) })`)
  }
  const toBottom = () => ev(`(() => { const stream = document.querySelector('.v3-stream'); if (stream) stream.scrollTop = stream.scrollHeight })()`)

  await cdp.call('Emulation.clearDeviceMetricsOverride').catch(() => {})
  report.window = await maximizeWindow(cdp)
  log('window', report.window)
  check('窗口已最大化', await ev(`window.__yanStore.getState().maximized === true`), report.window)

  await newSession()
  await sleep(800)
  report.panelA = await openPanel()
  check('右栏打开且宽 360', report.panelA.panel !== 'closed' && report.panelA.width === 360, report.panelA)
  await ev(`window.__yanStore.getState().send('APPROVALMULTI REVIEWSLOW25 一条命令命中多条规则，超时后慢审阅')`)
  await waitFor(`!!document.querySelector('[data-testid="v3-approval"]')`, 60000, 50)
  await sleep(1000)
  const pending = await ev(`window.__yanStore.getState().approvals[0]?.reasons ?? []`)
  check('审批卡带三条原因', pending.length >= 3, pending)
  await both('multi-card')

  await waitFor(`!!document.querySelector('[data-testid="v3-approval-review"]')`, 90000, 100)
  await sleep(1200)
  const reviewing = await ev(`(() => { const card = document.querySelector('[data-testid="v3-approval-review"]'); return { text: card?.textContent ?? '', more: card?.querySelectorAll('[data-testid="v3-approval-reasons"] li').length ?? 0, approvals: window.__yanStore.getState().approvals.length } })()`)
  check('超时后显示「模型审阅中」卡片', reviewing.text.includes('模型审阅中') && reviewing.approvals === 0, reviewing)
  check('审阅中卡片列出其余原因', reviewing.more >= 2, reviewing)
  await both('reviewing')

  await waitFor(IDLE, 120000, 200)
  await sleep(1500)
  await toBottom()
  await sleep(600)
  const multi = await ev(MODEL_RECEIPTS)
  log('multi receipts', multi)
  check('审阅完成后卡片消失、回执标题为「等 3 项」', multi.some((text) => text.includes('等 3 项')), multi)
  await both('multi-receipt')

  await newSession()
  await sleep(800)
  report.panelB = await openPanel()
  await ev(`window.__yanStore.getState().send('SUBAPPROVAL 派子代理去删测试用的注册表项')`)
  await waitFor(`window.__yanStore.getState().approvals.some((a) => !!a.subagentId)`, 90000, 100)
  await sleep(1200)
  await toBottom()
  await both('sub-card')

  await waitFor(`Object.values(window.__yanStore.getState().approvalLogs ?? {}).flat().some((r) => r.reviewer === 'model' && !!r.subagentId)`, 150000, 200)
  await waitFor(IDLE, 120000, 200)
  await sleep(2500)
  await toBottom()
  await sleep(800)
  const sub = await ev(`(() => {
    const s = window.__yanStore.getState()
    const parent = s.session?.sessionId
    const badge = document.querySelector('.v3-stream [data-testid="v3-subagent-model-review"]')
    const logged = (s.approvalLogs?.[parent] ?? []).filter((r) => r.reviewer === 'model' && !!r.subagentId).map((r) => ({ choice: r.choice, title: r.title, subagentId: r.subagentId }))
    return { badge: badge?.textContent ?? null, badgeTitle: badge?.getAttribute('title') ?? null, logged }
  })()`)
  log('subagent', sub)
  check('子代理的审阅回执记进主会话', sub.logged.length > 0, sub)
  check('主消息流的子代理行显示模型审阅徽章与回执明细', !!sub.badge && sub.badge.includes('模型审阅') && (sub.badgeTitle ?? '').includes('删除注册表项'), sub)
  await both('sub-receipt')
  await ev(`document.querySelector('.v3-stream [data-testid="v3-subagent-row"]')?.click()`)
  await sleep(1500)
  const pane = await ev(`[...document.querySelectorAll('[data-reviewer="model"]')].filter((node) => !node.closest('.v3-stream')).map((node) => node.textContent ?? '')`)
  log('subagent pane', pane)
  check('子代理记录里显示审阅回执', pane.some((text) => text.includes('模型审阅后')), pane)
  await both('sub-transcript')
  await theme('dark')
}
