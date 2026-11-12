import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '工作流：假模型派 12 个子代理分三个阶段，中途在运行卡上停止，再让主会话续跑到完成；截运行卡的深浅色与窄屏' }

const SCRIPT = `export const meta = {
  name: '假模型三阶段演示',
  description: '侦察两路、逐个审计六个文件（结构化输出）、四名复核',
  phases: ['侦察', '审计', '复核']
}

phase('侦察')
const scout = await parallel([1, 2].map((i) => agent('WFAGENT WFDELAY1500 WFITEM=scout' + i + ' 侦察范围', { label: '侦察 ' + i, readOnly: true, model: 'fake/fake-model' })))

phase('审计')
const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']
const audits = await pipeline(files, (file) => agent('WFAGENT WFJSON WFDELAY4000 WFITEM=' + file + ' 审计这个文件', {
  label: '审计 ' + file,
  readOnly: true,
  model: 'fake/fake-model',
  schema: { type: 'object', required: ['item', 'ok'], properties: { item: { type: 'string' }, ok: { type: 'boolean' }, notes: { type: 'array', items: { type: 'string' } } } }
}))
log('审计完成 ' + audits.filter(Boolean).length + ' 个')

phase('复核')
const votes = await parallel([1, 2, 3, 4].map((i) => agent('WFAGENT WFDELAY1500 WFITEM=review' + i + ' 复核结论', { label: '复核 ' + i, readOnly: true, model: 'fake/fake-model' })))
return { scouted: scout.filter(Boolean).length, audited: audits.filter(Boolean).map((a) => a.item), reviews: votes.filter(Boolean).length }
`

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, autoApprove, newSession, turn, log }) {
  const ev = (expression) => cdp.evaluate(expression)
  const runs = () => ev(`window.yan.workflows.list()`)
  const until = async (label, test, timeout = 120000, step = 300) => {
    const end = Date.now() + timeout
    let last
    while (Date.now() < end) {
      last = await test()
      if (last) return last
      await sleep(step)
    }
    throw new Error(`等待超时：${label}`)
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor('s.conn === "ready"')
  await ev(`window.__yanStore.getState().patchSettings({ lang: 'zh-CN', theme: 'dark' })`)
  await autoApprove()
  await newSession(box.project)
  writeFileSync(join(box.project, 'wf-demo.js'), SCRIPT)

  await turn('WFDEMO 用工作流跑一遍三阶段演示')
  const first = await until('工作流出现', async () => (await runs()).find((item) => item.name === '假模型三阶段演示'), 30000)
  const id = first.id
  report.workflowId = id
  log('workflow', id, first.status)
  check('yan workflow run 在后台启动并返回运行 ID', /^wf-[0-9a-f]{8}$/.test(id) && (first.status === 'running' || first.status === 'paused'), first.status)
  await until('运行卡出现', () => ev(`!!document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]')`), 20000)
  check('消息流里挂出运行卡', true)
  const declared = await ev(`[...document.querySelectorAll('[data-testid="v3-workflow"][data-run-id="${id}"] [data-testid="v3-workflow-phase"]')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim())`)
  check('阶段条按 meta.phases 列出三个阶段', declared.length === 3 && declared[0].startsWith('侦察') && declared[2].startsWith('复核'), declared)

  await ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"] [data-testid="v3-workflow-head"]')?.click()`)
  const midway = await until('审计阶段有完成也有在跑', async () => {
    const view = (await runs()).find((item) => item.id === id)
    const audit = view.agents.filter((agent) => agent.phase === '审计')
    return audit.some((agent) => agent.status === 'done') && audit.some((agent) => agent.status === 'running') ? view : null
  }, 150000, 200)
  log('midway', midway.agents.map((agent) => `${agent.seq}:${agent.status}`).join(' '))
  const running = midway.agents.filter((agent) => agent.status === 'running').length
  check('单次运行并发不超过设置的 4', running <= 4, running)
  await sleep(400)
  const grid = await ev(`document.querySelectorAll('[data-testid="v3-workflow"][data-run-id="${id}"] [data-testid="v3-subagent-tile"]').length`)
  check('展开后按阶段显示子代理网格', grid >= 3, grid)
  await shot('workflow-run-running-dark')

  const tileId = await ev(`(() => { const tile = document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"] [data-testid="v3-subagent-tile"]'); tile?.click(); return tile?.getAttribute('data-run-id') ?? tile?.dataset?.id ?? '' })()`)
  await sleep(800)
  const panel = await ev(`!!document.querySelector('[data-testid^="rp-surface-subagent:"]')`)
  check('点网格里的子代理打开右侧转录面板', panel, tileId)
  await shot('workflow-run-transcript')
  await ev(`(() => { const panel = window.__yanRightPanel?.getState?.(); panel?.closeAll?.(); panel?.setOpen?.(false) })()`)
  await sleep(400)

  const noticesBefore = await ev(`window.__yanStore.getState().messages.filter((m) => JSON.stringify(m).includes('[砚宿主通知：工作流')).length`)
  await ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"] [data-testid="v3-workflow-stop"]')?.click()`)
  const stopped = await until('停止生效', async () => {
    const view = (await runs()).find((item) => item.id === id)
    return view.status === 'stopped' ? view : null
  }, 30000, 200)
  const doneBefore = stopped.agents.filter((agent) => agent.status === 'done').length
  const stoppedCount = stopped.agents.filter((agent) => agent.status === 'stopped').length
  report.stopped = stopped.agents.map((agent) => `${agent.seq}:${agent.status}`)
  check('运行卡上的停止按钮停掉运行与在跑的子代理', stoppedCount >= 1 && doneBefore >= 2, report.stopped)
  await sleep(4000)
  const noticesAfterStop = await ev(`window.__yanStore.getState().messages.filter((m) => JSON.stringify(m).includes('[砚宿主通知：工作流')).length`)
  check('停止的运行不发完成通知', noticesAfterStop === noticesBefore, { noticesBefore, noticesAfterStop })
  const stoppedCard = await ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]')?.dataset.status`)
  check('运行卡显示已停止', stoppedCard === 'stopped', stoppedCard)
  await ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]')?.scrollIntoView({ block: 'start' })`)
  await sleep(400)
  await shot('workflow-run-stopped-dark')

  await turn(`WFRESUME=${id} 从停下的地方续跑`)
  const finished = await until('续跑完成', async () => {
    const view = (await runs()).find((item) => item.id === id)
    return view.status === 'done' || view.status === 'failed' ? view : null
  }, 180000, 500)
  report.resumed = finished.agents.map((agent) => `${agent.seq}:${agent.status}`)
  const cached = finished.agents.filter((agent) => agent.status === 'cached').length
  check('续跑完成，12 个调用全部完成', finished.status === 'done' && finished.agents.length === 12 && finished.agents.every((agent) => agent.status === 'done' || agent.status === 'cached'), report.resumed)
  check('续跑时停止前已完成的前缀直接返回保存的结果', cached >= 2 && cached <= doneBefore, { cached, doneBefore })
  check('续跑是同一个运行的第 2 次尝试', finished.attempt === 2, finished.attempt)

  await until('主会话收到完成通知', () => ev(`window.__yanStore.getState().messages.some((m) => JSON.stringify(m).includes('[砚宿主通知：工作流已完成]'))`), 60000, 300)
  check('结束时把最终答案作为通知投递给发起的主会话', true)
  await waitFor('!(s.session?.isStreaming || s.session?.isAgentRunning)', 60000)
  const noticeText = await ev(`(() => { const m = window.__yanStore.getState().messages.find((x) => JSON.stringify(x).includes('[砚宿主通知：工作流已完成]')); return JSON.stringify(m ?? {}) })()`)
  check('通知带最终答案与运行目录', noticeText.includes('audited') && noticeText.includes('workflows') && noticeText.includes(id), noticeText.slice(0, 300))
  const subagentNotices = await ev(`window.__yanStore.getState().messages.filter((m) => JSON.stringify(m).includes('<subagent-notification')).length`)
  check('工作流里的子代理不各自给主会话发完成通知', subagentNotices === 0, subagentNotices)
  const stray = await ev(`document.querySelectorAll('[data-testid="v3-subagents"]').length`)
  check('工作流的子代理不再单独挂一组蜂群卡', stray === 0, stray)

  await ev(`(() => { const panel = window.__yanRightPanel?.getState?.(); panel?.closeAll?.(); panel?.setOpen?.(false) })()`)
  await sleep(400)
  await ev(`(() => { const card = document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]'); if (card?.querySelector('[data-testid="v3-workflow-grid"]')) card.querySelector('[data-testid="v3-workflow-head"]')?.click() })()`)
  await sleep(400)
  await ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(600)
  const doneCard = await ev(`(() => { const card = document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]'); return { status: card?.dataset.status, phases: [...(card?.querySelectorAll('[data-testid="v3-workflow-phase"]') ?? [])].map((el) => el.innerText.replace(/\\s+/g, ' ').trim()), stop: !!card?.querySelector('[data-testid="v3-workflow-stop"]') } })()`)
  check('完成后运行卡显示已完成、各阶段满格、不再有停止按钮', doneCard.status === 'done' && doneCard.phases.join('|') === '侦察 2/2|审计 6/6|复核 4/4' && !doneCard.stop, doneCard)
  await shot('workflow-run-done-dark')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(600)
  await shot('workflow-run-done-light')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 560, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(800)
  await ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]')?.scrollIntoView({ block: 'start' })`)
  await sleep(400)
  const overflow = await ev(`(() => { const card = document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]'); if (!card) return null; const box = card.getBoundingClientRect(); const wide = [...card.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > box.right + 1).length; return { width: Math.round(box.width), wide } })()`)
  check('窄屏下运行卡不横向溢出', overflow && overflow.wide === 0, overflow)
  await shot('workflow-run-done-narrow-light')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  await sleep(600)
  await shot('workflow-run-done-narrow-dark')
}
