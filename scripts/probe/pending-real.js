/**
 * 待定消息的**真实链路**回归（cost 1，会真调模型）。
 *
 * 为什么必须单独一个场景：`pending`（cost 0）把 store 的 `send` 换成桩，
 * 并且**直接 `setState` 改 `runners`** 来伪造「回合结束」—— 它测的是渲染端的分支，
 * 完全绕过了主进程的推送链。而 2026-09-19 用户报的 bug 恰恰在主进程那一段：
 *
 *   回合结束（`agent_settled` → `setAgentRunning(false)`）只推 `state` 通道，
 *   而 `runners` 快照只在**实例生命周期**事件里推（起停 / 切会话 / 删除）。
 *   于是渲染端 `runners[active].running` 一直停在 `true`：
 *   `Composer` 的自动投递 effect 永不触发，卡片也一直给着「插话 / 排队」。
 *
 * 这个场景把整条链走一遍：真实模型回合 → 跑着时按 Enter 悬起 → 回合结束 → 自动投递。
 * 断言「回合结束后 runners 快照变 false」是修复点的直接证据（修复前这一条会 ✗）。
 */
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

  /* pi 没起来就显式跳过、不报 ✗（约定：cost > 0 的场景手动跑时允许跳过） */
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
  /** 与 `Composer` / `QueueStack` 同一条判据：回合级 runners 快照 */
  const roundRunning = () =>
    !!store.getState().runners.find((r) => (r.runId ?? r.id) === store.getState().activeRunnerId)?.running

  /* 记录投递方式，但不替掉真实 send —— 这条链必须真的走到 pi */
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
  out.push('=== 2. 回合跑着时按 Enter：消息应该悬在待定区 ===')
  const MSG = 'YAN-PENDING-REAL（回合结束后应自动按排队投出）'
  setVal(ta, MSG)
  await sleep(150)
  pressEnter(ta)
  await sleep(400)
  out.push(`  pendingSends = ${pending().length} · runners[active].running = ${roundRunning()}`)
  ok(pending().length === 1, '消息进了待定区，没有直接投出去')
  ok(roundRunning() === true, '此时候回合级 running = true（正是插话时机）')

  out.push('')
  out.push('=== 3. 等真实回合结束：待定消息必须自动投出 ===')
  let ended = false
  for (let i = 0; i < 240; i++) {
    await sleep(300)
    if (store.getState().session?.isAgentRunning !== true) {
      ended = true
      break
    }
  }
  ok(ended, '回合已结束')

  let drained = false
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (pending().length === 0) {
      drained = true
      break
    }
  }
  out.push(`  回合结束后 runners[active].running = ${roundRunning()} · pendingSends = ${pending().length}`)
  ok(roundRunning() === false, '回合结束后 runners 快照已刷新为 false（修复点：修复前会停在 true）')
  ok(drained, '待定消息自动投出（卡片消失）')
  ok(modes.includes('followUp'), `投递方式 = ${JSON.stringify(modes)}（应为 followUp）`)

  return out.join('\n')
})()
