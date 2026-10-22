;(async () => {
  const out = []
  const ok = (condition, text) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore

  const send = async (text) => {
    const ta = q('[data-testid="composer-input"]')
    if (!ta) throw new Error('找不到输入框')
    window.__yanComposer.set(text, ta)
    await sleep(200)
    const button = q('[data-testid="composer-send"]')
    if (!button || button.disabled) throw new Error('发送键不可用')
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(3000)
  }
  const settle = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    let idleSince = 0
    while (Date.now() < deadline) {
      const state = store.getState()
      const live = (state.subagents ?? []).some((run) => run.status === 'starting' || run.status === 'running')
      const busy = state.session?.isAgentRunning || state.session?.isStreaming || live
      if (busy) idleSince = 0
      else if (!idleSince) idleSince = Date.now()
      else if (Date.now() - idleSince > 30_000) return true
      await sleep(2000)
    }
    return false
  }
  const lastAnswer = () => {
    const answers = [...document.querySelectorAll('.v3-msg.assistant .v3-prose')].map((e) => e.textContent.trim()).filter(Boolean)
    return answers[answers.length - 1] ?? ''
  }

  try {
    for (let i = 0; i < 120; i++) {
      if (store?.getState().settings && store.getState().session?.sessionId && q('[data-testid="composer-input"]')) break
      await sleep(250)
    }
    out.push('=== 深度模式审查砚的代码（真实模型）===')
    await store.getState().setUltracode(true)
    await sleep(500)
    ok(store.getState().session?.ultracode === true, '会话已开启深度模式')
    const started = Date.now()
    await send('审查 yan-snapshot/ 里砚的子代理子系统：src/main/subagents.ts、subagent-service.ts、subagent-fork.ts、subagent-isolation.ts、subagent-notify.ts、subagent-history.ts、src/main/runs/subagent.ts，以及它们直接调用的代码。重点找真实的 bug：并发与竞态、超时和取消、进程与资源泄漏、续接和 fork 的状态一致性、错误被吞掉。只读审查，不要修改任何文件。最后给我一份按严重程度排序的问题清单，每条写明文件:行、触发条件、后果，并标明是否已经核实。')
    ok(await settle(60 * 60_000), '任务与全部子 Agent 在 60 分钟内结束')
    out.push(`  总耗时：${Math.round((Date.now() - started) / 1000)} 秒`)

    const runs = store.getState().subagents ?? []
    out.push(`  子 Agent 数：${runs.length}`)
    for (const run of runs) {
      out.push(`  - ${JSON.stringify({ id: run.id, title: run.title ?? run.task?.slice(0, 60), readOnly: run.isolation === 'controlled-cwd', isolation: run.isolation, status: run.status, model: run.model, secs: run.endedAt ? Math.round((run.endedAt - run.startedAt) / 1000) : null, tools: run.toolCalls, usage: run.usage ?? null, start: Math.round((run.startedAt - started) / 1000) })}`)
    }
    out.push(`  SESSION_ID=${store.getState().session?.sessionId ?? ''}`)
    out.push('  模型最终回答: ' + JSON.stringify(lastAnswer().slice(0, 6000)))
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
