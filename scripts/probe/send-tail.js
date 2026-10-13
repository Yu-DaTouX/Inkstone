/**
 * 发送瞬间上一轮回复不跳动。
 *
 * 主进程先推「开始运行」（state），再推刚发出的用户消息（msg-add）。中间几帧里
 * 最后一条消息仍是上一轮的回复；以前它会被当成流式中，底部「完成」行换成运行中的
 * 转圈与计时，高度变化后又变回去，用户看到的是一次错位。
 *
 * 用合成推送按真实顺序重放，不调用模型。逐帧记录上一轮回复的高度和是否出现运行状态。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
  const store = window.__yanStore

  try {
    for (let i = 0; i < 60 && !store.getState().session?.sessionId; i++) await sleep(250)
    const base = store.getState().session
    if (!ok(!!base?.sessionId, '有当前会话')) return out.join('\n')
    const idle = { ...base, isAgentRunning: false, isStreaming: false }
    const now = Date.now()
    store.setState({
      session: idle,
      runTail: null,
      messages: [
        { id: 'm0', role: 'user', text: '第一问', timestamp: now - 60_000 },
        { id: 'm1', role: 'assistant', text: '第一轮的回答。\n\n第二段。', timestamp: now - 50_000, elapsedMs: 9_000 }
      ]
    })
    await sleep(400)

    const prior = () => document.querySelector('article[data-turn-id] [data-msg-id="m1"]')?.closest('[data-turn-id]')
      ?? [...document.querySelectorAll('[data-turn-id]')].find((el) => el.textContent?.includes('第一轮的回答'))
    const live = (el) => !!el?.querySelector('[data-testid="working"]')
    const first = prior()
    if (!ok(!!first, '上一轮回复已渲染')) return out.join('\n')
    const h0 = Math.round(first.getBoundingClientRect().height)
    ok(!live(first), '发送前上一轮不在运行状态')

    /* 与主进程同序：isStreaming → isAgentRunning → 用户消息 → 助手消息 */
    const push = (m) => store.getState().applyPush(m)
    const samples = []
    /* 高度变了时要知道是哪一块：记下直接子元素的类名与高度 */
    const parts = (el) => {
      if (!el) return ''
      const cs = getComputedStyle(el)
      const own = `<${el.tagName} ${el.className?.baseVal ?? el.className} pad=${cs.paddingTop}/${cs.paddingBottom} minH=${cs.minHeight}>`
      return own + ' ' + [...el.querySelectorAll(':scope > *, :scope > * > *')]
        .map((c) => `${c.className?.baseVal ?? c.className ?? c.tagName}:${Math.round(c.getBoundingClientRect().height)}`).join(' | ')
    }
    const shape0 = parts(first)
    const sample = (label) => {
      const el = prior()
      samples.push({ label, h: el ? Math.round(el.getBoundingClientRect().height) : -1, live: live(el), shape: parts(el) })
    }
    push({ ch: 'state', payload: { ...idle, isStreaming: true } })
    await frame(); sample('isStreaming')
    push({ ch: 'state', payload: { ...idle, isStreaming: true, isAgentRunning: true } })
    await frame(); sample('isAgentRunning')
    await sleep(120); sample('等待用户消息 120ms')
    push({ ch: 'msg-add', payload: { id: 'm2', role: 'user', text: '第二问', timestamp: Date.now() } })
    await frame(); sample('用户消息到达')
    const pending = !!document.querySelector('.stream-pending [data-testid="working"]')
    push({ ch: 'msg-add', payload: { id: 'm3', role: 'assistant', text: '', timestamp: Date.now() } })
    await frame(); sample('助手消息到达')
    const streamingLast = [...document.querySelectorAll('[data-turn-id]')].at(-1)
    const lastLive = live(streamingLast)

    for (const s of samples) out.push(`  ${s.label}: 上一轮高度 ${s.h}px（发送前 ${h0}px）运行状态=${s.live}`)
    out.push(`  发送前结构: ${shape0}`)
    for (const s of samples) if (s.shape !== shape0) out.push(`  ${s.label} 结构: ${s.shape}`)
    ok(samples.every((s) => !s.live), '整个发送过程中上一轮回复都没有变成运行状态')
    /* 用户消息到达后上一轮加上回合分隔（底线与留白），与新消息同一帧出现，不算跳动 */
    ok(samples.slice(0, 3).every((s) => s.h === h0), '用户消息到达前，上一轮回复高度不变')
    ok(pending, '用户消息到达后，末尾出现等待行')
    ok(lastLive, '助手消息到达后，新回合显示运行状态')

    /* 对照：不记录发送前的末尾（修复前的判定），空档里上一轮会变成运行状态 */
    push({ ch: 'state', payload: idle })
    store.setState({ messages: store.getState().messages.slice(0, 2) })
    await sleep(300)
    push({ ch: 'state', payload: { ...idle, isStreaming: true, isAgentRunning: true } })
    store.setState({ runTail: null })
    await frame()
    const control = prior()
    out.push(`  对照：上一轮高度 ${control ? Math.round(control.getBoundingClientRect().height) : -1}px 运行状态=${live(control)}`)
    ok(live(control), '对照：修复前的判定下，空档里上一轮确实会变成运行状态（即用户看到的错位）')

    /* 切到一个本来就在运行的会话：不能因为记录了发送前的末尾而把正在输出的回复当成已结束 */
    push({ ch: 'state', payload: { ...idle, isStreaming: false, isAgentRunning: false } })
    await frame()
    store.setState({ runTail: null, session: { ...idle, isAgentRunning: true, isStreaming: true } })
    await frame()
    ok(live([...document.querySelectorAll('[data-turn-id]')].at(-1)), '已在运行的会话，最后一轮照常显示运行状态')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
