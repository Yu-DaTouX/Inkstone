;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const early = (msg) => {
    out.push(msg)
    return out.join('\n')
  }
  if (!store) return early('  ⤺ 跳过：没有 window.__yanStore（探针没被注入）')

  const setValue = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const pressEnter = (el) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

  const pending = () => store.getState().pendingSends ?? []
  const cards = () => qa('[data-testid="queue-pending"]')
  const pendingRun = () => !!store.getState().runners.find(
    (r) => (r.runId ?? r.id) === store.getState().activeRunnerId
  )?.running

  const runner = (running, streaming) => ({
    id: 'probe-run-1',
    runId: 'probe-run-1',
    sessionFile: 'probe-pending.jsonl',
    sessionId: 'probe-pending',
    projectId: undefined,
    generation: 1,
    cwd: 'C:/yan-probe',
    running,
    waiting: false,
    failed: false,
    conn: 'ready',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    isActive: true,
    isStreaming: streaming
  })

  const sent = []
  let sendOk = true

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      if (q('[data-testid="composer"]') && store.getState().settings) break
      await sleep(250)
    }

    const injected = q('[data-testid="composer"]')
    if (!injected) return early('  ⤺ 跳过：输入框还没挂载')
    injected.id = 'probe-composer'

    store.setState({
      send: async (text, images, mode) => {
        sent.push({ text, mode, images: images?.length ?? 0 })
        return sendOk
      }
    })

    const idle = () => {
      store.setState({ activeRunnerId: null, runners: [] })
    }
    const busy = (streaming = true) => {
      store.setState({ activeRunnerId: 'probe-run-1', runners: [runner(true, streaming)] })
    }

    out.push('=== 1. 回合没跑：Enter 直接发送（不经过待定区） ===')
    idle()
    await sleep(120)
    setValue(q('#probe-composer'), 'YAN-PENDING-DIRECT')
    await sleep(120)
    pressEnter(q('#probe-composer'))
    await sleep(250)
    out.push(`  投递记录 = ${JSON.stringify(sent)}`)
    ok(sent.length === 1 && sent[0].text === 'YAN-PENDING-DIRECT', '空闲时 Enter 直接投出去')
    ok(sent[0]?.mode === undefined, '空闲投递不带 streamingBehavior（由主进程忽略）')
    ok(pending().length === 0, '空闲时不进待定区')
    ok(cards().length === 0, '空态下没有待定卡片')

    out.push('')
    out.push('=== 2. 运行时 Enter 默认排队 ===')
    sent.length = 0; busy(); await sleep(120)
    setValue(q('#probe-composer'), 'YAN-DEFAULT-QUEUE'); await sleep(120)
    pressEnter(q('#probe-composer')); await sleep(300)
    ok(sent.length === 1 && sent[0].mode === 'followUp', '生成时默认以 followUp 排队')
    ok(pending().length === 0 && cards().length === 0, '默认排队不再生成待定卡片')
    ok(q('#probe-composer').value === '', '输入框清空，可继续输入')
    out.push('=== 3. 显式待定消息仍支持插话 ===')
    sent.length = 0; store.getState().holdSend('YAN-PENDING-HOLD'); await sleep(150)
    click(q('[data-testid="pending-steer"]')); await sleep(300)
    ok(sent.length === 1 && sent[0].mode === 'steer', '显式插话以 steer 投递')
    out.push('=== 4. 点「排队」：以 followUp 投递 ===')
    sent.length = 0
    store.getState().holdSend('YAN-PENDING-QUEUE')
    await sleep(200)
    ok(pending().length === 1, '再来一条待定消息')
    click(q('[data-testid="pending-follow"]'))
    await sleep(300)
    out.push(`  投递记录 = ${JSON.stringify(sent)}`)
    ok(sent[0]?.mode === 'followUp', '投递方式 = followUp（排队）')

    out.push('')
    out.push('=== 5. 点「撤回」：不投递，文字回到输入框 ===')
    sent.length = 0
    store.setState({ queueRestore: null })
    store.getState().holdSend('YAN-PENDING-RESTORE')
    await sleep(200)
    const beforeRetract = sent.length
    click(q('[data-testid="pending-restore"]'))
    await sleep(300)
    out.push(
      `  投递记录 = ${JSON.stringify(sent)} · 输入框 = ${JSON.stringify(q('#probe-composer').value)}`
    )
    ok(sent.length === beforeRetract, '撤回**不**投递')
    ok(pending().length === 0, '卡片消失')
    ok(q('#probe-composer').value.includes('YAN-PENDING-RESTORE'), '文字回到输入草稿')
    setValue(q('#probe-composer'), '')

    out.push('')
    out.push('=== 6. 判据是回合级，不是 isStreaming ===')
    store.setState({
      activeRunnerId: 'probe-run-1',
      runners: [runner(true, false)],
      session: { ...(store.getState().session ?? {}), isStreaming: false }
    })
    await sleep(150)
    ok(!store.getState().session?.isStreaming, '构造出「回合在跑但 isStreaming=false」的窗口')
    out.push(`  store 的 running = ${pendingRun()}`)
    sent.length = 0
    setValue(q('#probe-composer'), 'YAN-PENDING-TOOLWINDOW')
    await sleep(120)
    pressEnter(q('#probe-composer'))
    await sleep(300)
    ok(pending().length === 0, '工具执行期间 Enter 不产生待定卡片')
    ok(sent.length === 1 && sent[0].mode === 'followUp', '工具执行期间默认排队')
    await sleep(200)
    setValue(q('#probe-composer'), '')

    out.push('')
    out.push('=== 7. 回合结束后自动按「排队」投出去（不丢消息） ===')
    sent.length = 0
    store.getState().holdSend('YAN-PENDING-AUTO')
    await sleep(150)
    ok(pending().length === 1, '先悬起来一条')
    idle()
    for (let i = 0; i < 30 && sent.length === 0; i++) await sleep(150)
    out.push(`  投递记录 = ${JSON.stringify(sent)} · 剩余待定 = ${pending().length}`)
    ok(sent.length === 1 && sent[0].text === 'YAN-PENDING-AUTO', '回合结束后自动投递')
    ok(sent[0]?.mode === 'followUp', '按「排队」语义投递（此时插话已无意义）')
    ok(pending().length === 0, '投完卡片消失')

    out.push('')
    out.push('=== 8. 投递失败：卡片留在原地，不假装成功 ===')
    sent.length = 0
    sendOk = false
    busy()
    await sleep(150)
    store.getState().holdSend('YAN-PENDING-FAIL')
    await sleep(200)
    ok(pending().length === 1, '悬起来一条')
    click(q('[data-testid="pending-steer"]'))
    await sleep(300)
    out.push(`  投递尝试 = ${JSON.stringify(sent)} · 剩余待定 = ${pending().length}`)
    ok(sent.length === 1, '确实尝试过投递')
    ok(pending().length === 1, '失败时卡片**留在原地**（用户能重试或撤回，而不是默默丢消息）')
    ok(!!q('[data-testid="pending-steer"]'), '按钮还在，可以再试一次')

    out.push('')
    out.push('=== 9. 自动压缩期间：也要能发消息（进待定区，不丢草稿） ===')
    sent.length = 0
    idle()
    sendOk = true
    for (const leftover of pending()) store.getState().restoreSend(leftover.id)
    await sleep(200)
    setValue(q('#probe-composer'), '')
    const curSession = store.getState().session
    if (!curSession) {
      out.push('  ✗ 前置不成立：本场景没有活动会话，摆不出压缩态')
    } else {
      store.setState({ session: { ...curSession, isCompacting: true } })
      await sleep(200)
      ok(!pendingRun(), '前提：runner.running 为 false（压缩发生在回合之间）')
      ok(!!store.getState().session?.isCompacting, '前提：session.isCompacting 为 true')
      setValue(q('#probe-composer'), 'YAN-PENDING-COMPACT')
      await sleep(120)
      pressEnter(q('#probe-composer'))
      await sleep(300)
      out.push(`  投递记录 = ${JSON.stringify(sent)} · 待定 = ${pending().length}`)
      ok(sent.length === 0, '压缩期间不直接投递（投出去会被 pi 拒，草稿还会丢）')
      ok(pending().length === 1, '消息进了待定区（“仍要允许用户发送消息”）')
      ok(cards().length === 1, '界面上看得见这条待投递消息')
      ok(q('#probe-composer').value === '', '输入框被清空，可以接着打下一条')
      store.setState({ session: { ...store.getState().session, isCompacting: false } })
      await sleep(500)
      out.push(`  压缩结束后自动投递 = ${JSON.stringify(sent)}`)
      ok(
        sent.length === 1 && sent[0].mode === 'followUp',
        '压缩结束后自动按「排队」投出去（不丢消息）'
      )
      ok(pending().length === 0, '待定区清空')
    }

    out.push('')
    out.push('=== 10. 收尾：清掉探针造的状态 ===')
    sendOk = true
    if (pending().length) store.getState().restoreSend(pending()[0].id)
    await sleep(150)
    setValue(q('#probe-composer'), '')
    idle()
    await sleep(150)
    ok(pending().length === 0, '待定区清空')
    ok(qa('[data-testid="queue-pending"]').length === 0, '界面上没有残留卡片')
  } catch (error) {
    out.push('  ✗ 探针异常：' + (error && error.stack ? error.stack : String(error)))
  }

  return out.join('\n')
})()
