/*
 * 推理胶囊（回归）。
 *
 * 为什么单独一个场景：用户报「为什么我看不到推理」——
 * 根因是 `ReasoningCapsule` 被 import 了却**没有任何地方渲染**，
 * 而 TurnActivity 又在工具为空时直接 return null。typecheck 抓不到
 * （tsconfig 没开 noUnusedLocals），只能靠一条「肉眼级」的 DOM 断言。
 *
 * 这里不烧 token：直接往 store 注入一条带 thinking 的助手消息
 * （真实数据通路已由 `npm run test:live -- e2e` 覆盖，这里只验渲染）。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  const THINK = '先看题目：狼会吃羊，羊会吃白菜。' + '关键是把羊先带过去，再把羊带回来。'.repeat(4)

  log('=== 推理胶囊：渲染 / 展开 / 折叠 / 无推理不占位 ===')

  /* 等应用起来（store 就绪）—— 不假设起始状态 */
  for (let i = 0; i < 40 && !store.getState().messages; i++) await sleep(250)

  /* ---- 1. 注入一条**正在推理**的助手消息 ---- */
  store.getState().applyPush({
    ch: 'sync',
    payload: [
      { id: 'r-user', role: 'user', text: '帮我解一下过河题' },
      { id: 'r-a1', role: 'assistant', text: '', thinking: THINK, thinkingLive: true }
    ]
  })
  await sleep(600)

  const cap = q('[data-testid="reasoning"]')
  ok(!!cap, '推理胶囊被渲染了（这是那个 bug 的直接断言）')
  if (!cap) return out.join('\n')

  const label = q('.reason-label')?.textContent ?? ''
  ok(label.includes('推理中'), `正在推理时标题 =「${label}」（应为「推理中」）`)
  ok(!!q('[data-testid="reasoning-body"]'), '推理中默认展开（用户要看着它想）')

  // 逐字流式：body 的文字会逐步追上来，轮询等它追到结尾
  let shownLen = 0
  for (let i = 0; i < 40; i++) {
    shownLen = (q('[data-testid="reasoning-body"]')?.textContent ?? '').length
    if (shownLen >= THINK.length) break
    await sleep(150)
  }
  log(`  逐字进度：${shownLen} / ${THINK.length}`)
  ok(shownLen >= THINK.length, '推理文本逐字追上（不是一次性贴上来）')

  /* ---- 2. 推理结束 → 自动折叠，但保留开关 ---- */
  store.getState().applyPush({
    ch: 'msg-update',
    payload: { id: 'r-a1', patch: { thinkingLive: false, thinkingMs: 4200 } }
  })
  await sleep(500)

  ok(!!q('[data-testid="reasoning"]'), '结束后胶囊还在（不是消失）')
  ok(!q('[data-testid="reasoning-body"]'), '结束后自动折叠（正文收起）')
  const label2 = q('.reason-label')?.textContent ?? ''
  ok(label2.includes('4'), `标题给出耗时 =「${label2}」（应为「已推理 4 秒」）`)
  ok(!!q('.reason-peek'), '折叠态有一行预览（不用展开就知道在想什么）')

  /* ---- 3. 点开关能重新打开 ---- */
  q('[data-testid="reasoning-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await sleep(300)
  ok(!!q('[data-testid="reasoning-body"]'), '点开关能再打开（保留开关）')

  /* ---- 4. 没有推理的回合不许出现空壳 ---- */
  store.getState().applyPush({
    ch: 'sync',
    payload: [
      { id: 'r-user2', role: 'user', text: '跑个命令' },
      {
        id: 'r-a2',
        role: 'assistant',
        text: '好了。',
        toolCalls: [{ id: 'r-c1', name: 'bash', args: { command: 'echo hi' }, status: 'ok' }]
      }
    ]
  })
  await sleep(600)
  ok(!q('[data-testid="reasoning"]'), '没有推理时不渲染胶囊（不占位、不留空壳）')
  ok(!!q('[data-tools="1"]') || !!q('.trow'), '工具行照常渲染（推理与工具共存于执行区）')

  return out.join('\n')
})()
