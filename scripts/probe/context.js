/**
 * 上下文分区（右栏第一块）的可观测行为。
 *
 * 两个真实 bug 的回归网：
 *   ① 手动压缩后 pi 会把 contextUsage.tokens/percent 报文 **null**
 *      （latestCompaction 之后没有新 usage）。旧代码 `?? 0` 把它显示成
 *      「0 tokens / 0.0%」——看起来像进度丢了。现在必须显示「—」+ 提示。
 *   ② 累计花费那一行要与其它 rp-kv 一样「标注靠左、数值靠右」（对齐）。
 *
 * 这个探针**不花 token**：直接往 store 注入 stats。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
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

  const sec = q('[data-testid="rp-context"]')
  if (!sec) return '✗ 找不到上下文分区'
  // 确保展开
  const head = sec.querySelector('button')
  if (head && head.getAttribute('aria-expanded') === 'false') {
    head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(200)
  }

  /* ---- ① 压缩后：tokens = null ---- */
  out.push('=== 1. 压缩后（tokens=null）不显示成 0 ===')
  store.setState({
    stats: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      contextUsage: { tokens: null, contextWindow: 262144, percent: null },
      toolCalls: 0,
      userMessages: 0,
      assistantMessages: 0
    }
  })
  await sleep(300)
  const sum1 = q('[data-testid="rp-context"] .rp-context-summary')?.textContent ?? ''
  out.push('  摘要: ' + JSON.stringify(sum1))
  ok(sum1.includes('—'), '摘要里是「—」而不是 0')
  ok(!/0\s*tokens/.test(sum1), '没有出现「0 tokens」')
  ok(!!q('[data-testid="ctx-unknown"]'), '出现「已压缩 · 下一条消息后重新统计」提示')

  /* ---- ② 正常：有数字 ---- */
  out.push('')
  out.push('=== 2. 有真实用量时显示数字 ===')
  store.setState({
    stats: {
      tokens: { input: 12, output: 34, cacheRead: 0, cacheWrite: 0, total: 46 },
      cost: 0.1234,
      contextUsage: { tokens: 128000, contextWindow: 262144, percent: 48.8 },
      toolCalls: 0,
      userMessages: 0,
      assistantMessages: 0
    }
  })
  await sleep(300)
  const sum2 = q('[data-testid="rp-context"] .rp-context-summary')?.textContent ?? ''
  out.push('  摘要: ' + JSON.stringify(sum2))
  ok(sum2.includes('128,000'), '显示 128,000 tokens')
  ok(sum2.includes('48.8%'), '显示 48.8%')
  ok(!q('[data-testid="ctx-unknown"]'), '有数字时不显示“已压缩”提示')

  /* ---- ③ 对齐：标注靠左、数值靠右 ---- */
  out.push('')
  out.push('=== 3. 累计花费行对齐（标注左 / 数值右）===')
  const cost = q('[data-testid="ctx-cost"]')
  ok(!!cost, '存在累计花费行')
  if (cost) {
    const k = cost.querySelector('.rp-k')
    const v = cost.querySelector('.rp-v')
    const kr = k.getBoundingClientRect()
    const vr = v.getBoundingClientRect()
    const cr = cost.getBoundingClientRect()
    out.push(
      `  cost.left=${Math.round(cr.left)} label.left=${Math.round(kr.left)} value.right=${Math.round(vr.right)} cost.right=${Math.round(cr.right)}`
    )
    ok(kr.left - cr.left < 2, '标注贴左')
    ok(cr.right - vr.right < 2, '数值贴右')
  }

  return out.join('\n')
})()
