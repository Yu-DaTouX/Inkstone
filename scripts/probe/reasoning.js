/*
 * 推理流（2026-09-23 用户决定版）。
 *
 * 这里不烧 token：直接往真实 renderer store 注入带 thinking 的助手消息，
 * 但渲染、状态、滚动和开合都走生产代码。
 *
 * 验收重点：
 *   · 默认**折叠**成一行，显示原文里最新的一句（正在成形的末句也算）
 *   · 单击头部在**原位**展开全文，限高 min(70vh, 620px)，内部滚动，入口不掉
 *   · 开合只由用户动作驱动：流式不自动弹开，回合结束**不自动收起**
 *   · 展开后贴底才跟随新增内容；用户上滚阅读时位置保持
 *   · 逐字按字素推进，emoji 不被拆坏；reduced-motion 直接给全文且运行中切换生效
 *   · 没有推理不渲染空壳
 *   · 两段推理的顺序与 DOM 节点身份（实施-14 F6）
 *   · 切会话（换消息 id）不继承展开状态
 *
 * ⚠️ 这份探针在 2026-09-23 之前断言的是**相反**的契约
 *    （默认展开 / 裁掉开头贴底 / 回合结束自动折叠 / 出现「展开全部」按钮）。
 *    改的是产品决定，不是修 bug；旧断言已按新契约反转，别再改回去。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  /* 外层（.reason-body）才承载 hidden/aria/限高；内层 data-testid 只承载文字。 */
  const body = () => q('.reason-body')
  const inner = () => q('[data-testid="reasoning-body"]')
  const peek = () => q('[data-testid="reasoning-preview"]')?.textContent ?? null
  const isOpen = () => {
    const el = body()
    return !!el && !el.hasAttribute('hidden') && el.getBoundingClientRect().height > 20
  }
  /** 内容是否真的超出了钉住的高度 */
  const overflows = () => {
    const el = body()
    return !!el && el.scrollHeight > el.clientHeight + 1
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

  const push = (payload) => store.getState().applyPush({ ch: 'sync', payload })
  const patch = (id, p) => store.getState().applyPush({ ch: 'msg-update', payload: { id, patch: p } })

  log('=== 推理流：默认最新一句 / 原位展开限高 / 开合由用户决定 ===')

  let conn = store.getState().conn
  for (let i = 0; i < 40 && conn !== 'ready'; i++) {
    await sleep(250)
    conn = store.getState().conn
  }
  await sleep(1200)

  const setTurnStreaming = (v) => {
    const s = store.getState().session
    store.setState({ session: { ...(s ?? {}), isStreaming: v, isAgentRunning: v } })
  }

  const injectThinking = (text = THINK) =>
    push([
      { id: 'r-user', role: 'user', text: '帮我解一下过河题' },
      { id: 'r-a1', role: 'assistant', text: '', thinking: text, thinkingLive: true }
    ])

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

  /* ---- 1. 流式期间也是默认折叠的最新句 ---- */
  const label = q('.reason-label')?.textContent ?? ''
  ok(label.includes('推理中'), `正在推理时标题 =「${label}」`)
  ok(!isOpen(), '流式推理也保持默认折叠（不再随回合自动展开）')
  ok(!!q('[data-layout="reasoning"]'), '推理块使用当前正文布局契约')
  ok(
    !q('.reason-body-wrap') && !q('.reason-grip') && !q('.reason-jump') && !q('.reason-more'),
    '没有旧固定窗口、尺寸把手、回到最新按钮或「展开全部」出口'
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
  ok((peek() ?? '').includes('关键是把羊先带过去，再把羊带回来。'), '折叠预览显示最新完整句而非首行')

  /* ---- 2. 最新句的取句边界（中文 / 英文引号 / 句点版本号 / 无标点） ---- */
  {
    const cases = [
      ['第一句。正在处理', '正在处理'],
      ['Done!!”', 'Done!!”'],
      ['version 1.2 is stable. Next thought', 'Next thought'],
      ['No punctuation 🧭👩‍💻', 'No punctuation 🧭👩‍💻']
    ]
    for (let i = 0; i < cases.length; i++) {
      const [source, expected] = cases[i]
      push([
        { id: `reason-case-user-${i}`, role: 'user', text: 'preview case' },
        { id: `reason-case-assistant-${i}`, role: 'assistant', text: '', thinking: source }
      ])
      setTurnStreaming(false)
      await sleep(150)
      ok(peek() === expected, `sentence boundary: ${expected}（实际 ${JSON.stringify(peek())}）`)
    }
  }

  /* ---- 2b. 长句一行放不下时保留**尾端**（不靠 CSS，见 DESIGN V-2a） ---- */
  {
    const headText = '开头这些内容应该被截掉'.repeat(6)
    const tailText = '尾端标记🧭END'
    push([
      { id: 'reason-peek-user', role: 'user', text: 'preview long' },
      { id: 'reason-peek-assistant', role: 'assistant', text: '', thinking: headText + tailText }
    ])
    setTurnStreaming(false)
    await sleep(150)
    const p = peek() ?? ''
    out.push(`  长句预览：${p}`)
    ok(p.startsWith('…'), '长句预览以省略号开头（截掉的是开头）')
    ok(p.endsWith(tailText), '长句预览保留尾端内容')
    ok(p !== headText + tailText, '长句预览确实被截断（不等于完整句）')
    ok([...p].length === 61, `长句预览 = 省略号 + 60 字素（实际 ${[...p].length}）`)
    ok(!p.includes('\uFFFD'), '预览没有劈坏字素（无替换字符）')
    const peekEl = q('[data-testid="reasoning-preview"]')
    ok(peekEl?.getAttribute('dir') === 'rtl', '预览外层 dir=rtl（溢出挤到左侧）')
    ok(peekEl?.firstElementChild?.getAttribute('dir') === 'ltr', '预览内层 dir=ltr（隔离 bidi，顺序不重排）')
  }

  /* ---- 3. 单击头部：在原位展开全文 ---- */
  injectThinking()
  setTurnStreaming(true)
  await sleep(600)
  click('[data-testid="reasoning-toggle"]')
  await sleep(300)
  ok(isOpen(), '一次点击头部在原位打开全文')
  ok(body().classList.contains('open'), 'body 标记 open')
  ok(q('[data-testid="reasoning-toggle"]')?.getAttribute('aria-expanded') === 'true', '头部按钮 aria-expanded=true')
  ok(!q('[data-testid="reasoning-preview"]'), '展开态不再显示单行预览')

  const expandedCS = getComputedStyle(body())
  out.push(`  展开后 max-height=${expandedCS.maxHeight} overflow-y=${expandedCS.overflowY}`)
  ok(expandedCS.maxHeight !== 'none', '全文展开后有高度上限')
  ok(/auto|scroll/.test(expandedCS.overflowY), '超出上限的部分自己滚动')
  ok(overflows(), '超长全文确实发生内部滚动')
  const capExpected = Math.min(window.innerHeight * 0.7, 620)
  const capActual = body().getBoundingClientRect().height
  ok(
    capActual <= capExpected + 1,
    `展开高度受 min(70vh,620px) 约束（${Math.round(capActual)}px ≤ ${Math.round(capExpected)}px）`
  )

  /* 头部在 body 外面：body 内部滚动时它一动不动（收起入口不会滚丢） */
  const headTop1 = q('[data-testid="reasoning-toggle"]')?.getBoundingClientRect().top
  body().scrollTop = 99999
  await sleep(160)
  const headTop2 = q('[data-testid="reasoning-toggle"]')?.getBoundingClientRect().top
  out.push(`  内部滚动后头部 top ${Math.round(headTop1)} → ${Math.round(headTop2)}`)
  ok(headTop1 === headTop2, '推理块内部滚动时头部不动（收起入口不会滚丢）')
  ok(atBottom(), '滚到底后确实贴底')

  /* ---- 4. 用户上滚阅读时，新内容不把位置抢回底部 ---- */
  /* 离开「贴底」容差（24px）：scrollTop=0 时距底 49px，再更新才会验到“不跟随”。 */
  body().scrollTop = 0
  await sleep(80)
  out.push(
    `  上滚前：top=${body().scrollTop} sh=${body().scrollHeight} ch=${body().clientHeight} ` +
      `距底=${body().scrollHeight - body().clientHeight - body().scrollTop}`
  )
  patch('r-a1', { thinking: THINK + '\n\n新一段推演：继续比较两种走法。' })
  await sleep(60)
  const midTop = body().scrollTop
  await sleep(500)
  const held = body().scrollTop
  out.push(`  上滚诊断：60ms ${midTop} → 500ms ${Math.round(held)}（期望保持 0）`)
  ok(held <= 1, '用户上滚阅读时新增内容不抢回底部（位置保持）')

  /* 回到贴底后恢复跟随 */
  body().scrollTop = body().scrollHeight
  await sleep(80)
  out.push(`  回到底部：距底=${body().scrollHeight - body().clientHeight - body().scrollTop}`)
  patch('r-a1', { thinking: THINK + '\n\n新一段推演：继续比较两种走法。再补一句。' })
  await sleep(500)
  ok(atBottom(), '回到贴底后继续跟随新内容')

  /* ---- 5. 同一头部入口收起，回到最新句预览 ---- */
  click('[data-testid="reasoning-toggle"]')
  await sleep(300)
  ok(body().hasAttribute('hidden'), '同一头部入口收起全文')
  ok(!isOpen(), '收起后正文不可见')
  ok(!!peek(), '收起后回到一行最新句预览')
  ok(q('[data-testid="reasoning-toggle"]')?.getAttribute('aria-expanded') === 'false', '头部按钮 aria-expanded=false')

  /* ---- 6. 回合结束既不自动弹开、也不自动收起 ---- */
  {
    patch('r-a1', { thinkingLive: false, thinkingMs: 4200 })
    setTurnStreaming(true)
    await sleep(400)
    ok(!isOpen(), '第一段思考结束、工具阶段开始：仍是折叠预览（不自动弹开）')
    ok(!(q('.reason-label')?.textContent ?? '').includes('推理中'), '工具执行中不再显示「推理中」')

    click('[data-testid="reasoning-toggle"]')
    await sleep(250)
    ok(isOpen(), '工具阶段手动展开')

    patch('r-a1', { thinkingLive: false, thinkingMs: 8000 })
    setTurnStreaming(false)
    await sleep(700)
    ok(!!q('[data-testid="reasoning"]'), '回合结束后推理块还在（不是消失）')
    ok(isOpen(), '回合结束不自动收起用户手动展开的全文')
    ok((q('.reason-label')?.textContent ?? '').includes('8'), `标题给出耗时 =「${q('.reason-label')?.textContent}」`)

    click('[data-testid="reasoning-toggle"]')
    await sleep(250)
    ok(!isOpen(), '收起后保持折叠（回合已结束也不自动弹开）')
  }

  /* ---- 7. 短推理 / 无推理 ---- */
  {
    push([
      { id: 'r-user3', role: 'user', text: '随便想想' },
      { id: 'r-a3', role: 'assistant', text: '', thinking: '想一下就好。', thinkingLive: true }
    ])
    setTurnStreaming(true)
    await sleep(600)
    ok(!!body(), '短推理仍然渲染（没有空壳，也没有消失）')
    ok(!isOpen(), '短推理默认折叠')
    click('[data-testid="reasoning-toggle"]')
    await sleep(250)
    ok(isOpen() && !overflows(), '短推理展开也不出现内部滚动')
    click('[data-testid="reasoning-toggle"]')
    await sleep(200)

    push([
      { id: 'r-user2', role: 'user', text: '跑个命令' },
      {
        id: 'r-a2',
        role: 'assistant',
        text: '好了。',
        toolCalls: [{ id: 'r-c1', name: 'bash', args: { command: 'echo hi' }, status: 'ok' }]
      }
    ])
    await sleep(600)
    ok(!q('[data-testid="reasoning"]'), '没有推理时不渲染空壳')
    ok(!!q('[data-tools="1"]') || !!q('.trow'), '工具行照常渲染')
  }

  /* ---- 8. reduced-motion 运行中切换：已挂载也要停动画（R5） ---- */
  {
    let reduce = false
    const listeners = new Set()
    const realMM = window.matchMedia.bind(window)
    window.matchMedia = (q2) =>
      String(q2).includes('prefers-reduced-motion')
        ? {
            get matches() {
              return reduce
            },
            media: String(q2),
            onchange: null,
            addEventListener: (_t, cb) => listeners.add(cb),
            removeEventListener: (_t, cb) => listeners.delete(cb),
            addListener: (cb) => listeners.add(cb),
            removeListener: (cb) => listeners.delete(cb),
            dispatchEvent: () => false
          }
        : realMM(q2)
    const setReduce = (v) => {
      reduce = v
      for (const cb of [...listeners]) cb({ matches: v })
    }

    injectThinking()
    setTurnStreaming(true)
    await sleep(200)
    const partial = (inner()?.textContent ?? '').length
    ok(partial < THINK.length, `挂载后仍逐字（200ms 时 ${partial}/${THINK.length}）`)
    setReduce(true)
    await sleep(120)
    const full = (inner()?.textContent ?? '').length
    log(`  运行中切 reduce 后文本长度 = ${full} / 全文 ${THINK.length}`)
    ok(full >= THINK.length, '已挂载时切到 prefers-reduced-motion 立即给完整推理文本')
    setReduce(false)
    await sleep(120)
    ok((inner()?.textContent ?? '').length >= THINK.length, '切回默认偏好不倒退已显示内容')
    window.matchMedia = realMM
  }

  /* ---- 9. 切会话不继承展开状态 ---- */
  {
    push([
      { id: 'sessA-user', role: 'user', text: '会话 A' },
      { id: 'sessA-a', role: 'assistant', text: '', thinking: THINK, thinkingLive: true }
    ])
    setTurnStreaming(true)
    await sleep(600)
    click('[data-testid="reasoning-toggle"]')
    await sleep(250)
    ok(isOpen(), '会话 A 手动展开')

    push([
      { id: 'sessB-user', role: 'user', text: '会话 B' },
      { id: 'sessB-a', role: 'assistant', text: '', thinking: '乙会话的另一段思考。', thinkingLive: true }
    ])
    await sleep(500)
    ok(document.querySelectorAll('[data-testid="reasoning"]').length === 1, '切会话后只剩一个推理块')
    ok(!isOpen(), '切会话后回到默认折叠（不继承上一个会话的展开状态）')
    ok(!!peek(), '切会话后仍有最新句预览入口')
  }

  /* ---- 10. 多段推理的顺序与节点身份（实施-14 F6） ---- */
  {
    const messages = [
      { id: 'segment-user', role: 'user', text: '连续完成任务' },
      { id: 'segment-a', role: 'assistant', text: '已完成第一部分', thinking: '第一段思考' },
      { id: 'segment-b', role: 'assistant', text: '', thinking: '第二段正在思考', thinkingLive: true }
    ]
    push(messages)
    setTurnStreaming(true)
    for (let i = 0; i < 30 && document.querySelectorAll('[data-testid="reasoning"]').length < 2; i++) await sleep(50)
    const caps = [...document.querySelectorAll('[data-testid="reasoning"]')]
    const firstResponse = q('[data-testid="turn-response"]')
    ok(
      caps.length === 2 && !!firstResponse && !!(firstResponse.compareDocumentPosition(caps[1]) & Node.DOCUMENT_POSITION_FOLLOWING),
      '第二段还没正文时，推理就跟在第一段正式回复后'
    )
    patch('segment-b', { text: '第二部分完成', thinkingLive: false })
    for (let i = 0; i < 30 && document.querySelectorAll('[data-testid="turn-response"]').length < 2; i++) await sleep(50)
    const updatedCaps = [...document.querySelectorAll('[data-testid="reasoning"]')]
    ok(caps.length === 2 && updatedCaps[0] === caps[0] && updatedCaps[1] === caps[1], '第二段正文到达不重挂推理节点，保留展开状态')
  }

  return out.join('\n')
})()
