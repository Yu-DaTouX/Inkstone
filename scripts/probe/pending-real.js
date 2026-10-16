;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const pressEnter = (el) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  const store = window.__yanStore
  if (!store) return '  ⤺ 跳过：没有 window.__yanStore（探针没被注入）'

  out.push('=== 待定消息：真实回合结束后的自动投递 ===')

  for (let i = 0; i < 40; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  if (store.getState().conn !== 'ready') {
    return `  ⤺ 跳过：pi 未就绪（conn=${store.getState().conn}），本场景要真的跑一个回合`
  }

  const ta = q('[data-testid="composer"]')
  if (!ta) return '  ✗ 找不到输入框'
  ta.id = 'probe-composer'

  const pending = () => store.getState().pendingSends ?? []
  const roundRunning = () =>
    !!store.getState().runners.find((r) => (r.runId ?? r.id) === store.getState().activeRunnerId)?.running

  const modes = []
  const realSend = store.getState().send
  store.setState({
    send: async (text, images, mode) => {
      modes.push(mode)
      return realSend(text, images, mode)
    }
  })

  out.push('')
  out.push('=== 1. 先让真模型开始一个回合 ===')
  setVal(ta, '请写一段 400 字左右的说明，主题是「为什么纯文本界面适合编码工具」。不要调用工具，直接写。')
  await sleep(200)
  q('[data-testid="send"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  let started = false
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    if (store.getState().session?.isAgentRunning === true) {
      started = true
      break
    }
  }
  ok(started, '真实回合已开始（isAgentRunning = true）')
  if (!started) return out.join('\n')

  out.push('')
  out.push('=== 2. 回合跑着时按 Enter：直接以排队方式投给 pi ===')
  const MSG = 'YAN-PENDING-REAL（回合结束后应作为排队消息处理）'
  setVal(ta, MSG)
  await sleep(150)
  pressEnter(ta)
  await sleep(400)
  out.push(`  pendingSends = ${pending().length} · runners[active].running = ${roundRunning()} · 投递方式 = ${JSON.stringify(modes)}`)
  ok(pending().length === 0, '没有悬在待定区（运行中默认直接排队）')
  ok(modes.includes('followUp'), '运行中按 Enter 以 followUp 投递')
  ok(roundRunning() === true, '此时回合级 running = true')

  out.push('')
  out.push('=== 3. 等真实回合结束：排队消息被处理完，运行状态回落 ===')
  let ended = false
  for (let i = 0; i < 400; i++) {
    await sleep(300)
    const queue = store.getState().queue ?? { steering: [], followUp: [] }
    if (store.getState().session?.isAgentRunning !== true && !roundRunning() && queue.followUp.length === 0) {
      ended = true
      break
    }
  }
  ok(ended, '回合与排队消息都处理完了')
  out.push(`  结束后 runners[active].running = ${roundRunning()} · queue.followUp = ${(store.getState().queue?.followUp ?? []).length}`)
  ok(roundRunning() === false, '回合结束后 runners 快照已刷新为 false（修复点：修复前会停在 true）')
  ok((store.getState().queue?.followUp ?? []).length === 0, '排队消息已被 pi 接收（队列清空）')

  return out.join('\n')
})()
