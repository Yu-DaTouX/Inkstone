/**
 * 排队消息 UI（用户要求）：
 *   · 队列内容显示在**输入框上方**
 *   · follow-up 行右侧有「插队」按钮，点击调用 store.steerQueued(text)
 *   · steering 行显示「插话中」状态（已在当前这轮，不需要再插队）
 *
 * 不花 token：直接往 store 注入 queue，并把 steerQueued 换成 spy。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

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
  await sleep(600)
  store.getState().closeSettings?.()
  await sleep(200)

  const S = '插话：先解释一下'
  const F1 = '排队一：再补一个例子'
  const F2 = '排队二：最后总结'

  // spy：把真实的 steerQueued 换掉，避免真去调 pi
  const calls = []
  store.setState({
    queue: { steering: [S], followUp: [F1, F2] },
    steerQueued: async (text) => {
      calls.push(text)
    }
  })
  await sleep(300)

  out.push('=== 1. 位置：输入框上方 ===')
  const stack = q('[data-testid="queue-stack"]')
  const composer = q('.composer')
  ok(!!stack, '出现排队消息区')
  if (!stack) return out.join('\n')
  if (composer) {
    const sb = stack.getBoundingClientRect()
    const cb = composer.getBoundingClientRect()
    ok(sb.bottom <= cb.top + 2, `在输入框上方（stack.bottom=${Math.round(sb.bottom)} composer.top=${Math.round(cb.top)}）`)
  }

  out.push('')
  out.push('=== 2. 内容与按钮 ===')
  const rows = qa('[data-testid="queue-row"]')
  ok(rows.length === 3, `三条排队（实际 ${rows.length}）`)
  const text = stack.textContent ?? ''
  ok(text.includes(S) && text.includes(F1) && text.includes(F2), '三条文本都显示出来了')
  const jumps = qa('[data-testid="queue-steer"]')
  ok(jumps.length === 2, `只有 follow-up 行有插队按钮（实际 ${jumps.length}）`)
  ok((stack.textContent ?? '').includes('插话中'), 'steering 行显示「插话中」')

  out.push('')
  out.push('=== 3. 插队按钮接线 ===')
  jumps[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(250)
  ok(calls.length === 1 && calls[0] === F1, `点击插队调用 steerQueued("${F1}")（实际 ${JSON.stringify(calls)}）`)

  // 收尾：清空状态，别影响后续
  store.setState({ queue: { steering: [], followUp: [] } })
  await sleep(150)

  return out.join('\n')
})()
