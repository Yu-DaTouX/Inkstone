/*
 * 推理胶囊（回归）。
 *
 * 为什么单独一个场景：用户报「为什么我看不到推理」——
 * 根因是 `ReasoningCapsule` 被 import 了却**没有任何地方渲染**。
 * typecheck 抓不到（tsconfig 没开 noUnusedLocals），只能靠这条 DOM 断言。
 *
 * 这里不烧 token：直接往 store 注入一条带 thinking 的助手消息。
 *
 * ⚠️ 重点回归（两条，都来自用户报的问题）：
 *   ① 展开/折叠跟**整个回合**走，不是跟单段推理走 ——
 *      否则「思考 → 调工具 → 再回复」时第一段思考一结束窗口就被折叠；
 *   ② 方案 4.4 改版后：默认固定约 3 行、可拖尺寸并记忆、双击复位、
 *      上滚暂停跟随并给「回到最新」。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  /** 展开 = 容器高度 > 20px（正文始终挂载，收起时高度过渡到 0） */
  const wrapH = () => {
    const el = q('.reason-body-wrap')
    return el ? el.getBoundingClientRect().height : 0
  }
  const isOpen = () => wrapH() > 20

  const THINK =
    '先看题目：狼会吃羊，羊会吃白菜。' +
    '关键是把羊先带过去，再把羊带回来。'.repeat(80)

  log('=== 推理窗口：渲染 / 固定 3 行 + 可拖 / 回合结束前不折叠 ===')

  let conn = store.getState().conn
  for (let i = 0; i < 40 && conn !== 'ready'; i++) {
    await sleep(250)
    conn = store.getState().conn
  }
  await sleep(1200)

  const injectThinking = () =>
    store.getState().applyPush({
      ch: 'sync',
      payload: [
        { id: 'r-user', role: 'user', text: '帮我解一下过河题' },
        { id: 'r-a1', role: 'assistant', text: '', thinking: THINK, thinkingLive: true }
      ]
    })

  /** 控制「整个助手回合是否仍在进行」（App 用它算 streamingId → turn.streaming） */
  const setTurnStreaming = (v) => {
    const s = store.getState().session
    store.setState({ session: { ...(s ?? {}), isStreaming: v, isAgentRunning: v } })
  }

  let cap = null
  for (let i = 0; i < 12; i++) {
    injectThinking()
    setTurnStreaming(true)
    await sleep(350)
    cap = q('[data-testid="reasoning"]')
    if (cap) break
  }
  setTurnStreaming(true)
  await sleep(400)
  cap = q('[data-testid="reasoning"]')

  ok(!!cap, '推理胶囊被渲染了（这是那个 bug 的直接断言）')
  if (!cap) return out.join('\n')

  const label = q('.reason-label')?.textContent ?? ''
  ok(label.includes('推理中'), `正在推理时标题 =「${label}」（应为「推理中」）`)
  ok(isOpen(), `推理中默认展开（容器高 ${Math.round(wrapH())}px）`)

  // 逐字流式：body 的文字会逐步追上来，轮询等它追到结尾
  let shownLen = 0
  for (let i = 0; i < 60; i++) {
    shownLen = (q('[data-testid="reasoning-body"]')?.textContent ?? '').length
    if (shownLen >= THINK.length) break
    await sleep(150)
  }
  log(`  逐字进度：${shownLen} / ${THINK.length}`)
  ok(shownLen >= THINK.length, '推理文本逐字追上（不是一次性贴上来）')

  /* ---- 1b. 固定窗口（默认约 3 行）+ 内部滚动 + 自动跟随最新 ---- */
  const body = q('[data-testid="reasoning-body"]')
  const h1 = body.getBoundingClientRect().height
  log(`  推理窗口高度 = ${Math.round(h1)}px（默认 3 行 ≈ 58px）`)
  ok(h1 >= 40 && h1 <= 80, `默认高度约 3 行（${Math.round(h1)}px）`)
  ok(
    body.scrollHeight > body.clientHeight + 8,
    `长内容在窗口内溢出并滚动（scrollHeight ${body.scrollHeight} > clientHeight ${body.clientHeight}）`
  )
  ok(
    body.scrollHeight - body.scrollTop - body.clientHeight < 24,
    `自动跟随最新（离开底部 ${body.scrollHeight - body.scrollTop - body.clientHeight}px）`
  )

  /* ---- 1c. 拖拽改尺寸 / 落盘 / 双击复位（方案 4.4） ---- */
  const grip = q('[data-testid="reasoning-grip"]')
  ok(!!grip, '推理窗口有底部尺寸把手')
  if (grip) {
    const before = Math.round(wrapH())
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await sleep(250)
    const after = Math.round(wrapH())
    log(`  键盘调高：${before}px → ${after}px`)
    ok(after > before, '键盘能把窗口调高（把手可聚焦）')
    ok(Number(localStorage.getItem('yan.reasonHeight')) === after, '尺寸写进 localStorage（全局记忆）')

    grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await sleep(300)
    const reset = Math.round(wrapH())
    log(`  双击复位后 = ${reset}px`)
    ok(Math.abs(reset - 58) <= 3, '双击复位回默认 3 行')
    ok(localStorage.getItem('yan.reasonHeight') === null, '复位后清掉记忆（跟随默认）')
  }

  /* ---- 1d. 上滚暂停跟随 +「回到最新」（方案 4.4） ---- */
  {
    const el = q('[data-testid="reasoning-body"]')
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
    await sleep(300)
    ok(!!q('[data-testid="reasoning-jump"]'), '上滚后出现「回到最新」入口')
    const keep = el.scrollTop
    await sleep(400)
    ok(el.scrollTop === keep, '暂停跟随：新字到达不再把用户拽回底部')
    q('[data-testid="reasoning-jump"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(250)
    ok(
      el.scrollHeight - el.scrollTop - el.clientHeight < 24,
      '点「回到最新」能回到底部'
    )
  }

  /* 内容继续变多时窗口不能跟着长高（固定高度） */
  store.getState().applyPush({
    ch: 'msg-update',
    payload: { id: 'r-a1', patch: { thinking: THINK + '（继续推演）'.repeat(300) } }
  })
  await sleep(700)
  const body2 = q('[data-testid="reasoning-body"]')
  ok(Math.abs(body2.getBoundingClientRect().height - h1) < 2, '内容变多窗口也不长高（固定高度）')

  /* ---- 2. 第一段思考结束、开始调工具（回合仍在跑）→ 窗口必须**不折叠** ---- */
  store.getState().applyPush({
    ch: 'msg-update',
    payload: { id: 'r-a1', patch: { thinkingLive: false, thinkingMs: 4200 } }
  })
  setTurnStreaming(true)
  await sleep(500)
  ok(isOpen(), '第一段思考结束、工具开始跑时，推理窗口仍展开（不折叠）——用户报的 bug')
  ok(!!q('[data-testid="reasoning"]'), '窗口仍在（不是消失）')
  {
    const l = q('.reason-label')?.textContent ?? ''
    ok(!l.includes('推理中'), `工具执行中不再显示「推理中」（应为耗时）：「${l}」`)
  }

  /* ---- 2b. 工具跑完、模型又开始想（第二段）→ 继续展开 ---- */
  const SECOND = THINK + '\n\n第二轮：再看看有没有更短的走法。'
  const injectSecond = () =>
    store.getState().applyPush({
      ch: 'sync',
      payload: [
        { id: 'r-user', role: 'user', text: '帮我解一下过河题' },
        { id: 'r-a1', role: 'assistant', text: '', thinking: SECOND, thinkingLive: true, thinkingMs: 4200 }
      ]
    })
  for (let i = 0; i < 10; i++) {
    injectSecond()
    setTurnStreaming(true)
    await sleep(300)
    if (q('[data-testid="reasoning-body"]')?.textContent?.includes('第二轮')) break
  }
  ok(isOpen(), '第二段推理仍然展开（窗口全程不折）')
  ok((q('.reason-label')?.textContent ?? '').includes('推理中'), '第二段思考时标题回到「推理中」')
  for (let i = 0; i < 30; i++) {
    if ((q('[data-testid="reasoning-body"]')?.textContent ?? '').includes('第二轮')) break
    await sleep(150)
  }
  ok(
    (q('[data-testid="reasoning-body"]')?.textContent ?? '').includes('第二轮'),
    '第二段推理追加在窗口里（不是替换）'
  )

  /* ---- 3. **整个回合结束** → 这时才自动折叠，且保留开关 ---- */
  store.getState().applyPush({
    ch: 'msg-update',
    payload: { id: 'r-a1', patch: { thinkingLive: false, thinkingMs: 8000 } }
  })
  setTurnStreaming(false)
  await sleep(700)

  ok(!!q('[data-testid="reasoning"]'), '回合结束后胶囊还在（不是消失）')
  ok(!isOpen(), `回合结束后自动折叠（容器高 ${Math.round(wrapH())}px）`)
  ok(!!q('[data-testid="reasoning-body"]'), '折叠是高度过渡，正文仍保留挂载（不丢尾部）')
  const label2 = q('.reason-label')?.textContent ?? ''
  ok(label2.includes('8'), `标题给出耗时 =「${label2}」（应为「已推理 8 秒」）`)
  ok(!!q('.reason-peek'), '折叠态有一行预览（不用展开就知道在想什么）')

  /* ---- 4. 点开关能重新打开 ---- */
  q('[data-testid="reasoning-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await sleep(400)
  ok(isOpen(), '点开关能再打开（保留开关）')

  /* ---- 5. 没有推理的回合不许出现空壳 ---- */
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
