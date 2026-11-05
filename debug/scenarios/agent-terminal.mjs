export const meta = { description: 'agent 用 yan terminal 操作会话终端：自动打开终端面板并显示「Agent 正在操作」、复用同一终端、输出已渲染；危险命令只弹一张宿主审批卡，拒绝不写入、允许只执行一次，不调用真实模型' }

const TOOL_OUTPUTS = `(() => {
  const s = window.__yanStore.getState()
  const out = []
  for (const m of s.messages) for (const c of (m.toolCalls || [])) {
    if (!String(c.args && c.args.command).startsWith('yan terminal')) continue
    try {
      const p = JSON.parse(String(c.output || '').split('\\n')[0])
      out.push(p.ok ? { ok: true, action: p.summary.action, state: p.summary.state, created: p.summary.created, count: p.summary.count, id: p.summary.id, output: p.summary.output } : { ok: false, code: p.code, error: p.error })
    } catch {
      out.push({ ok: false, raw: String(c.output || '').slice(0, 300) })
    }
  }
  return out
})()`

const PANEL = `(() => ({
  xterm: document.querySelectorAll('.xterm').length,
  badge: !!document.querySelector('[data-testid="terminal-agent-active"]'),
  tabs: document.querySelectorAll('[data-testid^="terminal-tab-"]').length,
  text: (document.querySelector('.xterm-rows') || document.querySelector('.xterm-accessibility-tree') || { innerText: '' }).innerText
}))()`

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, log, newSession, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  await newSession(box.project)
  await ev(`window.__yanRightPanel.getState().setOpen(false), true`)
  await sleep(300)
  check('开始前终端面板没有打开', (await ev(PANEL)).xterm === 0)

  let during = null
  await turn('TERMINAL 场景', {
    timeout: 90000,
    during: async () => {
      for (let i = 0; i < 100 && !during; i++) {
        const panel = await ev(PANEL)
        if (panel.badge) {
          during = panel
          await sleep(300)
          await shot('during')
        } else await sleep(100)
      }
    }
  })
  await sleep(2000)
  const after = await ev(PANEL)
  const outputs = await ev(TOOL_OUTPUTS)
  report.normal = { during: during && { ...during, text: undefined }, after: { ...after, text: undefined }, outputs }
  log('normal', report.normal)
  await shot('after')
  check('agent 操作时终端面板自动打开并显示 Agent 正在操作', !!during && during.xterm > 0, during && { xterm: during.xterm, tabs: during.tabs })
  check('操作结束后提示消失', !after.badge)
  check('三次调用复用同一个终端（只有一个标签）', after.tabs === 1, after.tabs)
  const [first, second, listed] = outputs
  check('第一次 run 新开终端并跑完', first?.ok && first.state === 'completed' && first.created === true && /agent-terminal-ok/.test(first.output), first)
  check('第二次 run 复用终端、等到慢命令结束', second?.ok && second.state === 'completed' && second.created === false && second.id === first?.id && /slow-done/.test(second.output), second)
  check('输出已渲染：从提示符和命令开始，开头没有空行', second?.ok && /^PS .*> Start-Sleep/.test(second.output), second?.output?.slice(0, 120))
  check('list 能看到这个终端', listed?.ok && listed.count === 1, listed)
  check('终端里能看到 agent 输入的命令', /agent-terminal-ok/.test(after.text) && /slow-done/.test(after.text))

  const answer = async (choice) => {
    let card = null
    for (let i = 0; i < 100 && !card; i++) {
      card = await ev(`(() => { const a = window.__yanStore.getState().approvals.find((x) => x.phase !== 'resolved'); return a ? { id: a.id, tool: a.tool, detail: a.detail, reasons: a.reasons } : null })()`)
      if (!card) await sleep(100)
    }
    if (!card) return null
    await shot(`approval-${choice}`)
    const textBefore = (await ev(PANEL)).text
    await ev(`window.__yanStore.getState().answerApproval(${JSON.stringify(card.id)}, ${JSON.stringify(choice)})`)
    return { ...card, writtenBeforeAnswer: textBefore.includes('InkstoneTerminalApproval') }
  }

  const cards = []
  let denied = null
  await turn('TERMINAL DANGER 拒绝', { timeout: 60000, during: async () => { denied = await answer('deny'); cards.push(denied) } })
  await sleep(800)
  const deniedOutput = (await ev(TOOL_OUTPUTS)).at(-1)
  report.denied = { card: denied, output: deniedOutput }
  log('denied', report.denied)
  check('危险命令弹出宿主审批卡，内容是终端里真正要执行的命令', denied?.tool === 'terminal' && /^reg delete/.test(denied.detail), denied)
  check('批准前没有写入终端', denied && !denied.writtenBeforeAnswer)
  check('拒绝后 agent 收到 terminal_blocked', deniedOutput && !deniedOutput.ok && deniedOutput.code === 'terminal_blocked', deniedOutput)
  check('拒绝后终端里没有这条命令', !(await ev(PANEL)).text.includes('InkstoneTerminalApproval'))

  let allowed = null
  let extra = null
  await turn('TERMINAL DANGER 允许', {
    timeout: 60000,
    during: async () => {
      allowed = await answer('once')
      await sleep(1500)
      extra = await ev(`window.__yanStore.getState().approvals.filter((x) => x.phase !== 'resolved').length`)
    }
  })
  await sleep(1000)
  const allowedOutput = (await ev(TOOL_OUTPUTS)).at(-1)
  const finalText = (await ev(PANEL)).text
  report.allowed = { card: allowed, extraCards: extra, output: allowedOutput }
  log('allowed', report.allowed)
  await shot('allowed')
  check('允许后不再弹第二张审批卡', extra === 0, extra)
  check('允许后命令在终端里执行并返回', allowedOutput?.ok && allowedOutput.state === 'completed' && /reg delete/.test(allowedOutput.output), allowedOutput)
  check('命令只执行了一次', finalText.split('\n').filter((line) => line.includes('reg delete')).length <= 1)
}
