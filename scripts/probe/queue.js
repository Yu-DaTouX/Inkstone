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
  const enteredEarly = store
    .getState()
    .messages.filter((m) => m.role === 'user')
    .map((m) => String(m.text ?? ''))
    .filter((x) => x === M1 || x === M2)
  log('  队列: steering=' + JSON.stringify(queue.steering) + ' followUp=' + JSON.stringify(queue.followUp))
  log('  已经进对话的: ' + JSON.stringify(enteredEarly))
  const queued = [...queue.steering, ...queue.followUp]
  /*
   * 默认投递方式是**插话**（steering）：用户在工作过程中打字，
   * 意思就是“你现在就该知道这件事”。
   *
   * 早期默认是 followUp（等这轮跑完再投递）—— 结果是消息半天不出现，
   * 用户去点队列行上的「插队」/「撤回」，而 followUp 在这轮结束时已被
   * pi 接收，于是报「消息已被 pi 接收，无法撤回」（用户报的“插话失效”）。
   *
   * ⚠️ 判据不能只看“快照里此刻还挂着几条”：steering 会被 pi 很快取走，
   *    取走后队列就空了 —— 那是**成功**而不是失败。所以两条一起判：
   *      ① followUp 为空（没有走排队通道）
   *      ② 消息要么还挂在 steering 里，要么已经进了对话
   */
  ok(queue.followUp.length === 0, '默认不排队（followUp 为空）')
  ok(
    queued.length + enteredEarly.length >= 1,
    `消息在插话通道里（队列 ${queued.length} 条 / 已进对话 ${enteredEarly.length} 条）`
  )
  // 队列行显示在输入框上方（已被取走时那一行本来就不该在）
  ok(!!q('[data-testid="queue-stack"]') || enteredEarly.length > 0, '队列行显示在输入框上方（或已被取走）')

  /*
   * D9：被 pi 接收的插话不能一直挂在“排队中”。
   *
   * 判据是**消息真的出现**：`store.messages` 里出现同文本的 user 消息，
   * 就说明 pi 已经把它从队列里拿进对话了 —— 此时队列快照里不该再有它。
   * 旧实现会一直显示排队，直到下一条 queue_update 顺手抹掉。
   *
   * M1/M2 各只发一次，所以“进了对话”与“该从队列消失”是一一对应的。
   */
  out.push('')
  out.push('=== 被接收的插话从“排队中”消失（D9）===')
  let enteredTexts = []
  let queueTextsAtConsume = []
  for (let i = 0; i < 90; i++) {
    await sleep(500)
    const q2 = store.getState().queue
    queueTextsAtConsume = [...q2.steering, ...q2.followUp].map((x) => x.text)
    const msgs = store.getState().messages.filter((m) => m.role === 'user').map((m) => String(m.text ?? ''))
    enteredTexts = msgs.filter((x) => x === M1 || x === M2)
    if (enteredTexts.length > 0) break
  }
  log('  已进对话的插话: ' + JSON.stringify(enteredTexts))
  log('  同一时刻队列里的: ' + JSON.stringify(queueTextsAtConsume))
  if (enteredTexts.length > 0) {
    const stale = enteredTexts.filter((x) => queueTextsAtConsume.includes(x))
    ok(stale.length === 0, `已接收的插话不再显示为排队（残留 ${JSON.stringify(stale)}）`)
  } else {
    log('  （模型本轮没来得及收插话，跳过这条断言）')
  }

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
      /*
       * 提示说“已被接收”，那它就不该再出现在队列里（D9）。
       * 旧断言写的是「要么还在队列里，要么队列空了」—— 那是在迁就旧行为：
       * pi 说已收走、快照却还挂着它。现在快照以 pi 的 clear_queue 返回为准重建，
       * 所以直接断“目标不在队列里”。
       */
      ok(!queueTexts().includes(retractTarget.text), '队列快照里也确实没有它了（不再显示为排队中）')
      log('  （这条在本轮被模型收走了，因此没有文本可回草稿）')
    }
  } else {
    ok(false, '找不到真实队列项的撤回按钮')
  }

  /*
   * ---- N09 剩余边界：相同文本 / 并发入队 / 连续撤回 ----
   *
   * 为什么不放在 queueretract（cost 0）里：这几条要**真实的队列项**，
   * 而 pi 只在生成中才排队 —— 必须真发消息（所以本场景是 cost: 1）。
   * “刚被消费”的拒绝分支已在上面那条撤回里覆盖（`consumed`）。
   */
  out.push('')
  out.push('=== N09 边界：相同文本 / 并发入队 / 连续撤回 ===')
  const DUP = 'N09-DUP：同一句发两次'
  const PA = 'N09-A：并发一'
  const PB = 'N09-B：并发二'
  /* 并发入队：四条同时发（不间隔）—— 不能出现互相覆盖或丢项 */
  await Promise.all([
    store.getState().send(PA),
    store.getState().send(PB),
    store.getState().send(DUP),
    store.getState().send(DUP)
  ])
  await sleep(1500)
  const snapItems = () => [...store.getState().queue.steering, ...store.getState().queue.followUp]
  const items = snapItems()
  log('  队列 = ' + JSON.stringify(items.map((i) => i.text)))
  ok(
    new Set(items.map((i) => i.id)).size === items.length,
    '每条排队项都有独立 queueId（并发入队不串）'
  )
  const dups = items.filter((i) => i.text === DUP)
  if (dups.length >= 2) {
    ok(true, `同一句话两次入队都保留了（${dups.length} 条，各自独立）`)
    const rows = qa('[data-testid="queue-row"]')
    const row = rows.find((r) => (r.textContent ?? '').includes(DUP))
    const btn = row ? row.querySelector('[data-testid="queue-retract"]') : null
    log(
      '  同文本行 = ' +
        (row ? JSON.stringify((row.textContent ?? '').trim().slice(0, 40)) : '无') +
        ' · 按钮 = ' +
        (btn ? String(btn.getAttribute('data-testid')) : '无')
    )
    if (btn) {
      const noticesBefore = (store.getState().notices ?? []).length
      /*
       * 直接问主进程拿结果（不经过 store 的通知）：通知对 8 秒内的同文案会去重，
       * 前面若已经弹过一次同样的错误，这里就看不到新通知 —— 会让人误判“什么都没发生”。
       */
      const direct = await window.yan.removeQueued(dups[0].id)
      log('  直连 removeQueued(' + dups[0].id + ') = ' + JSON.stringify(direct))
      await sleep(1200)
      const left = snapItems().filter((i) => i.text === DUP).length
      const fresh = (store.getState().notices ?? []).slice(noticesBefore).map((n) => `${n.type}:${n.text}`)
      log('  撤回一条同文本后剩 = ' + left + ' · 新通知 = ' + JSON.stringify(fresh))
      /*
       * 两种结果都合格，但都必须"说清楚"：
       *   · 撤掉了 —— pi 里确实还有这条 → 同文本应当**只少一条**（FIFO）；
       *   · 被拒—— pi 已经把同文本收走 / clear_queue 回来的身份与快照对不上 →
       *     明确报"已被接收"，且**队列快照保持原样**（不能连带清掉）。
       * 免费模型回复很快，实测经常落在第二种（重复文本尤其容易），这里不把它当失败。
       */
      ok(
        direct.ok === true || /已被.*接收|无法撤回/.test(direct.error ?? ''),
        '撤回请求给出明确结果（成功或说明已被 pi 接收）',
        JSON.stringify(direct)
      )
      if (direct.ok) ok(left === dups.length - 1, '同文本只捣掉一条（FIFO）', `${left} / 原 ${dups.length}`)
      else ok(left === dups.length, '被拒时队列快照保持原样（没有连带清掉同文本）', `${left} / 原 ${dups.length}`)
      /* 连续撤回：对已经处理过的 id 再来一次，不能谎报成功 */
      const countRetracted = () => (store.getState().notices ?? []).filter((n) => /已撤回/.test(String(n.text))).length
      const n1 = countRetracted()
      await store.getState().removeQueued(dups[0].id)
      await sleep(700)
      const n2 = countRetracted()
      log('  重复撤回前后“已撤回”通知数：' + n1 + ' → ' + n2)
      ok(n2 === n1, '对已处理过的 id 再撤回不会谎报“已撤回”')
      ok(store.getState().queueRestore !== null || left > 0, '撤回过的文本要么回到草稿、要么队列里还有同名项')
    } else {
      ok(false, '找不到同文本队列行的撤回按钮')
    }
  } else {
    log(`  ⤺ 跳过同文本用例：模型这轮已经把排队项收走（剩 ${dups.length} 条）`)
  }

  /* ---- Esc：clear_queue → abort → 文本回到输入框 ---- */
  /* 记下 Esc 之前 pi 侧还剩几条。模型跑完这一轮会把 follow-up 收走，
     那时确实没有文本可回收 —— 那是 pi 的语义（已被接收），不该当成缺陷。 */
  const pendingBeforeEsc = store.getState().queue.steering.length + store.getState().queue.followUp.length
  log('  Esc 前 pi 侧排队数: ' + pendingBeforeEsc + ' · key=' + JSON.stringify(runtimeKey()))
  log('--- 按 Esc ---')
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

  /*
   * 中止是一条**异步且多方参与**的链路（clear_queue → 收尾流式 → abort，
   * pi 还可能在中间推 queue_update），所以这里按时间线采样而不是只看终态：
   * 能分辨“从没回过草稿”与“回过又被覆盖”。
   */
  const escTimeline = []
  let lastDraft = draftValue().text ?? ''
  let lastQueueKey = '0+0'
  let lastNotice = ''
  let sawDraftAfterEsc = false
  for (let i = 0; i < 40; i++) {
    await sleep(100)
    const d = draftValue().text ?? ''
    const qq = store.getState().queue
    const key = `${qq.steering.length}+${qq.followUp.length}`
    const n = (store.getState().notices ?? []).map((x) => String(x.text)).join(' | ')
    if (d !== lastDraft || key !== lastQueueKey || n !== lastNotice) {
      escTimeline.push(
        `t=${(i + 1) * 100}ms draft=${JSON.stringify(d.slice(0, 24))} queue=${key} notice=${JSON.stringify(n.slice(0, 60))}`
      )
      lastDraft = d
      lastQueueKey = key
      lastNotice = n
    }
    if (d.length > 0) sawDraftAfterEsc = true
  }
  log('  Esc 时间线: ' + (escTimeline.length ? escTimeline.join('  ||  ') : '（无变化）'))

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

  /*
   * 关键：**pi 说还有**排队内容时，它必须回到输入框，否则用户打的话就白打了。
   *
   * 判据不能只看 `pendingBeforeEsc`（那是**我们的快照**，可能已经落后于 pi：
   * 模型把 follow-up 收走时不保证推 queue_update）。真正的权威是主进程
   * 回填时发的那条 notice —— 有它才说明 clear_queue 真的带回了文本。
   */
  const restoredInfo = draftValue()
  const restored = restoredInfo.text ?? ''
  const escNotice = (store.getState().notices ?? []).some((n) => /放回输入框/.test(String(n.text)))
  log('  输入框内容: ' + JSON.stringify(restored.slice(0, 120)) + ' · ' + JSON.stringify(restoredInfo))
  log('  Esc 后 key: ' + JSON.stringify(runtimeKey()) + ' · 回填通知=' + escNotice + ' · 过程出现过草稿文本=' + sawDraftAfterEsc)
  if (escNotice || sawDraftAfterEsc) {
    ok(restored.length > 0 || sawDraftAfterEsc, '确实放回过输入框（终态可能又被清掉）')
  } else {
    /* pi 侧已经没有被接收的排队项（clear_queue 返回空）→ 不回填是正确行为 */
    log('  （clear_queue 没有可回收文本：内容已被 pi 接收或在快照里只是残留，不回填）')
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
