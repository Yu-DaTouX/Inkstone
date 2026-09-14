/**
 * 性能实测（方案 P2 第 5.2 节要求「先测量，再决定」）。
 *
 * 测三件在长会话里最容易变成卡顿的事：
 *   ① 流式更新：每次 delta 都会重算回合分组 + 重渲染，历史回合会不会跟着白跑
 *   ② 左右栏收放：grid 列宽变化会不会让整段对话重排（这是最贵的）
 *   ③ 虚拟化的窗口：长会话里实际挂了多少 DOM 节点
 *
 * ⚠️ 阈值写得**宽松** —— 这台机器上跑，负载会飘。
 *    它的价值在于「同一台机器、改动前后的对比」，不是绝对门限。
 *    测出来的数字会打出来，判失败的只是「明显不合理」的那种（比如秒级）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const q = (s) => document.querySelector(s)

  /** 跑 n 次取中位数与最大值 —— 单次测量在负载下没意义 */
  const stats = (arr) => {
    const s = [...arr].sort((a, b) => a - b)
    return { med: s[Math.floor(s.length / 2)] ?? 0, max: s[s.length - 1] ?? 0 }
  }
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()))

  const N = 240

  try {
    /* ---- 准备：一条长会话 ---- */
    const fake = []
    for (let i = 0; i < N; i++) {
      if (i % 3 === 0) fake.push({ id: 'p' + i, role: 'user', text: '第 ' + i + ' 条用户消息' })
      else if (i % 3 === 1)
        fake.push({
          id: 'p' + i,
          role: 'assistant',
          text: '第 ' + i + ' 条回复\n\n- 要点\n\n```bash\necho ' + i + '\n```',
          usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.0001 }
        })
      else
        fake.push({
          id: 'p' + i,
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'pc' + i, name: 'bash', args: { command: 'echo ' + i }, status: 'ok', output: 'x\n' }]
        })
    }
    store.getState().applyPush({ ch: 'sync', payload: fake })
    for (let i = 0; i < 40; i++) {
      if (document.querySelectorAll('.stream-row').length > 0) break
      await sleep(250)
    }
    const rows = document.querySelectorAll('.stream-row').length
    out.push(`=== 环境 ===`)
    out.push(`  消息 ${store.getState().messages.length} 条 / 虚拟化挂载 ${rows} 个回合节点`)

    /* ---- ① 流式更新 ---- */
    out.push('')
    out.push('=== ① 流式更新（每次 delta 重算分组 + 重渲染）===')
    const streamSamples = []
    for (let i = 1; i <= 30; i++) {
      const t0 = performance.now()
      const msgs = store.getState().messages.slice()
      const last = msgs[msgs.length - 1]
      msgs[msgs.length - 1] = { ...last, text: 'x'.repeat(i * 30) }
      /* 让最后一条处于「流式中」—— 这才是真实情况（turns 会重算） */
      store.setState({ messages: msgs, session: { ...(store.getState().session ?? {}), isStreaming: true } })
      await frame()
      streamSamples.push(performance.now() - t0)
    }
    const st = stats(streamSamples)
    out.push(`  30 次更新：中位 ${st.med.toFixed(1)}ms  最大 ${st.max.toFixed(1)}ms`)
    ok(st.med < 50, `单次流式更新中位 < 50ms（实测 ${st.med.toFixed(1)}ms）`)
    ok(st.max < 400, `最坏一次 < 400ms（实测 ${st.max.toFixed(1)}ms）`)

    /* ---- ② 左右栏收放 ---- */
    out.push('')
    out.push('=== ② 面板收放（grid 列宽变化 → 对话重排）===')
    const panelSamples = []
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now()
      await store.getState().toggleRightPanel()
      await frame()
      panelSamples.push(performance.now() - t0)
    }
    const sp = stats(panelSamples)
    out.push(`  切换 6 次：中位 ${sp.med.toFixed(1)}ms  最大 ${sp.max.toFixed(1)}ms`)
    ok(sp.med < 250, `右栏收放中位 < 250ms（实测 ${sp.med.toFixed(1)}ms）`)

    const railSamples = []
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now()
      store.getState().setRailPinned(i % 2 === 0)
      await frame()
      railSamples.push(performance.now() - t0)
    }
    const sr = stats(railSamples)
    out.push(`  左栏收放 6 次：中位 ${sr.med.toFixed(1)}ms  最大 ${sr.max.toFixed(1)}ms`)
    ok(sr.med < 250, `左栏收放中位 < 250ms（实测 ${sr.med.toFixed(1)}ms）`)

    /* ---- ③ 虚拟化窗口 ---- */
    out.push('')
    out.push('=== ③ 虚拟化的窗口大小 ===')
    const dom = document.querySelectorAll('.stream .msg, .stream-row').length
    out.push(`  240 条消息 → DOM 里 ${dom} 个节点`)
    ok(dom > 0 && dom < 60, `窗口化生效（挂载 ${dom} 个，远小于 240）`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
