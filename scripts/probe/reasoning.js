/*
 * 推理限高省略（N04 修订版 / 2026-09-15 用户确认）。
 *
 * 这里不烧 token：直接往真实 renderer store 注入带 thinking 的助手消息，
 * 但渲染、状态、滚动和折叠都走生产代码。
 *
 * 验收重点：
 *   · 只展示上游实际返回的推理文本；按字素增量追上，emoji 不被拆坏
 *   · 默认展开但**钉在 --reason-max-h**，超出部分裁掉，不把回答顶出屏幕
 *   · 裁掉的是**开头**：scrollTop 贴底 → 始终看得到最新一句
 *   · 被裁剪时才有顶部渐隐 + 「展开全部」；短推理不淡化、不出现按钮
 *   · 用 overflow:hidden 而不是可滚动容器 —— 没有第二条滚动条
 *   · 第一段推理结束进入工具阶段时不折叠；第二段推理接着显示
 *   · 整个助手回合结束后自动折叠，保留预览和手动打开入口
 *
 * ⚠️ 这份探针在 2026-09-15 之前断言的是**相反**的契约
 *    （overflow=visible / 高度随内容自然增长 / 没有内部滚动）。
 *    改的是产品决定，不是修 bug；旧断言已按新契约反转，别再改回去。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  /* 外层（.reason-body）才承载 hidden/aria/裁剪；内层 data-testid 只承载文字。 */
  const body = () => q('.reason-body')
  const inner = () => q('[data-testid="reasoning-body"]')
  const isOpen = () => {
    const el = body()
    return !!el && !el.hasAttribute('hidden') && el.getBoundingClientRect().height > 20
  }
  /** 内容是否真的超出了钉住的高度 */
  const overflows = () => {
    const el = body()
    return !!el && el.scrollHeight > el.clientHeight + 1
  }
  /** 顶部渐隐是否生效（-webkit- 与标准属性都要看，'none' 是 truthy 字符串） */
  const maskOf = () => {
    const el = body()
    if (!el) return 'none'
    const cs = getComputedStyle(el)
    const std = cs.maskImage
    const webkit = cs.webkitMaskImage
    if (std && std !== 'none') return std
    if (webkit && webkit !== 'none') return webkit
    return 'none'
  }
  /** 是否贴着底边（= 显示的是最新内容） */
  const atBottom = () => {
    const el = body()
    return !!el && el.scrollTop + el.clientHeight >= el.scrollHeight - 2
  }
  const click = (sel) => {
    const el = q(sel)
    if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return !!el
  }

  const THINK =
    '先看题目：狼会吃羊，羊会吃白菜。' +
    'First check the invariant, then move the safe item. 🧭👩‍💻 ' +
    '关键是把羊先带过去，再把羊带回来。'.repeat(80)

  log('=== 推理限高省略：钉高 / 看最新 / 顶部渐隐 / 展开全部 ===')

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

  /** 控制整个助手回合是否仍在进行（含工具阶段）。 */
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

  ok(!!cap, '推理块被渲染（上游有 thinking 文本）')
  if (!cap) return out.join('\n')

  const label = q('.reason-label')?.textContent ?? ''
  ok(label.includes('推理中'), `正在推理时标题 =「${label}」`)
  ok(isOpen(), '正在推理时默认展开')
  ok(!!q('[data-layout="clip"]'), '推理块标记为裁剪布局（data-layout=clip）')

  {
    const cs = getComputedStyle(body())
    ok(cs.overflowY === 'hidden', `没有可滚动的滚动条（overflow-y=${cs.overflowY}）`)
    ok(cs.maxHeight !== 'none', `高度被 --reason-max-h 钉住（max-height=${cs.maxHeight}）`)
  }
  ok(
    !q('.reason-body-wrap') && !q('.reason-grip') && !q('.reason-jump'),
    '没有旧固定窗口、尺寸把手或回到最新按钮'
  )

  /* 逐字流式：body 的文字会逐步追上来，轮询等它追到结尾。 */
  let shownLen = 0
  for (let i = 0; i < 60; i++) {
    shownLen = (inner()?.textContent ?? '').length
    if (shownLen >= THINK.length) break
    await sleep(150)
  }
  log(`  逐字进度：${shownLen} / ${THINK.length}`)
  ok(shownLen >= THINK.length, '推理文本逐字追上（不是一次性贴上来）')
  ok((inner()?.textContent ?? '').includes('🧭👩‍💻'), 'emoji 保持完整，没有被 UTF-16 截断')

  /* ---- 省略态：真的裁了、裁的是开头、顶部渐隐 ---- */
  {
    const el = body()
    log(
      `  裁剪几何：scroll=${el.scrollHeight} client=${el.clientHeight} ` +
        `top=${Math.round(el.scrollTop)} mask=${maskOf() === 'none' ? 'none' : 'on'}`
    )
    ok(overflows(), '超长推理被裁剪（scrollHeight > clientHeight）')
    ok(el.dataset.clipped === '1', 'data-clipped=1 标记已裁剪')
    ok(el.classList.contains('is-clipped'), 'is-clipped 只在被裁剪时出现')
    ok(el.scrollTop > 0, `裁掉的是开头（scrollTop=${Math.round(el.scrollTop)} > 0）`)
    ok(atBottom(), '贴着底边：最新一句始终可见')
    ok(maskOf() !== 'none', `顶部有渐隐遮罩（${maskOf().slice(0, 30)}…）`)
  }

  /* ---- 「展开全部 / 收起」出口 ---- */
  {
    const btn = q('[data-testid="reasoning-expand"]')
    ok(!!btn, `被裁剪时出现出口按钮（「${btn?.textContent ?? ''}」）`)

    click('[data-testid="reasoning-expand"]')
    await sleep(300)
    ok(!overflows(), '展开全部后不再裁剪（完整高度）')
    ok(body().classList.contains('expanded'), 'body 标记 expanded')
    ok(!body().classList.contains('is-clipped'), '展开后不再渐隐')
    const t2 = q('[data-testid="reasoning-expand"]')?.textContent ?? ''
    ok(t2.includes('收起'), `按钮变为「${t2}」`)

    click('[data-testid="reasoning-expand"]')
    await sleep(300)
    ok(overflows(), '收起后重新裁剪')
    ok(atBottom(), '收起后仍然贴底看最新')
  }

  /* ---- 内容继续变长：高度不变，而不是把回答顶出屏幕 ---- */
  const h1 = body().getBoundingClientRect().height
  store.getState().applyPush({
    ch: 'msg-update',
    payload: { id: 'r-a1', patch: { thinking: THINK + '\n\n（继续推演）'.repeat(300) } }
  })
  await sleep(900)
  const h2 = body().getBoundingClientRect().height
  log(`  钉住高度：${Math.round(h1)}px → ${Math.round(h2)}px`)
  ok(Math.abs(h2 - h1) < 2, '内容变多时高度不变（被钉住，不再随内容增长）')
  ok(h2 <= 260.5, `高度不超过上限（${Math.round(h2)}px ≤ 260px）`)
  ok(atBottom(), '内容增长后仍然贴底看最新')

  /* ---- 1. 第一段思考结束、开始调工具（回合仍在跑）→ 不折叠 ---- */
  store.getState().applyPush({
    ch: 'msg-update',
    payload: { id: 'r-a1', patch: { thinkingLive: false, thinkingMs: 4200 } }
  })
  setTurnStreaming(true)
  await sleep(500)
  ok(isOpen(), '第一段思考结束、工具开始跑时仍展开')
  ok(!!q('[data-testid="reasoning"]'), '工具阶段推理块仍在')
  {
    const l = q('.reason-label')?.textContent ?? ''
    ok(!l.includes('推理中'), `工具执行中不再显示「推理中」：「${l}」`)
  }

  /* ---- 2. 工具跑完、模型又开始想（第二段）→ 继续展开 ---- */
  const SECOND = THINK + '\n\n第二轮：再看看有没有更短的走法。'
  store.getState().applyPush({
    ch: 'sync',
    payload: [
      { id: 'r-user', role: 'user', text: '帮我解一下过河题' },
      { id: 'r-a1', role: 'assistant', text: '', thinking: SECOND, thinkingLive: true, thinkingMs: 4200 }
    ]
  })
  setTurnStreaming(true)
  for (let i = 0; i < 20; i++) {
    await sleep(150)
    if ((inner()?.textContent ?? '').includes('第二轮')) break
  }
  ok(isOpen(), '第二段推理仍然展开（窗口全程不折）')
  ok((q('.reason-label')?.textContent ?? '').includes('推理中'), '第二段思考时标题回到「推理中」')
  ok((inner()?.textContent ?? '').includes('第二轮'), '第二段推理追加在容器里（不是替换）')
  ok(atBottom(), '第二段推理到来后仍贴底看最新')

  /* ---- 3. 整个回合结束 → 自动折叠，正文仍保留在 DOM ---- */
  store.getState().applyPush({
    ch: 'msg-update',
    payload: { id: 'r-a1', patch: { thinkingLive: false, thinkingMs: 8000 } }
  })
  setTurnStreaming(false)
  await sleep(700)

  ok(!!q('[data-testid="reasoning"]'), '回合结束后推理块还在（不是消失）')
  log(
    `  折叠状态：open=${isOpen()} hidden=${body()?.hasAttribute('hidden')} ` +
      `aria=${body()?.getAttribute('aria-hidden')} height=${Math.round(body()?.getBoundingClientRect().height ?? -1)} ` +
      `streaming=${store.getState().session?.isStreaming} agent=${store.getState().session?.isAgentRunning} ` +
      `bodies=${document.querySelectorAll('[data-testid="reasoning-body"]').length}`
  )
  ok(!isOpen() && body().hasAttribute('hidden'), '回合结束后自动折叠')
  ok(!!body(), '折叠只隐藏正文，仍保留 DOM 与历史内容')
  ok(!q('[data-testid="reasoning-expand"]'), '折叠后不显示省略出口')
  const label2 = q('.reason-label')?.textContent ?? ''
  ok(label2.includes('8'), `标题给出耗时 =「${label2}」`)
  ok(!!q('.reason-peek'), '折叠态有一行预览')

  /* ---- 4. 手动开关能重新打开 ---- */
  click('[data-testid="reasoning-toggle"]')
  await sleep(400)
  ok(isOpen(), '点开关能重新打开历史推理')

  /* ---- 5. 短推理不淡化、不出现出口 ---- */
  store.getState().applyPush({
    ch: 'sync',
    payload: [
      { id: 'r-user3', role: 'user', text: '随便想想' },
      { id: 'r-a3', role: 'assistant', text: '', thinking: '想一下就好。', thinkingLive: true }
    ]
  })
  setTurnStreaming(true)
  await sleep(600)
  {
    const el = body()
    ok(!!el, '短推理仍然渲染（没有空壳，也没有消失）')
    ok(!overflows(), '短推理不裁剪')
    ok(el?.dataset.clipped !== '1', '短推理不加渐隐遮罩')
    ok(!q('[data-testid="reasoning-expand"]'), '短推理不出现「展开全部」')
  }

  /* ---- 6. 没有推理的回合不许出现空壳 ---- */
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
  ok(!q('[data-testid="reasoning"]'), '没有推理时不渲染空壳')
  ok(!!q('[data-tools="1"]') || !!q('.trow'), '工具行照常渲染')

  return out.join('\n')
})()
