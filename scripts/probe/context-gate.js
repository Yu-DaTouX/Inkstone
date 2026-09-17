/**
 * 会话级 eligibility gate（第四轮外部评审第四问 A）—— **短会话真的不花钱**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条场景证的是什么
 * ══════════════════════════════════════════════════════════════════
 * gate 是纯逻辑（`foldEligible` 已被单测覆盖），但它挂在 `agent_settled` 上、
 * 依赖「这个会话现在有几个用户回合、转录有多少 token」这两个**只有真实 pi
 * 才给得出来**的量。单测证不了的是：
 *   ① 真实 pi 的 `agent_settled` 会按时到达、我们能数出回合；
 *   ② 门槛没到时 **真的没有调模型**（不产生 `committed`、不落状态文件）；
 *   ③ 被挡住时诊断里留下可读的原因（不是静默跳过）。
 *
 * 所以本场景只跑**一个**真实回合：kinds 显式带上 `episode-fold`（否则连 gate
 * 都不会被评估），但 gate 保持默认阈值（≥4 回合且转录 ≥48k token）——
 * 一个回合的会话必然不满足，于是「挡住」这件事在真实链路里可以被检查。
 *
 * 与 `contextproduce` 的分工：那条场景把 gate 放开（`state.gate` 调成 1/1）
 * 去证「够了就生成」；这条证「不够就不生成」。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(200)
    } else await sleep(120)
  }
  await sleep(400)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 60; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  const sessionId = S().session?.sessionId ?? ''
  log(`  会话 id = ${sessionId || '(未知)'}`)

  const send = async (text) => {
    const ta = q('[data-testid="composer"]')
    if (!ta) return false
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(150)
    const button = q('[data-testid="send"]')
    if (!button) return false
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }

  /** 一个回合：发出 → 等到真的开始跑 → 等到停下 */
  const turn = async (text, ms) => {
    if (!(await send(text))) return { sent: false, started: false }
    let started = false
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const running = !!S().session?.isAgentRunning || !!S().session?.isStreaming
      if (running) started = true
      else if (started) return { sent: true, started: true }
      await sleep(400)
    }
    return { sent: true, started }
  }

  log('')
  log('=== 1. 唯一一个真实回合（短会话，gate 应当挡住生成） ===')
  const t1 = await turn('只回复 ok，不要用任何工具。', 180_000)
  ok(t1.sent, '回合已发出')
  ok(t1.started, '回合真的跑起来了')
  log(`  消息数=${(S().messages ?? []).length}`)

  /*
   * `agent_settled` 在回合结束后才到；给 gate 判定留出时间。
   * 它不调模型（这正是断言的内容），所以不需要等 20s 的生成超时。
   */
  log('')
  log('=== 2. 等一个 settled 周期（gate 判定，不生成） ===')
  await sleep(8_000)
  ok(!S().session?.isAgentRunning, '等待期间没有卡在「运行中」')

  out.push(`  ctxgate.sessionId=${sessionId}`)
  return out.join('\n')
})()
