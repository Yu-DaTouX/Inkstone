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
  const composer = window.__yanComposer
  const setVal = (el, v) => composer.set(v, el)
  const store = window.__yanStore
  const noticeLog = []
  store.subscribe((s) => {
    for (const n of s.notices ?? []) if (!noticeLog.some((x) => x.id === n.id)) noticeLog.push(n)
  })

  log('=== 排队 + 中止回收（会真调模型）===')

  for (let i = 0; i < 20; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  if (store.getState().conn !== 'ready') {
    return `  ⤺ 跳过：pi 未就绪（conn=${store.getState().conn}），本场景要真的生成一段回答`
  }

  const ta = q('[data-testid="composer-input"]')
  if (!ta) return fail('找不到输入框')

  setVal(ta, '请写一段 400 字左右的说明，主题是「为什么终端界面适合编码工具」。不要用工具，直接写。')
  await sleep(200)
  q('[data-testid="composer-send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  let started = false
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    if (q('.v3-caret') || store.getState().session?.isStreaming) {
      started = true
      break
    }
  }
  ok(started, '生成已开始')
  if (!started) return out.join('\n')

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
  ok(queue.steering.length === 0, '默认走排队通道（steering 为空）')
  ok(
    queued.length + enteredEarly.length >= 1,
    `消息在排队通道里（队列 ${queued.length} 条 / 已进对话 ${enteredEarly.length} 条）`
  )
  ok(!!q('[data-testid="queue-stack"]') || enteredEarly.length > 0, '队列行显示在输入框上方（或已被取走）')

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

  const draftValue = () => {
    const el = q('[data-testid="composer-input"]')
    return { text: el ? composer.text(el) : null, count: qa('[data-testid="composer-input"]').length, same: el === ta, connected: ta.isConnected }
  }
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
  const retractTarget = [...store.getState().queue.steering, ...store.getState().queue.followUp][0]
  const rowMenuItem = async (text, testId) => {
    const all = (sel) => [...document.querySelectorAll(sel)]
    const menus = () => all('.cq-menu')
    menus().at(-1)?.querySelector('[role="menuitem"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    for (let i = 0; i < 30 && menus().length; i++) await sleep(100)
    const toggle = document.querySelector('[data-testid="queue-toggle"]')
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click()
    let row = null
    for (let i = 0; i < 30 && !row; i++) {
      row = all('[data-testid="queue-row"]').find((r) => text == null || (r.textContent ?? '').includes(text)) ?? null
      if (!row) await sleep(100)
    }
    row?.querySelector('[data-testid="queue-actions"]')?.click()
    for (let i = 0; i < 30 && !menus().length; i++) await sleep(100)
    await sleep(150)
    return menus()[0]?.querySelector(`[data-testid="${testId}"]`) ?? null
  }
  const retractButton = retractTarget ? await rowMenuItem(retractTarget.text, 'queue-retract') : null
  if (retractTarget && retractButton) {
    retractButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const noticesText = () => noticeLog.map((n) => n.text).join(' | ')
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
      ok(!queueTexts().includes(retractTarget.text), '队列快照里也确实没有它了（不再显示为排队中）')
      log('  （这条在本轮被模型收走了，因此没有文本可回草稿）')
    }
  } else {
    ok(false, '找不到真实队列项的撤回按钮')
  }

  out.push('')
  out.push('=== N09 边界：相同文本 / 并发入队 / 连续撤回 ===')
  const DUP = 'N09-DUP：同一句发两次'
  const PA = 'N09-A：并发一'
  const PB = 'N09-B：并发二'
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
    const btn = await rowMenuItem(DUP, 'queue-retract')
    const row = qa('[data-testid="queue-row"]').find((r) => (r.textContent ?? '').includes(DUP))
    log(
      '  同文本行 = ' +
        (row ? JSON.stringify((row.textContent ?? '').trim().slice(0, 40)) : '无') +
        ' · 按钮 = ' +
        (btn ? String(btn.getAttribute('data-testid')) : '无')
    )
    if (btn) {
      const noticesBefore = noticeLog.length
      const direct = await window.yan.removeQueued(dups[0].id)
      log('  直连 removeQueued(' + dups[0].id + ') = ' + JSON.stringify(direct))
      await sleep(1200)
      const left = snapItems().filter((i) => i.text === DUP).length
      const fresh = noticeLog.slice(noticesBefore).map((n) => `${n.type}:${n.text}`)
      log('  撤回一条同文本后剩 = ' + left + ' · 新通知 = ' + JSON.stringify(fresh))
      ok(
        direct.ok === true || /已被.*接收|无法撤回/.test(direct.error ?? ''),
        '撤回请求给出明确结果（成功或说明已被 pi 接收）',
        JSON.stringify(direct)
      )
      if (direct.ok) ok(left === dups.length - 1, '同文本只捣掉一条（FIFO）', `${left} / 原 ${dups.length}`)
      else ok(left === dups.length, '被拒时队列快照保持原样（没有连带清掉同文本）', `${left} / 原 ${dups.length}`)
      const countRetracted = () => noticeLog.filter((n) => /已撤回/.test(String(n.text))).length
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

  const pendingBeforeEsc = store.getState().queue.steering.length + store.getState().queue.followUp.length
  log('  Esc 前 pi 侧排队数: ' + pendingBeforeEsc + ' · key=' + JSON.stringify(runtimeKey()))
  log('--- 清空草稿后连按两次 Esc ---')
  const escTarget = q('[data-testid="composer-input"]') ?? ta
  setVal(escTarget, '')
  await sleep(200)
  escTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await sleep(120)
  escTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

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
    const n = noticeLog.map((x) => String(x.text)).join(' | ')
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

  let stopped = false
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    if (!store.getState().session?.isStreaming && !q('.v3-caret')) {
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

  const restoredInfo = draftValue()
  const restored = restoredInfo.text ?? ''
  const escNotice = noticeLog.some((n) => /放回输入框/.test(String(n.text)))
  log('  输入框内容: ' + JSON.stringify(restored.slice(0, 120)) + ' · ' + JSON.stringify(restoredInfo))
  log('  Esc 后 key: ' + JSON.stringify(runtimeKey()) + ' · 回填通知=' + escNotice + ' · 过程出现过草稿文本=' + sawDraftAfterEsc)
  if (escNotice || sawDraftAfterEsc) {
    ok(restored.length > 0 || sawDraftAfterEsc, '确实放回过输入框（终态可能又被清掉）')
  } else {
    log('  （clear_queue 没有可回收文本：内容已被 pi 接收或在快照里只是残留，不回填）')
  }

  ok(!q('.v3-caret'), '流式光标已消失')
  const roles = store.getState().messages.map((m) => m.role).join(',')
  log('  store 消息角色: ' + roles + ' · DOM 助手消息数: ' + qa('.v3-msg.assistant').length)
  const lastAssistant = qa('.v3-msg.assistant').pop()
  ok(!!lastAssistant, '助手消息保留在记录里')

  setVal(ta, '')
  await sleep(200)

  return out.join('\n')
})()
