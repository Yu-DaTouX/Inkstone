;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const fail = (s) => {
    out.push('✗ ' + s)
    return out.join('\n')
  }
  const ok = (cond, s) => {
    out.push((cond ? '  ✓ ' : '  ✗ ') + s)
    return !!cond
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const store = window.__yanStore

  log('=== 排队 + 中止回收（会真调模型）===')

  /*
   * 这个场景要 pi **真的开始生成**一段回答，才有后面的排队/中止可测。
   * 它是 cost > 0 的场景（所以不进 `check` 回归），但手动跑时 pi 也可能没起 ——
   * 那时显式跳过，不报 ✗（约定见交接文档第 5 节）。
   */
  for (let i = 0; i < 20; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  if (store.getState().conn !== 'ready') {
    return `  ⤺ 跳过：pi 未就绪（conn=${store.getState().conn}），本场景要真的生成一段回答`
  }

  const ta = q('[data-testid="composer"]')
  if (!ta) return fail('找不到输入框')

  /* ---- 先让它开始生成一段较长的回答 ---- */
  setVal(ta, '请写一段 400 字左右的说明，主题是「为什么终端界面适合编码工具」。不要用工具，直接写。')
  await sleep(200)
  q('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  // 等流式真正开始
  let started = false
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    if (q('.cursor') || store.getState().session?.isStreaming) {
      started = true
      break
    }
  }
  ok(started, '生成已开始')
  if (!started) return out.join('\n')

  /* ---- 生成中排队两条插话 ---- */
  const M1 = '插话一：这段再短一点'
  const M2 = '插话二：最后加一句总结'

  await store.getState().send(M1)
  await sleep(500)
  await store.getState().send(M2)
  await sleep(1200)

  const queue = store.getState().queue
  log('  队列: steering=' + JSON.stringify(queue.steering) + ' followUp=' + JSON.stringify(queue.followUp))
  const queued = [...queue.steering, ...queue.followUp]
  ok(queued.length > 0, `排队里有 ${queued.length} 条`)
  // 默认投递方式是**排队**（follow-up），不是插话（steering）
  ok(queue.followUp.length > 0, '默认进 follow-up 队列（排队）')
  ok(queue.steering.length === 0, '默认不插话（steering 为空）')
  // 排队消息要显示在输入框上方
  ok(!!q('[data-testid="queue-stack"]'), '排队消息显示在输入框上方')

  /* ---- 撤回一条真实队列项：clear_queue → 重排 → 文本回草稿 ---- */
  /* 每次重新查询，不用开头的 ta 引用：Composer 在队列变化时可能重挂载，
     拿旧节点读 value 会假阴性。顺便报告节点是否还在 DOM 里。 */
  const draftValue = () => {
    const el = q('[data-testid="composer"]')
    return { text: el ? el.value : null, count: qa('[data-testid="composer"]').length, same: el === ta, connected: ta.isConnected }
  }
  /* Composer 的草稿回填跟随 activeRuntimeKey（sessionId ?? run:<id>）。
     身份从 pending/run: 过渡到稳定 sessionId 时会重新 hydrate 草稿（用缓存值覆盖），
     所以要把这个 key 一并采出来。 */
  const runtimeKey = () => {
    const s = store.getState()
    const runner = (s.runners || []).find((r) => (r.runId ?? r.id) === s.activeRunnerId)
    return {
      sessionId: s.session?.sessionId ?? null,
      runnerSessionId: runner?.sessionId ?? null,
      activeRunnerId: s.activeRunnerId ?? null
    }
  }
  log('  撤回前 key: ' + JSON.stringify(runtimeKey()))
  const retractTarget = queued[0]
  const retractButton = q('[data-testid="queue-retract"]')
  if (retractTarget && retractButton) {
    /*
     * 撤回有两种**合法**结果，探针必须都认：
     *   · retracted —— pi 里还有这条 → clear_queue + 重建队列 →
     *                  notice「已撤回排队内容，并放回输入草稿」→ 文本回草稿
     *   · consumed  —— pi 已经把它投递给模型 → 明确拒绝，
     *                  notice「消息已被 pi 接收，无法撤回」→ 队列不动
     * 免费模型回得很快，第二种经常先发生。
     * 旧版探针只认第一种，而且用**旧 queueId** 判“移除了”——恢复队列后 id 是新生成的，
     * 于是把「拒绝」误判成「撤回成功」，再拿空草稿报红（假失败）。
     */
    retractButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const noticesText = () => (store.getState().notices || []).map((n) => n.text).join(' | ')
    const queueTexts = () =>
      [...store.getState().queue.steering, ...store.getState().queue.followUp].map((item) => item.text)
    let outcome = null
    for (let i = 0; i < 25; i++) {
      await sleep(120)
      const n = noticesText()
      if (/已撤回排队内容/.test(n)) {
        outcome = 'retracted'
        break
      }
      if (/无法撤回|已被 pi 接收/.test(n)) {
        outcome = 'consumed'
        break
      }
    }
    log('  撤回结果: ' + outcome + ' · notices=' + JSON.stringify(noticesText().slice(0, 200)))
    ok(!!outcome, '撤回给出明确结果提示（成功或已被接收，不静默）')

    /* 草稿回填是 store.queueRestore → Composer effect，不是同步赋值：
       用时间线采样，同时能分辨「从未设置」与「设置后被覆盖」。 */
    let backToDraft = false
    if (outcome === 'retracted') {
      ok(!queueTexts().includes(retractTarget.text), '撤回后队列里不再有这条文本')
      const timeline = []
      let prevQR = store.getState().queueRestore
      let prevV = draftValue().text
      timeline.push('t=0 qr=' + JSON.stringify(prevQR) + ' v=' + JSON.stringify(prevV))
      for (let i = 0; i < 12; i++) {
        await sleep(60)
        const qr = store.getState().queueRestore
        const v = draftValue().text
        if (qr !== prevQR || v !== prevV) {
          timeline.push('t=' + (i + 1) * 60 + ' qr=' + JSON.stringify(qr) + ' v=' + JSON.stringify((v || '').slice(0, 40)))
          prevQR = qr
          prevV = v
        }
        if ((v || '').includes(retractTarget.text)) {
          backToDraft = true
          break
        }
      }
      log('  撤回时间线: ' + timeline.join(' | '))
      if (!backToDraft) {
        log(
          '  ⚠️ 提示说已撤回，但草稿里没出现文本 · ' + JSON.stringify(draftValue()) + ' · key=' + JSON.stringify(runtimeKey())
        )
      }
      ok(backToDraft, '撤回文本回到输入草稿')
    } else if (outcome === 'consumed') {
      ok(true, '消息已被 pi 接收 → 撤回被明确拒绝（正确行为，不是缺陷）')
      ok(
        queueTexts().includes(retractTarget.text) || queueTexts().length === 0,
        '队列状态与提示一致（要么还在队列里，要么已被收走）'
      )
      log('  （这条在本轮被模型收走了，因此没有文本可回草稿）')
    }
  } else {
    ok(false, '找不到真实队列项的撤回按钮')
  }

  /* ---- Esc：clear_queue → abort → 文本回到输入框 ---- */
  /* 记下 Esc 之前 pi 侧还剩几条。模型跑完这一轮会把 follow-up 收走，
     那时确实没有文本可回收 —— 那是 pi 的语义（已被接收），不该当成缺陷。 */
  const pendingBeforeEsc = store.getState().queue.steering.length + store.getState().queue.followUp.length
  log('  Esc 前 pi 侧排队数: ' + pendingBeforeEsc + ' · key=' + JSON.stringify(runtimeKey()))
  log('--- 按 Esc ---')
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

  // 等中止流程走完
  let stopped = false
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    if (!store.getState().session?.isStreaming && !q('.cursor')) {
      stopped = true
      break
    }
  }
  ok(stopped, '中止后不再流式')
  await sleep(1200)

  const afterQueue = store.getState().queue
  ok(
    afterQueue.steering.length === 0 && afterQueue.followUp.length === 0,
    `队列已清空（steering=${afterQueue.steering.length} followUp=${afterQueue.followUp.length}）`
  )

  // 关键：被清掉的排队文本必须回到输入框，否则用户打的话就白打了
  const restoredInfo = draftValue()
  const restored = restoredInfo.text ?? ''
  log('  输入框内容: ' + JSON.stringify(restored.slice(0, 120)) + ' · ' + JSON.stringify(restoredInfo))
  log('  Esc 后 key: ' + JSON.stringify(runtimeKey()))
  if (pendingBeforeEsc > 0) {
    ok(restored.length > 0, '排队文本被放回输入框（不是丢掉）')
    ok(
      restored.includes(retractTarget?.text ?? '') || restored.includes(M1) || restored.includes(M2),
      '回收内容仍包含一条排队消息'
    )
  } else {
    log('  ⚠️ pi 已把排队消息投递给模型（pendingBeforeEsc=0）→ 没有文本可回收，跳过这两条断言')
  }

  // 助手消息应被收尾（不再有光标）
  ok(!q('.cursor'), '流式光标已消失')
  /* 先看清 store 里到底有没有助手消息，再断言 DOM —— 两者不一致时
     要能分辨是「消息丢了」还是「消息在但没渲染」。 */
  const roles = store.getState().messages.map((m) => m.role).join(',')
  log('  store 消息角色: ' + roles + ' · DOM 助手消息数: ' + qa('.msg.assistant').length)
  const lastAssistant = qa('.msg.assistant').pop()
  ok(!!lastAssistant, '助手消息保留在记录里')

  // 清干净，别影响后续测试
  setVal(ta, '')
  await sleep(200)

  return out.join('\n')
})()
