/**
 * 悬在输入框上方、等着用户决定怎么投递的消息（用户 2026-09-19）。
 *
 * 用户原话：「用户发送的消息默认悬浮在输入框上方 让用户自己选择是插话还是排队」。
 *
 * 在这之前是主进程单方面定默认值（先是 followUp，后来改成 steer）——
 * 用户没有选择权，而且选错了才发现：followUp 那一版里消息半天不出现，
 * 用户去点队列行的「插队 / 撤回」，而 pi 已经在这轮结束时把它收下了，
 * 于是报「消息已被 pi 接收，无法撤回」。
 *
 * ⚠️ 这个探针**不调模型**（cost 0）：把 store 的 `send` 换成桩，只记录
 *    「投递方式（steer / followUp）与调用次数」。真调模型的投递路径
 *    在 `test:live -- queue`（cost 1）里。
 *
 * ⚠️ 判据必须是**回合级**的 `runners[active].running`，不是
 *    `session.isStreaming`：工具执行期间后者是 false，而那正是用户最想
 *    插话的时刻。第 6 节专门钉这条。
 */
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

  /** 用 React 认的方式写进受控输入框 */
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

  /** 回合级的「在跑」标记（RunnerStatus.running = agent_start → agent_settled） */
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

  /* 记录每一次投递：文字 + 投递方式（steer / followUp） */
  const sent = []
  /** 桩的返回可以控制“投递失败”那一支 */
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

    /* 把 send 换成桩：本场景一次模型都不调 */
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
    out.push('=== 2. 回合在跑：Enter 只把消息悬起来 ===')
    sent.length = 0
    busy()
    await sleep(120)
    ok(pendingRun(), '探针先把 activeRunner 置为 running（回合级）')
    setValue(q('#probe-composer'), 'YAN-PENDING-HOLD')
    await sleep(120)
    pressEnter(q('#probe-composer'))
    await sleep(300)
    out.push(`  待定条数 = ${pending().length} · 投递记录 = ${JSON.stringify(sent)}`)
    ok(sent.length === 0, '生成中按 Enter **不**直接投递（这就是用户要的那个“先悬着”）')
    ok(pending().length === 1, '消息进了待定区')
    ok(cards().length === 1, '输入框上方出现待定卡片')
    ok(q('#probe-composer').value === '', '输入框被清空（用户可以接着打下一条）')
    const card = cards()[0]
    ok(!!q('[data-testid="pending-steer"]'), '卡片上有「插话」')
    ok(!!q('[data-testid="pending-follow"]'), '卡片上有「排队」')
    ok(!!q('[data-testid="pending-restore"]'), '卡片上有「撤回」')
    out.push(`  卡片文字 = ${JSON.stringify((card?.textContent ?? '').trim())}`)

    out.push('')
    out.push('=== 3. 点「插话」：以 steer 投递 ===')
    click(q('[data-testid="pending-steer"]'))
    await sleep(300)
    out.push(`  投递记录 = ${JSON.stringify(sent)}`)
    ok(sent.length === 1 && sent[0].text === 'YAN-PENDING-HOLD', '消息被投出去了一次')
    ok(sent[0]?.mode === 'steer', '投递方式 = steer（插话）')
    ok(pending().length === 0, '投出去之后卡片消失')

    out.push('')
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
    /*
     * 工具执行期间 `session.isStreaming` 是 false（每条 assistant 消息
     * message_end 就清掉），但 pi 仍然不接受不带 streamingBehavior 的 prompt ——
     * 用户报的「模型工作的时候插话失效」就发生在这个窗口。
     * 待定区的判定必须用回合级标记，否则那时候按 Enter 会直接投出去。
     */
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
    ok(pending().length === 1, '工具执行期间按 Enter 仍然进待定区（不直接投出去）')
    ok(sent.length === 0, '这段时间里一次都没投递')
    store.getState().restoreSend(pending()[0].id)
    await sleep(200)
    setValue(q('#probe-composer'), '')

    out.push('')
    out.push('=== 7. 回合结束后自动按「排队」投出去（不丢消息） ===')
    sent.length = 0
    store.getState().holdSend('YAN-PENDING-AUTO')
    await sleep(150)
    ok(pending().length === 1, '先悬起来一条')
    idle()
    /*
     * 用户没点任何按钮，回合结束了 —— 消息不能就这么一直挂着，
     * 也不能悄悄丢掉；此时唯一有意义的语义就是排队。
     */
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
    /*
     * 用户 2026-09-19：「自动压缩的时候仍要允许用户发送消息」。
     *
     * 这一节钉的是**判据本身**：pi 在**回合之间**自动压缩（threshold）时
     * `agent_settled` 早就发过、`runner.running` 已经是 false，只有
     * `session.isCompacting` 为真。改动前这种时刻按 Enter 会**直接投出去**，
     * pi 报「Agent is already processing」，而 `submit` 已经把输入框清空了
     * —— 用户的消息就这样丢了。
     */
    sent.length = 0
    idle()
    /* 第 8 节故意留了一张“投递失败”的卡片、并把桩按在 sendOk=false 上 ——
       两个都要先复位，本节只数自己造的这条
       （restoreSend 会把文字回填到草稿，所以随后要再清一次输入框） */
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
      /* 压缩一结束：回合判据变 false → 自动按「排队」投出去 */
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
    /* 上一节正常结束时待定区已经是空的（自动投递成功）—— 不能无条件取 [0].id */
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
