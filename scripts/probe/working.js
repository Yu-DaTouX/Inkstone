/**
 * 模型工作时的「正在处理」提示必须**常驻**（用户报「一闪一闪」）。
 *
 * 根因：输入框顶边框的状态只看 `session.isStreaming`，而它在**工具执行期间
 * 是 false**（每条 assistant 消息结束就清）。于是模型调工具的那几秒里动画和
 * 文案整条消失，工具跑完又冒出来。
 *
 * 修法：跟回合级信号 `isAgentRunning`（agent_start → agent_settled，覆盖工具
 * 执行）走。这个探针直接注入 session 状态，逐一验证四种组合。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  localStorage.setItem('yan.onboarded', '1')

  const setState = (patch) => {
    const s = store.getState().session
    store.setState({ session: { ...(s ?? {}), isCompacting: false, ...patch } })
  }

  const working = () => q('[data-testid="working"]')

  out.push('=== 处理中提示：覆盖整个 agent 回合，不闪 ===')

  // 1. 纯流式（文本在流）
  setState({ isStreaming: true, isAgentRunning: true })
  await sleep(300)
  ok(!!working(), '流式输出时提示常驻')

  // 2. 工具执行中：isStreaming=false，但 isAgentRunning=true —— 这是原来会消失的时刻
  setState({ isStreaming: false, isAgentRunning: true })
  await sleep(300)
  ok(!!working(), '工具执行期间（isStreaming=false）提示仍然常驻 —— 修的就是这里')
  ok(
    (working()?.textContent ?? '').includes('正在处理'),
    `提示文案正确：「${working()?.textContent ?? ''}」`
  )

  // 3. 中途再思考（仍是同一个回合）
  setState({ isStreaming: true, isAgentRunning: true })
  await sleep(300)
  ok(!!working(), '再次思考时提示还在')

  // 4. 回合真正结束 → 消失
  setState({ isStreaming: false, isAgentRunning: false })
  await sleep(300)
  ok(!working(), '回合结束后提示消失（不留残影）')

  // 5. 压缩时显示的是压缩文案（优先级更高）
  store.setState({
    session: { ...(store.getState().session ?? {}), isStreaming: false, isAgentRunning: false, isCompacting: true }
  })
  await sleep(300)
  ok(!!q('[data-state="compacting"]'), '压缩中走独立的 compacting 状态')
  store.setState({
    session: { ...(store.getState().session ?? {}), isCompacting: false }
  })

  return out.join('\n')
})()
