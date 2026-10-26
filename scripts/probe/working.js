;(async () => {
  const out = []
  const ok = (condition, label, detail = '') => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
    return Boolean(condition)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore
  const working = () => q('[data-testid="v3-turn-activity"][data-kind="run"]:not([data-quiet])')
  const quiet = () => q('[data-testid="v3-turn-activity"][data-quiet]')
  const retrying = () => q('[data-testid="v3-turn-activity"][data-kind="retry"]')
  const border = () => q('[data-testid="composer-border"]')
  const runningTool = (tool, target) =>
    [q(`.v3-step[data-state="running"][data-tool="${tool}"]`), q('[data-testid="v3-process"] .v3-process-label')]
      .find((el) => (el?.textContent ?? '').includes(target))
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
  out.push('=== 工作行：作答与思考时显示阶段与秒数，工具运行时静默占位，重试时显示次数 ===')

  try {
    setState({ isStreaming: true, isAgentRunning: true }, { text: '流式输出' })
    ok(await until(() => border()?.dataset.state === 'working'), '正文流时输入框顶边处于忙碌态', border()?.dataset.phase ?? '')
    ok(await until(() => working()?.dataset.working === 'responding'), '正文流时工作行显示作答阶段', working()?.textContent ?? '')

    setState({ isStreaming: false, isAgentRunning: true }, {
      toolCalls: [{ id: 'working-probe', name: 'bash', args: { command: 'echo probe' }, status: 'running' }]
    })
    ok(await until(() => border()?.dataset.state === 'working'), '工具等待时输入框顶边仍处于忙碌态', border()?.dataset.phase ?? '')
    ok(await until(() => !!quiet() && !working()), '工具执行期间工作行静默占位（运行中的过程行已显示工具）')
    ok(await until(() => !!runningTool('bash', 'echo probe')), '运行中的过程行带真实工具与命令', runningTool('bash', 'echo probe')?.textContent ?? '')

    setState({ isStreaming: false, isAgentRunning: true }, { thinking: '再想想', thinkingLive: true })
    ok(await until(() => !!quiet() && !working()), '再次思考且有实时文字时工作行转为安静状态（不再显示思考阶段）', quiet()?.textContent ?? '')
    ok(await until(() => (quiet()?.textContent ?? '').includes('进行中')), '安静状态写「进行中」而非具体阶段', quiet()?.textContent ?? '')
    ok(await until(() => /\d/.test(quiet()?.textContent ?? '')), '安静状态仍带用时', quiet()?.textContent ?? '')
    ok(await until(() => (q('[data-testid="v3-thinking-body"]')?.textContent ?? '').includes('再想想')), '思考内容在消息里仍可见', q('[data-testid="v3-thinking-body"]')?.textContent ?? '')

    setState({ isStreaming: false, isAgentRunning: true, retry: { attempt: 1, maxAttempts: 3, at: Date.now(), delayMs: 30000, error: 'probe' } }, { text: '' })
    ok(await until(() => !!retrying()), '重试等待时显示活动行')
    ok(!!q('[data-testid="v3-stop-retry"]'), '重试时有停止重试按钮')

    setState({ isStreaming: false, isAgentRunning: false, retry: undefined }, { text: '完成' })
    ok(await until(() => !working() && !retrying() && !quiet()), '回合结束后提示消失')
    ok(border()?.dataset.state === 'idle', 'idle 状态不保留忙碌标记')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  } finally {
    store.setState(original)
  }

  return out.join('\n')
})()
