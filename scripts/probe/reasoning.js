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
 *
 * ⚠️ 重点回归：推理窗口的展开/折叠跟**整个回合**走，不是跟单段推理走 ——
 *   否则「思考 → 调工具 → 再回复」时，第一段思考一结束（工具还在跑）
 *   窗口就被折叠了（用户报：「推理显示几秒、执行工具后推理被折叠」）。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  const THINK =
    '先看题目：狼会吃羊，羊会吃白菜。' +
    '关键是把羊先带过去，再把羊带回来。'.repeat(80)

  log('=== 推理窗口：渲染 / 高度自适应+上限 / 回合结束前不折叠 ===')

  /*
   * 等应用真的就绪再注入。
   *
   * ⚠️ 两个坑都踩过（见 HANDOFF §8.13）：
   *   ① `messages` 初始就是 `[]`（真值），拿它当「就绪」会立刻穿过；
   *   ② 真实会话的 `sync` 推送会**覆盖**我们注入的假数据 ——
   *      所以注入要能重试，直到胶囊真的出现（不能只注入一次就断言）。
   */
  let conn = store.getState().conn
  for (let i = 0; i < 40 && conn !== 'ready'; i++) {
    await sleep(250)
    conn = store.getState().conn
  }
  await sleep(1200) // 让首屏真实 sync 先落下来

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

  /* ---- 1b. 内容自适应 + 高度上限（方案 4.2） ---- */
  const body = q('[data-testid="reasoning-body"]')
  const r1 = body.getBoundingClientRect()
  const vh = window.innerHeight
  /** 上限：min(25vh, 420px) —— 必须与 chat.css 的 .reason-body 保持一致 */
  const limit = Math.min(vh * 0.25, 420)
  log(`  推理窗口 ${Math.round(r1.height)}px / 视口 ${vh}px，上限 ${Math.round(limit)}px`)
  ok(r1.height <= limit + 2, `内容超长时窗口封顶（${Math.round(r1.height)}px ≤ ${Math.round(limit)}px）`)
  ok(
    body.scrollHeight > body.clientHeight + 8,
    `内容在窗口内溢出（scrollHeight ${body.scrollHeight} > clientHeight ${body.clientHeight}）`
  )
  ok(
    body.scrollHeight - body.scrollTop - body.clientHeight < 24,
    `自动跟随最新（离开底部 ${body.scrollHeight - body.scrollTop - body.clientHeight}px）`
  )

  /*
   * 短内容不许留大片空白 —— 这是本轮改动的直接断言。
   *
   * 造一个同样 class 的元素来量：如果 CSS 又退回「固定 25vh」，
   * 这里会直接量到 227px（就是被修掉的那个「空 2/3」），断言随即失败。
   */
  const shortProbe = document.createElement('div')
  shortProbe.className = 'reason-body'
  shortProbe.textContent = '两行就够。\n说完了。'
  body.parentElement.appendChild(shortProbe)
  const shortH = shortProbe.getBoundingClientRect().height
  ok(
    shortH < Math.min(120, limit),
    `短内容时窗口贴着内容（${Math.round(shortH)}px，不是固定的 ${Math.round(vh * 0.25)}px）`
  )
  shortProbe.remove()

  /* 内容继续变多时窗口不能跟着长高（上限生效的意思） */
  const h1 = body.getBoundingClientRect().height
  store.getState().applyPush({
    ch: 'msg-update',
    payload: { id: 'r-a1', patch: { thinking: THINK + '（继续推演）'.repeat(300) } }
  })
  await sleep(700)
  const body2 = q('[data-testid="reasoning-body"]')
  ok(Math.abs(body2.getBoundingClientRect().height - h1) < 2, '内容超过上限后窗口不再长高')

  /* ---- 2. 第一段思考结束、开始调工具（回合仍在跑）→ 窗口必须**不折叠** ---- */
  store.getState().applyPush({
    ch: 'msg-update',
    payload: { id: 'r-a1', patch: { thinkingLive: false, thinkingMs: 4200 } }
  })
  setTurnStreaming(true)
  await sleep(500)
  ok(
    !!q('[data-testid="reasoning-body"]'),
    '第一段思考结束、工具开始跑时，推理窗口仍展开（不折叠）——用户报的 bug'
  )
  ok(!!q('[data-testid="reasoning"]'), '窗口仍在（不是消失）')
  {
    const l = q('.reason-label')?.textContent ?? ''
    ok(!l.includes('推理中'), `工具执行中不再显示「推理中」（应为耗时）：「${l}」`)
  }

  /* ---- 2b. 工具跑完、模型又开始想（第二段）→ 继续展开、标题回到「推理中」 ---- */
  const SECOND = THINK + '\n\n第二轮：再看看有没有更短的走法。'
  /*
   * 用**重试 + 全量 sync 注入**，而不是只发一次 msg-update。
   * 为什么：真实会话的 sync 推送可能在任意时刻到达并盖掉注入的假数据 ——
   * 单发一次 msg-update 时，如果那一刻正好被覆盖（r-a1 不存在），
   * 就什么都注入不进去，探针随机失败（批量跑时踩过）。
   */
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
  ok(!!q('[data-testid="reasoning-body"]'), '第二段推理仍然展开（窗口全程不折）')
  ok((q('.reason-label')?.textContent ?? '').includes('推理中'), '第二段思考时标题回到「推理中」')
  /* 逐字可能还在追，等它追到第二段结尾（不是一次性贴上来） */
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
  await sleep(500)

  ok(!!q('[data-testid="reasoning"]'), '回合结束后胶囊还在（不是消失）')
  ok(!q('[data-testid="reasoning-body"]'), '回合结束后自动折叠（正文收起）')
  const label2 = q('.reason-label')?.textContent ?? ''
  ok(label2.includes('8'), `标题给出耗时 =「${label2}」（应为「已推理 8 秒」）`)
  ok(!!q('.reason-peek'), '折叠态有一行预览（不用展开就知道在想什么）')

  /* ---- 4. 点开关能重新打开 ---- */
  q('[data-testid="reasoning-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await sleep(300)
  ok(!!q('[data-testid="reasoning-body"]'), '点开关能再打开（保留开关）')

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
