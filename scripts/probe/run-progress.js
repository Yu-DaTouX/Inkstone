/*
 * 运行阶段显示（实施-21 P1/P2）的 cost 0 覆盖。
 *
 * 不真跑模型：直接注入 store 快照（running / streaming / 正在跑的 toolCall /
 * 可见思考流 thinkingLive），断言输入框顶边框真的写出对应阶段，
 * 且没有可见 thinking 时**不**出现「正在推理」。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
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
    args: {},
    status: 'running'
  }
  const setTurn = (sessionPatch, messages) =>
    store.setState({ session: { ...baseSession(), ...sessionPatch }, messages })
  const phase = () => q('[data-testid="composer-border"]')?.getAttribute('data-phase')
  const text = () => q('[data-testid="working"]')?.textContent ?? ''

  const waitPhase = async (want, ms = 3000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (phase() === want) return true
      await sleep(50)
    }
    return phase() === want
  }

  const original = { session: baseSession(), messages: st().messages }

  try {
    for (let i = 0; i < 60; i++) {
      if (st().conn === 'ready' && st().settings) break
      await sleep(400)
    }

    out.push('=== 1. 已请求模型、还没输出 ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [user, assistant()])
    ok(await waitPhase('requesting'), '阶段为 requesting（等待模型继续）', phase())
    ok(/等待模型|Waiting/.test(text()), '文案不是笼统的「正在处理」', text())

    out.push('')
    out.push('=== 2. 有工具在跑 ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [
      user,
      assistant({ toolCalls: [runningTool] })
    ])
    ok(await waitPhase('tool'), '阶段为 tool')
    ok(/read/.test(text()), '文案里带出工具名', text())

    out.push('')
    out.push('=== 3. 收到可见思考流 ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [
      user,
      assistant({ thinking: '先看一下', thinkingLive: true })
    ])
    ok(await waitPhase('thinking'), '阶段为 thinking')

    out.push('')
    out.push('=== 4. 没有可见 thinking 就不假装在推理 ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [user, assistant({ thinking: '旧的一轮' })])
    ok((await waitPhase('requesting')) && phase() !== 'thinking', 'thinkingLive 为假时回到 requesting')

    out.push('')
    out.push('=== 5. 正文在流 ===')
    setTurn({ isAgentRunning: true, isStreaming: true }, [user, assistant({ text: '正在写' })])
    ok(await waitPhase('responding'), '阶段为 responding')

    out.push('')
    out.push('=== 6. 工具结束后回到等待模型（不是停在 tool） ===')
    setTurn({ isAgentRunning: true, isStreaming: false }, [
      user,
      assistant({ text: '', toolCalls: [{ ...runningTool, status: 'ok', endedAt: Date.now() }] })
    ])
    ok(await waitPhase('requesting'), '工具结束后回到 requesting', phase())

    out.push('')
    out.push('=== 7. 回合结束后整条状态收起 ===')
    setTurn({ isAgentRunning: false, isStreaming: false }, [user, assistant({ text: '好了' })])
    await sleep(400)
    ok(!q('[data-testid="working"]'), '不在跑的时候不再显示工作状态')
    ok(phase() === 'idle', 'data-phase 回到 idle', String(phase()))
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  } finally {
    store.setState(original)
  }

  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[run-progress] 全部通过' : '[run-progress] ' + failed + ' 条失败')
  return out.join('\n')
})()
