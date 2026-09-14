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

  /* ---- Esc：clear_queue → abort → 文本回到输入框 ---- */
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
  const restored = ta.value
  log('  输入框内容: ' + JSON.stringify(restored.slice(0, 120)))
  ok(restored.length > 0, '排队文本被放回输入框（不是丢掉）')
  ok(
    restored.includes('插话一') || restored.includes(M1),
    '回收内容包含第一条插话'
  )

  // 助手消息应被收尾（不再有光标）
  ok(!q('.cursor'), '流式光标已消失')
  const lastAssistant = qa('.msg.assistant').pop()
  ok(!!lastAssistant, '助手消息保留在记录里')

  // 清干净，别影响后续测试
  setVal(ta, '')
  await sleep(200)

  return out.join('\n')
})()
