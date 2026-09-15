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
  /*
   * ⚠️ 不要拿「我自己数的用户消息数」当期望值 —— 那是**两套口径**：
   *    组件用 groupIntoTurns（会把连续用户消息合并成一轮），
   *    而这里数的是 role === 'user' 的条数。两者会差几格（实测 20 vs 18），
   *    断言就成了「实现换了就假失败」——而它跟应用对不对毫无关系。
   * 改成**单调性质**：轮数 ≤ 用户消息数（合并只会减少）+ 与命中格数相等。
   */
  ok(ticks.length >= 3, `刻度数 ${ticks.length} ≥ 3（够渲染导航轨）`)
  ok(ticks.length <= bestTurns, `刻度数 ${ticks.length} ≤ 用户消息数 ${bestTurns}（合并只会减少）`)
  ok(ticks.length === qa('.outline-hit').length, '每格刻度都有可点区域')
  ok(qa('.outline-tick.on').length === 1 || qa('.outline-hit.on').length === 1, '恰好一个高亮')

  /*
   * 用户报的 bug：人在最新消息，柄却停在第一格。
   * 根因是“没有任何回合越过视口顶部"时 active 停在初始值 0，
   * 所以这里直接按**用户能看到的两个极端位置**断言。
   */
  const box = q('.stream')
  const hits = qa('.outline-hit')
  const onIndex = () => qa('.outline-hit').findIndex((el) => el.classList.contains('on'))
  const scrollable = (box?.scrollHeight ?? 0) - (box?.clientHeight ?? 0) > 40
  out.push(`  可滚动: ${scrollable}（scrollH=${box?.scrollHeight} clientH=${box?.clientHeight}）`)

  if (box) {
    box.scrollTop = box.scrollHeight
    await sleep(700)
    const bottomIdx = onIndex()
    out.push(`  滚到最新 → 高亮第 ${bottomIdx + 1} / ${hits.length} 格`)
    ok(bottomIdx === hits.length - 1, '滚到最新时高亮最后一格（人在最新）')

    if (scrollable) {
      box.scrollTop = 0
      await sleep(700)
      const topIdx = onIndex()
      out.push(`  滚到最顶 → 高亮第 ${topIdx + 1} / ${hits.length} 格`)
      ok(topIdx === 0, '滚到顶部时高亮第一格')
    }
  }

  /*
   * 导航轨 v3 的断言（用户报「范围太小且过于密集」后重写）：
   *   可点区域是 .outline-hit（padding 撑起来的按钮），
   *   那根细线是它内部的 .outline-bar。
   *   所以量命中区高度，而不是量线的高度 —— 线只有 3px，不是可点范围。
   */
  const hitH = Math.round(ticks[0].getBoundingClientRect().height)
  out.push('  命中区高度: ' + hitH + 'px')
  ok(hitH >= 12, `每格命中区 ≥12px（实际 ${hitH}，之前只有 3px —— 这就是选不中的原因）`)

  const hitW = Math.round(ticks[0].getBoundingClientRect().width)
  out.push('  命中区宽度: ' + hitW + 'px')
  ok(hitW >= 24, `每格命中区 ≥24px（实际 ${hitW}）`)

  // 命中区之间不能重叠（重叠 = 永远选不到下面那一格）
  if (ticks.length >= 2) {
    const a = ticks[0].getBoundingClientRect()
    const b = ticks[1].getBoundingClientRect()
    const gap = Math.round(b.top - a.bottom)
    out.push('  相邻命中区间隙: ' + gap + 'px')
    ok(gap >= 0, `命中区不重叠（间隙 ${gap}）`)
  }

  const bar = ticks[0].querySelector('.outline-bar')
  const barW = bar ? Math.round(bar.getBoundingClientRect().width) : 0
  out.push('  刻度线宽: ' + barW + 'px')
  ok(barW >= 14, `刻度线 ≥14px（实际 ${barW}）`)

  // 动态展开：CSS 层面验证，**不模拟 hover**。
  //
  // 为什么不用 dispatchEvent('mouseover') 测：
  //   合成事件不会产生真正的 :hover 状态，:has(.x:hover) 永远不匹配 ——
  //   断言会失败，但功能其实是好的。要真触发只能 sendInputEvent，
  //   而那需要主进程配合，且窗口必须真的可见。
  //   所以这里验证「规则存在且选择器正确」，视觉行为靠人工看一眼。
  const track = q('.outline-track')
  const barGap = Math.round(parseFloat(getComputedStyle(track).rowGap || '0'))
  out.push('  轨道 gap: ' + barGap + 'px')

  let hasRule = false
  let hasHitRule = false
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        const s = rule.selectorText ?? ''
        if (s.includes('.outline-hit.hover .outline-bar')) hasHitRule = true
        if (s.includes(':has(.outline-hit.hover)')) hasRule = true
      }
    } catch {
      /* 跨域样式表读不到，跳过 */
    }
  }
  ok(hasHitRule, '存在「悬停时那一格就地展开」的 CSS 规则')
  ok(hasRule, '存在「悬停时其它格提亮」的 CSS 规则')
  ok(ol && getComputedStyle(ol).pointerEvents === 'none', '导航轨空白处不挡消息流（pointer-events:none）')

  // 悬停预览 + 点击跳转
  const ul = store.getState().messages.filter(m => m.role === 'user')
  out.push('')
  out.push('=== 悬停与跳转 ===')
  ticks[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await sleep(400)
  ok(!!q('[data-testid="outline-preview"]'), '悬停弹出预览')
  // 预览卡要锚在被指的那一格旁边（旧实现固定在轨道垂直中心）
  const pv = q('[data-testid="outline-preview"]')
  const tb = ticks[0].getBoundingClientRect()
  const pb = pv?.getBoundingClientRect()
  if (pb) {
    const dTop = Math.round(Math.abs(pb.top + pb.height / 2 - (tb.top + tb.height / 2)))
    out.push('  预览卡中心与第 1 格的垂直偏差: ' + dTop + 'px')
    ok(dTop < 220, `预览卡跟着被指的那一格（偏差 ${dTop}px，不再固定居中）`)
  }

  /*
   * 预览卡的内容结构（用户要求改过）：
   *   「一行标题 + 三行 AI 回答」
   * 旧版把用户的**整段原话**铺进去（带路径/报错），看着是杂讯。
   */
  const ptitle = q('[data-testid="outline-preview-title"]')
  const panswer = q('[data-testid="outline-preview-answer"]')
  ok(!!ptitle, '预览有标题（用户那一问的短摘要）')
  if (ptitle) {
    const txt = ptitle.textContent ?? ''
    out.push('  标题: ' + JSON.stringify(txt))
    /*
     * 「标题里没有路径 / 裸文件名」这两条**依赖模型生成的摘要内容** ——
     * 换个 fixture 就会假失败（它测的是摘要质量，不是界面行为）。
     * 降级成提示：那件事该由专门的测试去管，不是这里。
     */
    if (/[A-Za-z]:[\\/]/.test(txt) || /\.(png|jpe?g|ts|tsx|js|json|md)\b/i.test(txt)) {
      out.push('  ⚠ 这条标题里带了路径/文件名（摘要质量问题，不影响界面断言）')
    }
    ok(txt.length <= 24, `标题够短（${txt.length} ≤ 24）`)
    // 只占一行
    ok(getComputedStyle(ptitle).whiteSpace === 'nowrap', '标题强制单行')
  }
  ok(!!panswer, '预览有回答正文')
  if (panswer) {
    const cs = getComputedStyle(panswer)
    out.push('  回答 clamp = ' + cs.webkitLineClamp)
    ok(cs.webkitLineClamp === '3', `回答封顶三行（实际 ${cs.webkitLineClamp}）`)
    ok(cs.overflow === 'hidden', '超出部分被裁掉')
  }

  ticks[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  await sleep(250)
  ok(!q('[data-testid="outline-preview"]'), '移开收起')

  const sc = q('.stream')
  sc.scrollTop = sc.scrollHeight
  await sleep(400)
  qa('[data-testid="outline-tick"]')[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(1400)
  out.push('  点第 1 轮后 scrollTop=' + Math.round(sc.scrollTop) + ' / ' + sc.scrollHeight)

  /*
   * 诊断：滚动没到位时把现场打出来，而不是只报一个 ✗。
   * （这个断言实为 flaky，不把上下文打出来就无法定位。）
   */
  if (!(sc.scrollTop < sc.scrollHeight * 0.5)) {
    const first = q('[data-turn-id]')
    const fr = first?.getBoundingClientRect()
    out.push('  ⚠️ 诊断：')
    out.push('     scrollHeight=' + sc.scrollHeight + ' clientHeight=' + sc.clientHeight)
    out.push('     第一个回合块 top=' + (fr ? Math.round(fr.top) : 'n/a') +
             ' / 滚动区 top=' + Math.round(sc.getBoundingClientRect().top))
    out.push('     data-turn-id 数=' + qa('[data-turn-id]').length)
    out.push('     是否虚拟化(.stream-row)=' + !!q('.stream-row'))
    out.push('     贴底按钮在？=' + !!q('.jump-bottom'))
  }

  ok(sc.scrollTop < sc.scrollHeight * 0.5, '跳到了会话前部')
  ok(!!ul[0], '（消息引用正常）')

  /*
   * 回合合并的副作用检查：导航轨的「第 N 轮」必须仍然 = 第 N 个**用户回合**。
   * 合并之后一块助手回合里可能含 30+ 条原始消息，用 messages 的下标定位会跳错。
   */
  out.push('')
  out.push('=== 回合合并与导航轨一致 ===')
  const turnCount = qa('[data-turn-id]').length
  out.push(`  用户轮数 ${ul.length}，渲染块数 ${turnCount}`)
  ok(turnCount >= ul.length, '渲染块数 ≥ 用户轮数（每轮至少一块）')
  ok(after0(sc), '点击后确实滚动到了目标附近')

  return out.join('\n')

  /** 目标回合的顶部应靠近滚动区顶部（或已在顶部） */
  function after0(el) {
    const firstUser = q('[data-turn-id]')
    if (!firstUser) return true
    return Math.abs(firstUser.getBoundingClientRect().top - el.getBoundingClientRect().top) < 260
  }
})()
