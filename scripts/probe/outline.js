;(async () => {
  const out = []
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

  for (let i = 0; i < 60; i++) { if (store.getState().conn === 'ready') break; await sleep(500) }
  store.getState().closeSettings()

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
  ok(ticks.length >= 3, `刻度数 ${ticks.length} ≥ 3（够渲染导航轨）`)
  ok(ticks.length <= bestTurns, `刻度数 ${ticks.length} ≤ 用户消息数 ${bestTurns}（合并只会减少）`)
  ok(ticks.length === qa('.outline-hit').length, '每格刻度都有可点区域')
  ok(qa('.outline-tick.on').length === 1 || qa('.outline-hit.on').length === 1, '恰好一个高亮')

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
      out.push(`  顶部诊断：scrollTop=${box.scrollTop} streams=${JSON.stringify(qa('.stream').map(node => ({ top: node.scrollTop, height: node.clientHeight, scroll: node.scrollHeight })))} callback=${String(store.getState().scrollToTurn).slice(0, 160)}`)
      ok(topIdx === 0, '滚到顶部时高亮第一格')
    }
  }

  const hitH = Math.round(ticks[0].getBoundingClientRect().height)
  out.push('  命中区高度: ' + hitH + 'px')
  ok(hitH >= 12, `每格命中区 ≥12px（实际 ${hitH}，之前只有 3px —— 这就是选不中的原因）`)

  const hitW = Math.round(ticks[0].getBoundingClientRect().width)
  out.push('  命中区宽度: ' + hitW + 'px')
  ok(hitW >= 24, `每格命中区 ≥24px（实际 ${hitW}）`)

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

  const track = q('.outline-track')
  const barGap = Math.round(parseFloat(getComputedStyle(track).rowGap || '0'))
  out.push('  轨道 gap: ' + barGap + 'px')

  let hasRule = false
  const flatRules = (rules) => { const out = []; for (const r of rules) { if (r.selectorText !== undefined || !r.cssRules) out.push(r); else if (r.conditionText !== undefined) out.push(r); if (r.cssRules) out.push(...flatRules(r.cssRules)) } return out }
  let hasHitRule = false
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of flatRules(sheet.cssRules)) {
        const s = rule.selectorText ?? ''
        if (s.includes('.outline-hit.hover .outline-bar')) hasHitRule = true
        if (s.includes(':has(.outline-hit.hover)')) hasRule = true
      }
    } catch {
    }
  }
  ok(hasHitRule, '存在「悬停时那一格就地展开」的 CSS 规则')
  ok(hasRule, '存在「悬停时其它格提亮」的 CSS 规则')
  ok(ol && getComputedStyle(ol).pointerEvents === 'none', '导航轨空白处不挡消息流（pointer-events:none）')

  const ul = store.getState().messages.filter(m => m.role === 'user')
  out.push('')
  out.push('=== 悬停与跳转 ===')
  ticks[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await sleep(400)
  ok(!!q('[data-testid="outline-preview"]'), '悬停弹出预览')
  const pv = q('[data-testid="outline-preview"]')
  const tb = ticks[0].getBoundingClientRect()
  const pb = pv?.getBoundingClientRect()
  if (pb) {
    const dTop = Math.round(Math.abs(pb.top + pb.height / 2 - (tb.top + tb.height / 2)))
    out.push('  预览卡中心与第 1 格的垂直偏差: ' + dTop + 'px')
    ok(dTop < 220, `预览卡跟着被指的那一格（偏差 ${dTop}px，不再固定居中）`)
  }

  const ptitle = q('[data-testid="outline-preview-title"]')
  const panswer = q('[data-testid="outline-preview-answer"]')
  ok(!!ptitle, '预览有标题（用户那一问的短摘要）')
  if (ptitle) {
    const txt = ptitle.textContent ?? ''
    out.push('  标题: ' + JSON.stringify(txt))
    if (/[A-Za-z]:[\\/]/.test(txt) || /\.(png|jpe?g|ts|tsx|js|json|md)\b/i.test(txt)) {
      out.push('  ⚠ 这条标题里带了路径/文件名（摘要质量问题，不影响界面断言）')
    }
    ok(txt.length <= 24, `标题够短（${txt.length} ≤ 24）`)
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

  out.push('')
  out.push('=== 回合合并与导航轨一致 ===')
  const turnCount = qa('[data-turn-id]').length
  out.push(`  用户轮数 ${ul.length}，渲染块数 ${turnCount}`)
  ok(turnCount > 0 && turnCount <= ul.length, '渲染块数落在 (0, 用户轮数] 内（虚拟滚动下只渲染视口内的块）')
  ok(after0(sc), '点击后确实滚动到了目标附近')

  out.push('')
  out.push('=== 长会话（40 轮）下刻度不被压扁 ===')
  const many = []
  for (let i = 0; i < 40; i++) {
    many.push({ id: `ol-u${i}`, role: 'user', text: `第 ${i + 1} 轮提问`, timestamp: Date.now() })
    many.push({ id: `ol-a${i}`, role: 'assistant', text: `第 ${i + 1} 轮回答`, timestamp: Date.now() })
  }
  store.setState({ messages: many })
  await sleep(1500)

  const longHits = qa('.outline-hit')
  const hitHeights = longHits.map((el) => Math.round(el.getBoundingClientRect().height))
  const barHeights = qa('.outline-bar').map((el) => Math.round(el.getBoundingClientRect().height))
  const trk = q('.outline-track')
  out.push(`  刻度格数: ${longHits.length} / 期望 40`)
  out.push(`  命中区高度: min ${Math.min(...hitHeights)} / max ${Math.max(...hitHeights)}`)
  out.push(`  刻度线高度: min ${Math.min(...barHeights)} / max ${Math.max(...barHeights)}`)
  if (trk) {
    out.push(
      `  轨道: clientH=${trk.clientHeight} scrollH=${trk.scrollHeight} ` +
        `overflowY=${getComputedStyle(trk).overflowY}`
    )
  }
  ok(longHits.length >= 30, `40 轮刻度都渲染出来了（实际 ${longHits.length}）`)
  ok(
    Math.min(...hitHeights) >= 12,
    `每格命中区仍 ≥12px（最小 ${Math.min(...hitHeights)}）—— 没被 flex 压扁`
  )
  ok(
    !!trk && trk.scrollHeight > trk.clientHeight,
    '刻度多于轨道高度时轨道自己可滚（而不是把格子压扁）'
  )
  ok(
    !!trk && getComputedStyle(trk).scrollbarWidth === 'none',
    '轨道不显示滚动条（scrollbar-width: none）'
  )

  return out.join('\n')

  function after0(el) {
    const firstUser = [...el.querySelectorAll('[data-turn-id]')].find(node => node.dataset.turnId === ul[0]?.id)
    if (!firstUser) return false
    return Math.abs(firstUser.getBoundingClientRect().top - el.getBoundingClientRect().top) < 260
  }
})()
