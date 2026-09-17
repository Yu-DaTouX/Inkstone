/**
 * Deep Context（N21-8）的真实链路取证（cost 1）。
 *
 * 要验的是**整条链路真的通电**：
 *   用户开口 → `context` 钩子 → Pass 1（`ctx.modelRegistry.complete()` 真调模型）
 *   → Pass 2（注入 `<WORKING_TRACE>`）→ 这一轮请求带着它发出。
 *
 * 为什么门槛要降到 1：真实门槛是 150k token（参考方案 §14 的 >200k 按可用上下文折算），
 * 而探针会话只有几 k —— 本场景的命题是「打开之后链路通不通」，
 * 「门槛算得对不对」由单测钉住（四道闸门各一条）。
 *
 * ⚠️ 本探针**不**断言模型归纳得好不好 —— 那是模型侧的质量，不是接线的正确性。
 * 归纳质量属于 N21-9 的 A/B 判据（LCR / contradiction rate），不属于这里。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(400)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 60; i++) {
    if (S().conn === 'ready' && S().session?.model?.contextWindow) break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  /* 退出后的日志检查靠它做会话隔离（沙箱是多个场景共用的） */
  out.push(`  ctxdeep.sessionId=${S().session?.sessionId ?? ''}`)
  log(`  模型 ${S().session?.model?.provider}/${S().session?.model?.id}｜窗口 ${S().session?.model?.contextWindow}`)

  const box = q('[data-testid="composer"]')
  if (!box) return '  ⤺ 跳过：找不到输入框'
  const text = '运行 `node -e "console.log(21*2)"`，然后告诉我结果，并说明这个命令在做什么。'
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text)
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)

  log('')
  log('=== 1. 一个回合（Pass 1 就挂在这一轮的 context 钩子上）===')
  const btn = q('[data-testid="send"]')
  ok(!!btn, '找到发送按钮')
  if (!btn) return out.join('\n')
  const t0 = Date.now()
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  let started = false
  let firstSeen = 0
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (S().session?.isAgentRunning || S().session?.isStreaming) {
      if (!started) {
        started = true
        firstSeen = Date.now() - t0
      }
    } else if (started) break
    await sleep(400)
  }
  ok(started, `回合真的跑起来了（首帧 ${firstSeen}ms）`)
  if (!started) return out.join('\n')

  /*
   * Pass 1 是在**请求发出前**跑的（它是 context 钩子的一部分），
   * 所以它带来的额外延迟会体现在「点发送 → 首帧」这段时间里。
   * 这条数字本身不是断言（模型速度差异太大），但它让「果然多等了一次调用」
   * 在日志里是**可观测**的，而不是一句承诺。
   */
  const wait = Date.now() - t0
  log(`  发送 → 首帧 ${firstSeen}ms｜回合总耗时 ${wait}ms`)
  const cu = S().stats?.contextUsage
  log(`  回合后半段 pi 用量=${cu ? `${cu.tokens}/${cu.contextWindow}` : 'null'}`)
  await sleep(3000)

  return out.join('\n')
})()
