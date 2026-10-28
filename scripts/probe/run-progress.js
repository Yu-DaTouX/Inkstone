;(async () => {
  const out = []
  const ok = (c, s, detail) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (detail !== undefined && !c ? '  ' + JSON.stringify(detail) : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => document.querySelector(sel)
  const store = window.__yanStore
  const st = () => store.getState()

  const baseSession = () => ({ ...(st().session ?? {}) })
  const user = { id: 'rp-u', role: 'user', text: '跑一下', timestamp: Date.now() - 5000 }
  const assistant = (over = {}) => ({ id: 'rp-a', role: 'assistant', text: '', ...over })
  const runningTool = {
    id: 'rp-tc',
    name: 'read',
    args: { path: 'src/rp-probe.ts' },
    status: 'running',
    startedAt: Date.now() - 1000
  }
  const setTurn = (sessionPatch, messages) =>
    store.setState({ session: { ...baseSession(), ...sessionPatch }, messages })
  const line = () => q('[data-testid="v3-turn-activity"][data-working]')
  const kind = () => line()?.getAttribute('data-working') ?? null
  const text = () => line()?.querySelector('.v3-act-text')?.textContent ?? ''
  const border = () => q('[data-testid="composer-border"]')?.getAttribute('data-phase') ?? null

  const waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (pred()) return true
      await sleep(50)
    }
    return !!pred()
  }
  const waitKind = (want, ms) => waitFor(() => kind() === want, ms)

  const original = { session: baseSession(), messages: st().messages }

  try {
    for (let i = 0; i < 60; i++) {
      if (st().conn === 'ready' && st().settings) break
      await sleep(400)
    }

    out.push('=== 0. 刚发出、还没有助手消息 ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [user])
    ok(await waitKind('sending'), '工作行为 sending（请求还没到模型）', kind())
    ok(/发送|Sending/.test(text()), '文案写正在发送', text())

    out.push('')
    out.push('=== 1. 已请求模型、还没输出 ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [user, assistant()])
    ok(await waitKind('working'), '工作行为 working（等待模型继续，不再停在发送）', kind())
    ok(/处理中|Working/.test(text()) && !/发送|Sending/.test(text()), '文案与发送阶段区分开', text())
    ok(border() === 'running', '输入框边框 data-phase 为 running', border())

    out.push('')
    out.push('=== 2. 有工具在跑 ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [
      user,
      assistant({ toolCalls: [runningTool] })
    ])
    ok(await waitKind('tool'), '工作行为 tool', kind())
    ok(line()?.getAttribute('data-quiet') === 'true', '工具运行时工作行让位给工具行（data-quiet）', line()?.getAttribute('data-quiet'))
    const step = await waitFor(() => !!q('.v3-step[data-tool="read"][data-state="running"]'))
    ok(step, '运行中的工具行可见')
    ok(/rp-probe\.ts/.test(q('.v3-step[data-tool="read"]')?.textContent ?? ''), '工具行带出读取目标', q('.v3-step[data-tool="read"]')?.textContent)

    out.push('')
    out.push('=== 3. 收到可见思考流 ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [
      user,
      assistant({ thinking: '先看一下', thinkingLive: true })
    ])
    ok(await waitKind('thinking'), '工作行为 thinking', kind())
    ok(line()?.getAttribute('data-quiet') === 'true' && /进行中|In progress/.test(text()), '推理文字已在每轮过程里显示，工作行转为安静的「进行中」', text())

    out.push('')
    out.push('=== 4. 没有可见 thinking 就不假装在推理 ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [user, assistant({ thinking: '旧的一轮' })])
    ok(await waitFor(() => kind() !== 'thinking', 1000), 'thinkingLive 为假时立即不再显示思考中', kind())
    ok(kind() === 'thought' && /已思考|Thought/.test(text()), '先短暂显示「已思考 N 秒」', kind() + ' ' + text())
    let sawThinking = false
    const settled = await waitFor(() => {
      if (kind() === 'thinking') sawThinking = true
      return kind() === 'working'
    }, 4500)
    ok(settled && !sawThinking, '停留结束后回到 working，不再回到思考中', kind())

    out.push('')
    out.push('=== 5. 正文在流 ===')
    setTurn({ isAgentRunning: true, isStreaming: true }, [user, assistant({ text: '正在写' })])
    ok(await waitKind('responding'), '工作行为 responding', kind())
    ok(border() === 'responding', '输入框边框 data-phase 为 responding', border())

    out.push('')
    out.push('=== 6. 工具结束后回到等待模型（不是停在 tool） ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [
      user,
      assistant({ text: '', toolCalls: [{ ...runningTool, status: 'ok', endedAt: Date.now() }] })
    ])
    ok(await waitKind('working'), '工具结束后回到 working', kind())

    out.push('')
    out.push('=== 6b. 压缩上下文：独立于回合，运行条要写「压缩中」 ===')
    setTurn(
      {
        isAgentRunning: false,
        isStreaming: true,
        isCompacting: true,
        compaction: { status: 'running', reason: 'manual', startedAt: Date.now() - 2000 }
      },
      [user, assistant({ text: '上一轮的回复' })]
    )
    const marker = () => q('[data-testid="v3-compaction-marker"][data-running="1"]')
    ok(await waitFor(() => !!marker()), '压缩进行中显示压缩标记（没有 agent_start 也有）')
    ok(/压缩|Compact/.test(marker()?.textContent ?? '') && !line(), '只留压缩标记一条提示，工作行不再重复写压缩', `${kind()} ${marker()?.textContent ?? ''}`)
    ok(border() === 'compacting', '输入框边框 data-phase 为 compacting', border())

    out.push('')
    out.push('=== 7. 回合结束后整条状态收起 ===')
    setTurn({ isAgentRunning: false, isStreaming: false, isCompacting: false, compaction: undefined }, [
      user,
      assistant({ text: '好了' })
    ])
    await sleep(400)
    ok(!line(), '不在跑的时候不再显示工作行')
    ok(border() === 'idle', 'data-phase 回到 idle', border())
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  } finally {
    store.setState(original)
  }

  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[run-progress] 全部通过' : '[run-progress] ' + failed + ' 条失败')
  return out.join('\n')
})()
