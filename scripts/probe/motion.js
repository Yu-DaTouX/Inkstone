;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]

  for (let i = 0; i < 80; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  store.getState().closeSettings()
  await sleep(400)

  out.push('=== 1. 动效令牌 ===')
  const cs = getComputedStyle(document.documentElement)
  const tokens = ['--mo-fast', '--mo-base', '--mo-slow', '--mo-shift', '--mo-ease', '--mo-ease-out']
  for (const tk of tokens) {
    const v = cs.getPropertyValue(tk).trim()
    out.push(`  ${tk} = ${v || '(空)'}`)
    ok(!!v, `${tk} 有值`)
  }
  const ease = cs.getPropertyValue('--mo-ease').trim()
  ok(/cubic-bezier/.test(ease) && !/^linear/.test(ease), `--mo-ease 是非线性曲线（${ease}）`)

  out.push('')
  out.push('=== 2. 设置面板的入场与退场 ===')
  ok(!q('.settings-scrim'), '初始没有设置面板')

  store.getState().openSettings('appearance')
  await sleep(60)
  const scrimIn = q('.settings-scrim')
  ok(!!scrimIn, '打开后出现遮罩')
  const inAnim = scrimIn ? getComputedStyle(scrimIn).animationName : ''
  out.push('  入场动画: ' + inAnim)
  ok(inAnim && inAnim !== 'none', '遮罩有入场动画')

  const panel = q('.settings')
  const panelIn = panel ? getComputedStyle(panel).animationName : ''
  out.push('  面板入场动画: ' + panelIn)
  ok(panelIn && panelIn !== 'none', '面板有入场动画')

  await sleep(400)

  store.getState().closeSettings()
  await sleep(50)
  const scrimOut = q('.settings-scrim')
  const panelOut = q('.settings')
  ok(!!scrimOut && !!panelOut, '关闭后节点**没有立刻消失**（正在演退场）')

  const closingCls = panelOut?.classList.contains('closing')
  out.push('  面板有 .closing: ' + closingCls)
  ok(!!closingCls, '面板带上了 .closing')

  const outAnim = panelOut ? getComputedStyle(panelOut).animationName : ''
  out.push('  退场动画: ' + outAnim)
  ok(/out/.test(outAnim), `退场用的是 out 关键帧（${outAnim}）`)
  ok(outAnim !== panelIn, '入场与退场用的是不同关键帧（否则没有对称感）')

  await sleep(500)
  ok(!q('.settings-scrim') && !q('.settings'), '退场结束后节点被卸载（不会永久挡着）')

  out.push('')
  out.push('=== 3. 退场中重新打开 ===')
  store.getState().openSettings('status')
  await sleep(400)
  store.getState().closeSettings()
  await sleep(30)
  ok(!!q('.settings'), '关闭后还在演退场')
  store.getState().openSettings('status')
  await sleep(80)
  const reopened = q('.settings')
  ok(!!reopened, '重新打开后面板还在')
  ok(!reopened?.classList.contains('closing'), '重新打开会取消 .closing（不会卡在半透明）')
  ok(reopened?.classList.contains('settings'), '面板类名正常')
  await sleep(300)
  store.getState().closeSettings()
  await sleep(400)

  out.push('')
  out.push('=== 4. 通知条 ===')
  window.__yanStore.setState({ startupPhase: false })
  store.getState().applyPush({
    ch: 'notify',
    payload: { id: 't-anim-1', method: 'notify', message: '动效探针测试通知' }
  })
  await sleep(150)
  const notice = q('.notice')
  ok(!!notice, '通知渲染了')
  if (notice) {
    const an = getComputedStyle(notice).animationName
    out.push('  通知入场动画: ' + an)
    ok(an && an !== 'none', '通知有入场动画')
    out.push('  --i = ' + getComputedStyle(notice).getPropertyValue('--i').trim())
  }

  const id = store.getState().notices[0]?.id
  if (id) {
    store.getState().dismissNotice(id)
    await sleep(40)
    const leaving = q('.notice.closing')
    ok(!!leaving, '被关闭的通知带上了 .closing（在演退场）')
    await sleep(400)
    ok(!q('.notice'), '退场结束后通知被移除')
  } else {
    out.push('  ⚠️ 没拿到通知 id，跳过退场断言')
  }

  out.push('')
  out.push('=== 5. prefers-reduced-motion 的处理 ===')
  const flatRules = (rules) => { const out = []; for (const r of rules) { if (r.selectorText !== undefined || !r.cssRules) out.push(r); else if (r.conditionText !== undefined) out.push(r); if (r.cssRules) out.push(...flatRules(r.cssRules)) } return out }
  const durations = new Set()
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of flatRules(sheet.cssRules)) {
        if (rule.type === CSSRule.MEDIA_RULE && rule.conditionText?.includes('prefers-reduced-motion')) {
          for (const inner of rule.cssRules) {
            const d = inner.style?.animationDuration
            if (d) durations.add(d)
          }
        }
      }
    } catch {
    }
  }
  const durationList = [...durations]
  out.push('  reduced-motion 里出现的 animation-duration = ' + JSON.stringify(durationList))
  ok(
    durationList.includes('1ms') || durationList.includes('var(--dur-1)'),
    '减少动效时存在把时长压到 1ms 的规则（不是 animation:none —— 那会造成空窗）'
  )

  out.push('')
  out.push('=== 6. 段落淡入 ===')
  for (const s of store.getState().sessions.filter((x) => (x.messageCount ?? 0) > 2).slice(0, 5)) {
    await store.getState().switchSession(s.path)
    await sleep(1600)
    if (q('.turn-para')) break
  }
  const para = q('.turn-para')
  if (para) {
    const an = getComputedStyle(para).animationName
    out.push('  .turn-para 动画: ' + an)
    ok(an && an !== 'none', '段落有淡入动画（新到的段会自己浮现）')
    ok(qa('.turn-para').length > 1, `有多个段落（${qa('.turn-para').length} 段）`)
  } else {
    out.push('  ⚠️ 这份 fixture 没有段落，跳过')
  }

  out.push('')
  out.push('=== 7. 消息合并 ===')

  let best = null
  let bestRun = 0
  for (const s of store.getState().sessions.filter((x) => (x.messageCount ?? 0) > 2).slice(0, 8)) {
    await store.getState().switchSession(s.path)
    await sleep(1500)
    let cur = 0
    let maxRun = 0
    for (const m of store.getState().messages) {
      if (m.role === 'assistant') {
        cur++
        maxRun = Math.max(maxRun, cur)
      } else cur = 0
    }
    if (maxRun > bestRun) {
      bestRun = maxRun
      best = s
    }
    if (bestRun >= 3) break
  }
  if (best) {
    await store.getState().switchSession(best.path)
    await sleep(3500)
  }

  const msgs = store.getState().messages
  const blocks = qa('[data-turn-id]').length
  const rawAssistants = msgs.filter((m) => m.role === 'assistant').length
  const assistants = qa('.msg.assistant').length
  out.push(`  原始消息 ${msgs.length} → 渲染块 ${blocks}`)
  out.push(`  assistant: 原始 ${rawAssistants} → 块 ${assistants}`)
  out.push(`  最长连续 assistant = ${bestRun}`)
  ok(blocks <= msgs.length, '渲染块数不超过原始消息数')

  if (bestRun >= 2) {
    ok(
      assistants < rawAssistants,
      `连续 assistant 被合并了（${rawAssistants} → ${assistants}，最长连续 ${bestRun}）`
    )
    const paras = qa('.turn-para').length
    out.push(`  .turn-para 段数 = ${paras}`)
    ok(paras >= assistants, '合并块里拆出了多个段落（不是一坨）')
    const steps = qa('.msg-turn-count')
    out.push(`  「N 步」标记数 = ${steps.length}`)
  } else {
    out.push('  ⚠️ 这份 fixture 没有连续 assistant，跳过合并断言')
  }

  out.push('')
  out.push('=== 8. 回合内顺序：模型说话 → 执行栏 → 回复 ===')
  {
    const SEL_COM = '[data-testid="turn-commentary"]'
    const SEL_ACT = '[data-testid="turn-activity"]'
    const SEL_RES = '[data-testid="turn-response"]'

    const assistants = qa('.msg.assistant')
    const host =
      assistants.find((el) => el.querySelector(SEL_COM) && el.querySelector(SEL_ACT) && el.querySelector(SEL_RES)) ??
      assistants.find((el) => el.querySelector(SEL_COM) && el.querySelector(SEL_ACT)) ??
      null

    if (host) {
      const body = host.querySelector('.msg-body')
      const kids = [...(body?.children ?? [])]
      const idx = (s) => kids.findIndex((k) => k.matches(s))
      const iCom = idx(SEL_COM)
      const iAct = idx(SEL_ACT)
      const iRes = idx(SEL_RES)
      out.push(`  DOM 下标：说话=${iCom} 执行栏=${iAct} 回复=${iRes}`)

      if (iCom >= 0 && iAct >= 0) ok(iCom < iAct, '模型说话排在 执行栏 之前')
      if (iAct >= 0 && iRes >= 0) ok(iAct < iRes, '执行栏 排在 回复 之前')
      if (iCom >= 0 && iRes >= 0) ok(iCom < iRes, '模型说话排在 回复 之前')

      const rect = (s) => host.querySelector(s)?.getBoundingClientRect() ?? null
      const rc = rect(SEL_COM)
      const ra = rect(SEL_ACT)
      const rr = rect(SEL_RES)
      if (rc && ra) {
        out.push(`  纵向位置：说话 top=${Math.round(rc.top)} 执行栏 top=${Math.round(ra.top)}`)
        ok(rc.top < ra.top, '视觉上解说在执行栏上方')
      }
      if (ra && rr) {
        out.push(`  纵向位置：执行栏 top=${Math.round(ra.top)} 回复 top=${Math.round(rr.top)}`)
        ok(ra.top < rr.top, '视觉上执行栏在回复上方')
      }

      const act = host.querySelector(SEL_ACT)
      if (act) {
        const cs2 = getComputedStyle(act)
        const hasBar = cs2.borderTopWidth !== '0px' || cs2.backgroundColor !== 'rgba(0, 0, 0, 0)'
        out.push(`  执行栏样式: bg=${cs2.backgroundColor} borderTop=${cs2.borderTopWidth}`)
        ok(hasBar, '执行栏有背景或边框（看得出是一条横条）')
      }
    } else {
      out.push('  ⚠️ 没有同时含解说与执行栏的回合')
      const single = qa('.msg.assistant').length
      out.push(`  助手回合数 = ${single}`)
      if (!single) {
        out.push('  ~ 跳过：当前没有渲染出的助手回合（长会话走虚拟列表），图标判据不适用')
      } else {
        const mark = q('.msg.assistant .gutter .ico, .msg.assistant .gutter svg')
        ok(!!mark, '助手回合有左侧砚图标')
      }
    }
  }

  out.push('')
  out.push('=== 9. 输入区运行条：只在运行时出现 ===')
  {
    const cb = q('[data-testid="composer-border"]')
    ok(!!cb, '输入框有运行条')
    if (cb) {
      ok(!cb.querySelector('.cborder-row'), '运行条已收敛为无文字钩子（不再有行容器）')
      if (cb.dataset.state === 'idle') {
        ok(cb.getBoundingClientRect().height < 2, '空闲时运行条不占高度（' + cb.getBoundingClientRect().height.toFixed(1) + 'px）')
      }

      const level = cb.dataset.level ?? 'off'
      out.push('  data-level = ' + level)
      const prevTransition = cb.style.transition
      cb.style.transition = 'none'
      const col = (lv) => {
        cb.dataset.level = lv
        return getComputedStyle(cb).color
      }
      const cOff = col('off')
      const cMed = col('medium')
      const cMax = col('max')
      cb.dataset.level = level
      cb.style.transition = prevTransition
      out.push('  off=' + cOff + ' medium=' + cMed + ' max=' + cMax)
      ok(cOff !== cMax, '不同思考强度有不同边框色（off ≠ max）')
      ok(cOff !== cMed && cMed !== cMax, '三档三色（不是只有两档不同）')

      const root = getComputedStyle(document.documentElement)
      const hexToRgb = (h) => {
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h.trim())
        return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : ''
      }
      const offTok = hexToRgb(root.getPropertyValue('--think-off'))
      out.push('  --think-off = ' + root.getPropertyValue('--think-off').trim() + ' → ' + offTok)
      ok(offTok === '' || offTok === cOff, 'off 档的颜色与 --think-off 一致')

      const st = cb.dataset.state
      out.push('  data-state = ' + st)
      ok(st === 'idle' || st === 'working' || st === 'compacting', 'state 是三种之一（' + st + '）')

      const lead = q('.cbar-lead'), tail = q('.cbar-tail')
      if (tail) {
        const cs3 = getComputedStyle(tail)
        const h = tail.getBoundingClientRect().height
        out.push('  横线高度 = ' + h + 'px（' + cs3.backgroundColor + '）')
        ok(h <= 2, '横线是 1px 细线（不是色块）')
      }
      if (cb.dataset.state === 'idle') {
        const leadHidden = lead ? getComputedStyle(lead).display === 'none' : true
        out.push('  空闲时 lead 隐藏 = ' + leadHidden)
        ok(leadHidden, '空闲时前缀横线隐藏（保证线是完整连续的）')
      }

      ok(!q('.working'), '消息流里不再有独立的「正在处理」行')
    }
  }

  return out.join('\n')
})()
