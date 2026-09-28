/**
 * 回合提示必须覆盖模型流与工具等待两个阶段，文案由实际运行事件推导。
 */
;(async () => {
  const out = []
  const ok = (condition, label, detail = '') => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
    return Boolean(condition)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore
  const working = () => q('[data-testid="working"]')
  const setState = (sessionPatch, messages = []) => {
    store.setState({
      session: { ...(store.getState().session ?? {}), isAgentRunning: false, isStreaming: false, ...sessionPatch },
      messages
    })
  }

  localStorage.setItem('yan.onboarded', '1')
  out.push('=== 回合提示：阶段来自运行事件，工具等待期间常驻 ===')

  setState({ isStreaming: true, isAgentRunning: true }, [
    { role: 'assistant', content: '流式输出', timestamp: Date.now() }
  ])
  await sleep(300)
  ok(!!working(), '流式输出时提示常驻')
  ok(q('[data-testid="composer-border"]')?.dataset.phase === 'responding', '正文流显示 responding 阶段')
  ok((working()?.textContent ?? '').includes('正在生成回复'), '正文流文案反映真实阶段', working()?.textContent ?? '')

  setState({ isStreaming: false, isAgentRunning: true }, [
    { role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [{ id: 'working-probe', name: 'bash', arguments: {}, status: 'running' }] }
  ])
  await sleep(300)
  ok(!!working(), '工具执行期间（isStreaming=false）提示仍然常驻')
  ok(q('[data-testid="composer-border"]')?.dataset.phase === 'tool', '工具等待显示 tool 阶段')
  ok((working()?.textContent ?? '').includes('正在bash'), '提示文案带真实工具名', working()?.textContent ?? '')

  setState({ isStreaming: false, isAgentRunning: true }, [
    { role: 'assistant', content: '', timestamp: Date.now(), thinkingLive: true }
  ])
  await sleep(300)
  ok(!!working(), '再次思考时提示还在')
  ok(q('[data-testid="composer-border"]')?.dataset.phase === 'thinking', '可见思考流显示 thinking 阶段')

  setState({ isStreaming: false, isAgentRunning: false })
  await sleep(300)
  ok(!working(), '回合结束后提示消失')
  ok(q('[data-testid="composer-border"]')?.dataset.state === 'idle', 'idle 状态不保留忙碌标记')

  return out.join('\n')
})()
