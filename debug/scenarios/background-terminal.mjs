export const meta = { description: 'agent 用 yan terminal run --background 跑长命令：立即返回 background，后台任务面板显示运行中，结束后面板转为已结束并收到宿主通知，不调用真实模型' }

const TOOL_OUTPUTS = `(() => {
  const s = window.__yanStore.getState()
  const out = []
  for (const m of s.messages) for (const c of (m.toolCalls || [])) {
    if (!String(c.args && c.args.command).startsWith('yan terminal')) continue
    try {
      const p = JSON.parse(String(c.output || '').split('\\n')[0])
      out.push(p.ok ? { ok: true, state: p.summary.state, jobId: p.summary.jobId, id: p.summary.id } : { ok: false, code: p.code, error: p.error })
    } catch {
      out.push({ ok: false, raw: String(c.output || '').slice(0, 300) })
    }
  }
  return out
})()`

const OPEN_TASKS = `(() => {
  const bar = document.querySelector('[data-testid="v3-sessionbar"]')
  if (!bar) return 'no-bar'
  if (bar.querySelector('[data-testid="wb-bg-tasks"]')) return 'open'
  const button = [...bar.querySelectorAll('button')].find((b) => /后台任务|Background tasks/.test(b.textContent || ''))
  if (!button) return 'no-section'
  button.click()
  return 'clicked'
})()`

const PANEL = `(() => {
  const root = document.querySelector('[data-testid="wb-bg-tasks"]')
  const running = root?.querySelector('[data-testid="wb-bg-running"]')
  return {
    present: !!root,
    running: running ? running.querySelectorAll('[data-testid="wb-bg-row"]').length : 0,
    runningText: running?.innerText || '',
    finishedToggle: root?.querySelector('[data-testid="wb-bg-finished-toggle"]')?.innerText || ''
  }
})()`

const NOTICE = `(() => {
  const msgs = window.__yanStore.getState().messages
  const hit = msgs.find((m) => m.role === 'user' && String(m.text || '').startsWith('[砚宿主通知：后台终端命令]'))
  return hit ? { text: hit.text, rendered: !!document.querySelector('[data-testid="v3-host-notice"]') } : null
})()`

export default async function run({ cdp, box, check, report, sleep, shot, log, newSession, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  await newSession(box.project)
  await turn('BGTERMINAL 后台命令', { timeout: 60000 })
  const outputs = await ev(TOOL_OUTPUTS)
  report.outputs = outputs
  log('outputs', outputs)
  const started = outputs[0]
  check('run --background 先返回 background 与 jobId', started?.ok && started.state === 'background' && !!started.jobId, started)

  await ev(`window.__yanRightPanel.getState().setOpen(false), true`)
  await sleep(400)
  let opened = ''
  for (let i = 0; i < 20 && opened !== 'open'; i++) {
    opened = await ev(OPEN_TASKS)
    if (opened !== 'open') await sleep(200)
  }
  await sleep(500)
  const during = await ev(PANEL)
  report.during = during
  log('during', during)
  await shot('bg-running')
  check('后台任务面板显示一条运行中的终端命令', during.running === 1 && /bg-done|Start-Sleep/.test(during.runningText), { opened, during })

  let notice = null
  for (let i = 0; i < 60 && !notice; i++) {
    notice = await ev(NOTICE)
    if (!notice) await sleep(500)
  }
  await sleep(2500)
  const after = await ev(PANEL)
  report.after = after
  report.notice = notice
  log('after', after)
  log('notice', notice && notice.text)
  await shot('bg-finished')
  check('命令结束后宿主发来后台终端通知，状态 completed，含输出末尾', !!notice && /状态：completed/.test(notice.text) && /bg-done/.test(notice.text), notice?.text?.slice(0, 400))
  check('通知在会话里显示为宿主提示', !!notice?.rendered)
  check('面板里不再有运行中的任务，转入已结束', after.running === 0 && /1/.test(after.finishedToggle), after)
}
