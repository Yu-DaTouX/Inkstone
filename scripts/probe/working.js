;(async () => {
  const out = []
  const ok = (condition, label, detail = '') => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
    return Boolean(condition)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore
  const working = () => q('[data-testid="v3-turn-activity"][data-kind="run"]')
  const workingText = () => working()?.textContent ?? ''
  const border = () => q('[data-testid="composer-border"]')
  const runningTool = (tool) =>
    [q(`.v3-step[data-state="running"][data-tool="${tool}"]`), q('[data-testid="v3-process"] .v3-process-label')]
      .find((el) => (el?.textContent ?? '').includes(tool))
  const user = { id: 'working-probe-u', role: 'user', text: '跑一下', timestamp: Date.now() - 3000 }
  const setState = (sessionPatch, assistant) => {
    store.setState({
      session: { ...(store.getState().session ?? {}), isAgentRunning: false, isStreaming: false, ...sessionPatch },
      messages: assistant ? [user, { id: 'working-probe-a', role: 'assistant', text: '', timestamp: Date.now(), ...assistant }] : [user]
    })
  }
  const until = async (check, ms = 3000) => {
    const started = Date.now()
    while (Date.now() - started < ms) {
      if (check()) return true
      await sleep(50)
    }
    return Boolean(check())
  }

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 60; i++) {
    if (q('[data-testid="composer-input"]') && store?.getState().settings) break
    await sleep(250)
  }
  const original = { session: store.getState().session, messages: store.getState().messages }
  out.push('=== 回合提示：阶段来自运行事件，工具等待期间常驻 ===')

  try {
    setState({ isStreaming: true, isAgentRunning: true }, { text: '流式输出' })
    ok(await until(() => !!working()), '流式输出时提示常驻')
    ok(border()?.dataset.state === 'working', '正文流时输入框顶边处于忙碌态', border()?.dataset.phase ?? '')
    ok(await until(() => workingText().includes('生成回复')), '正文流文案反映真实阶段', workingText())

    setState({ isStreaming: false, isAgentRunning: true }, {
      toolCalls: [{ id: 'working-probe', name: 'bash', args: { command: 'echo probe' }, status: 'running' }]
    })
    ok(await until(() => !!working()), '工具执行期间（isStreaming=false）提示仍然常驻')
    ok(border()?.dataset.state === 'working', '工具等待时输入框顶边仍处于忙碌态', border()?.dataset.phase ?? '')
    ok(await until(() => !!runningTool('bash')), '运行中的过程行带真实工具名', runningTool('bash')?.textContent ?? '')

    setState({ isStreaming: false, isAgentRunning: true }, { thinking: '再想想', thinkingLive: true })
    ok(await until(() => !!working()), '再次思考时提示还在')
    ok(await until(() => workingText().includes('思考中')), '可见思考流显示思考阶段', workingText())

    setState({ isStreaming: false, isAgentRunning: false }, { text: '完成' })
    ok(await until(() => !working()), '回合结束后提示消失')
    ok(border()?.dataset.state === 'idle', 'idle 状态不保留忙碌标记')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  } finally {
    store.setState(original)
  }

  return out.join('\n')
})()
