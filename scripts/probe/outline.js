;(async () => {
  const out = []
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

  for (let i = 0; i < 60; i++) { if (store.getState().conn === 'ready') break; await sleep(500) }
  store.getState().closeSettings()

  // 找用户轮数最多的会话（导航轨要 ≥3 轮才显示）
  let best = null
  let bestTurns = 0
  for (const s of store.getState().sessions.filter((x) => (x.messageCount ?? 0) > 3).slice(0, 6)) {
    await store.getState().switchSession(s.path)
    await sleep(3500)
    const n = store.getState().messages.filter((m) => m.role === 'user').length
    if (n > bestTurns) { bestTurns = n; best = s }
    if (bestTurns >= 8) break
  }
  if (best) { await store.getState().switchSession(best.path); await sleep(4000) }

  out.push('=== 对话导航轨 ===')
  out.push('  用户轮数: ' + bestTurns)

  if (bestTurns < 3) {
    out.push('  （找不到 ≥3 轮的会话，跳过）')
    return out.join('\n')
  }

  const ol = q('[data-testid="outline"]')
  ok(!!ol, '导航轨存在')
  if (!ol) return out.join('\n')

  const ticks = qa('[data-testid="outline-tick"]')
  ok(ticks.length === bestTurns, `刻度数 ${ticks.length} = 轮数 ${bestTurns}`)
  ok(qa('.outline-tick.on').length === 1, '恰好一个高亮')

  // 间距：用户要求「拉长一些」
  if (ticks.length >= 2) {
    const gap = Math.round(ticks[1].getBoundingClientRect().top - ticks[0].getBoundingClientRect().bottom)
    out.push('  刻度间距: ' + gap + 'px')
    ok(gap >= 8, `间距 ≥8px（实际 ${gap}，之前是 5px）`)
  }
  const tickW = Math.round(ticks[0].getBoundingClientRect().width)
  out.push('  刻度宽度: ' + tickW + 'px')
  ok(tickW >= 14, `刻度 ≥14px（实际 ${tickW}，之前 11px）`)

  // 动态展开：CSS 层面验证，**不模拟 hover**。
  //
  // 为什么不用 dispatchEvent('mouseover') 测：
  //   合成事件不会产生真正的 :hover 状态，:has(.x:hover) 永远不匹配 ——
  //   断言会失败，但功能其实是好的。要真触发只能 sendInputEvent，
  //   而那需要主进程配合，且窗口必须真的可见。
  //   所以这里验证「规则存在且选择器正确」，视觉行为靠人工看一眼。
  const track = q('.outline-track')
  const gap = Math.round(parseFloat(getComputedStyle(track).rowGap || '0'))
  out.push('  默认间距: ' + gap + 'px')
  ok(gap >= 8, `默认间距 ≥8px（实际 ${gap}）`)

  let hasRule = false
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.selectorText?.includes(':has(.outline-tick:hover)')) hasRule = true
      }
    } catch {
      /* 跨域样式表读不到，跳过 */
    }
  }
  ok(hasRule, '存在「悬停时动态展开」的 CSS 规则')
  ok(ol && getComputedStyle(ol).pointerEvents === 'none', '导航轨空白处不挡消息流（pointer-events:none）')

  // 悬停预览 + 点击跳转
  const ul = store.getState().messages.filter(m => m.role === 'user')
  out.push('')
  out.push('=== 悬停与跳转 ===')
  ticks[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await sleep(300)
  ok(!!q('[data-testid="outline-preview"]'), '悬停弹出预览')
  ticks[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  await sleep(250)
  ok(!q('[data-testid="outline-preview"]'), '移开收起')

  const sc = q('.stream')
  sc.scrollTop = sc.scrollHeight
  await sleep(400)
  qa('[data-testid="outline-tick"]')[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(1400)
  out.push('  点第 1 轮后 scrollTop=' + Math.round(sc.scrollTop) + ' / ' + sc.scrollHeight)
  ok(sc.scrollTop < sc.scrollHeight * 0.5, '跳到了会话前部')
  ok(!!ul[0], '（消息引用正常）')

  return out.join('\n')
})()
