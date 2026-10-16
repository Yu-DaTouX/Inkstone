;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

  const seen = []
  window.yan.onHotkey?.((a) => seen.push({ a, t: Date.now() }))

  const obs = new MutationObserver(() => {
    const x = document.querySelector('[data-testid="ob-close"]')
    if (x) x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  obs.observe(document.body, { childList: true, subtree: true })

  out.push('=== 1. 打开设置面板 ===')
  if (q('.app')?.classList.contains('rail-off')) {
    q('[data-testid="rail-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 500))
  }
  const railBtn = q('[data-testid="rail-settings"]')
  ok(!!railBtn, '左栏底部有设置入口')
  const thinkBefore = store.getState().session?.thinkingLevel
  railBtn?.focus()
  const opener = document.activeElement
  ok(opener === railBtn, '前置条件：焦点能落在设置按钮上')
  if (railBtn) click(railBtn)
  await sleep(450)

  const panel = q('.settings')
  ok(!!panel, '设置面板已打开')
  const openAt = Date.now()

  out.push('')
  out.push('=== 2. 初始焦点进面板 ===')
  let focused = false
  for (let i = 0; i < 15; i++) {
    if (panel && document.activeElement && panel.contains(document.activeElement)) {
      focused = true
      break
    }
    await sleep(100)
  }
  ok(focused, `打开后焦点在面板内（${document.activeElement?.tagName ?? '-'}）`)

  out.push('')
  out.push('=== 3. Tab 圈定（合成事件；焦点移动是我们显式做的）===')
  const focusables = panel
    ? [...panel.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.disabled && el.getClientRects().length > 0 && el.tabIndex !== -1
      )
    : []
  out.push(`  面板内可聚焦元素: ${focusables.length}`)
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (last) last.focus()
  key('Tab')
  await sleep(80)
  ok(
    !!first && document.activeElement === first,
    '焦点在末尾按 Tab → 回到面板内第一个控件（没逃到背后的界面）'
  )
  if (first) first.focus()

  out.push('')
  out.push('=== 4. 模态守卫：面板打开时 Shift+Tab 不被抢（真按键）===')
  await sleep(3300)
  const closeAt = Date.now()
  const inWindow = seen.filter((x) => x.t >= openAt && x.t <= closeAt)
  out.push('  面板打开期间收到的动作: ' + JSON.stringify(inWindow.map((x) => x.a)))
  ok(
    inWindow.filter((x) => x.a === 'cycleThinking').length === 0,
    `面板打开期间没有收到 cycleThinking（区间内动作 ${inWindow.length} 个）`
  )
  ok(
    store.getState().session?.thinkingLevel === thinkBefore,
    `思考强度没被切换（${thinkBefore} → ${store.getState().session?.thinkingLevel}）`
  )

  out.push('')
  out.push('=== 5. Esc 关闭 + 焦点恢复 ===')
  key('Escape')
  await sleep(300)
  ok(!q('.settings'), 'Esc 关掉了设置面板')
  ok(
    document.activeElement === opener,
    `焦点回到了打开它的那个按钮（期望 ${opener?.className || opener?.tagName}，实际 ${
      document.activeElement?.className || document.activeElement?.tagName
    }）`
  )

  out.push('')
  out.push('=== 6. 关闭后快捷键恢复（真按键对照）===')
  let after = []
  for (let i = 0; i < 20; i++) {
    after = seen.filter((x) => x.t > closeAt)
    if (after.some((x) => x.a === 'cycleThinking')) break
    await sleep(200)
  }
  out.push('  关闭后动作: ' + JSON.stringify(after.map((x) => x.a)))
  out.push('  诊断: 设置面板还在=' + !!q('.settings') + ' isProbe=' + window.yan.isProbe)
  if (!after.some((x) => x.a === 'cycleThinking')) {
    out.push('  对照：手动把守卫复位，等下一个按键…')
    window.yan.setHotkeyGuard?.(false)
    const t0 = Date.now()
    for (let i = 0; i < 25; i++) {
      if (seen.some((x) => x.a === 'cycleThinking' && x.t > t0)) break
      await sleep(200)
    }
    const manual = seen.filter((x) => x.a === 'cycleThinking' && x.t > t0)
    out.push(
      `  手动复位后收到 ${manual.length} 个 —— ` +
        (manual.length > 0
          ? '渲染端似乎没有复位 guard（实现问题，需查）'
          : '对照按键也没到，更可能是时序抖动')
    )
  }
  ok(
    after.some((x) => x.a === 'cycleThinking'),
    '关闭面板后 Shift+Tab 恢复生效'
  )

  out.push('')
  out.push('=== 7. 纯图标按钮有可访问名称 ===')
  const stream = q('.stream')
  const inner = q('.stream-inner')
  if (inner) inner.style.minHeight = '3000px'
  if (stream) {
    stream.scrollTop = 0
    stream.dispatchEvent(new Event('scroll'))
    await sleep(150)
  }
  const jump = q('.jump-bottom')
  if (jump) {
    const label = jump.getAttribute('aria-label')
    out.push(`  「回到底部」aria-label = ${JSON.stringify(label)}`)
    ok(!!label && label.trim().length > 0, '「回到底部」有可访问名称')
  } else {
    ok(false, '没能让「回到底部」渲染出来（测试前提不成立）')
  }

  const nameless = [...document.querySelectorAll('button')].filter((b) => {
    const text = (b.textContent || '').trim()
    const named = b.getAttribute('aria-label') || b.getAttribute('title')
    return !text && !named
  })
  out.push(`  无名称按钮数: ${nameless.length}`)
  nameless.slice(0, 5).forEach((b) => out.push('  ✗ ' + b.className))
  ok(nameless.length === 0, '所有渲染出来的按钮都有文字或可访问名称')

  out.push('')
  out.push('=== 8. 普通问题：非模态、不抢焦点（方案第 6 节）===')
  store.getState().applyPush({
    ch: 'ui-request',
    payload: { id: 'probe-q1', method: 'input', message: '补充说明', placeholder: '写点什么' }
  })
  await sleep(500)
  const qp = q('[data-testid="question-panel"]')
  ok(!!qp, '普通问题渲染成输入区上方的问题面板')
  ok(!q('.modal-scrim'), '普通问题不再有遮罩（非模态）')
  ok(!qp || !qp.contains(document.activeElement), '问题到达不抢焦点')

  const outside = q('[data-testid="rail-settings"]') ?? q('[data-testid="composer"]')
  outside?.focus()
  ok(document.activeElement === outside, '面板打开时仍能把焦点移到界面其它部分（能继续操作与阅读）')

  const toggleBtn = q('[data-testid="question-panel-toggle"]')
  ok(!!toggleBtn, '面板有收起开关')
  toggleBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await sleep(250)
  ok(q('[data-testid="question-panel"]')?.classList.contains('collapsed'), '能收起面板')
  ok(
    store.getState().uiRequests.some((r) => r.id === 'probe-q1'),
    '收起不等于取消：请求仍在队列里（不发送取消，也不替你选默认值）'
  )
  ok(!!q('.qpanel-mini'), '收起后仍提示「有 N 个问题待回答」')

  q('[data-testid="question-panel-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await sleep(250)
  const inputEl = q('[data-testid="question-panel-input"]')
  ok(!!inputEl, '重新展开后输入框仍在（草稿随组件保留）')
  if (inputEl) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(inputEl, '我的回答')
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(150)
    q('[data-testid="question-panel-submit"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(350)
    ok(
      !store.getState().uiRequests.some((r) => r.id === 'probe-q1'),
      '提交后请求从队列移除'
    )
    ok(!q('[data-testid="question-panel"]'), '队列空了面板就消失')
  }

  out.push('')
  out.push('=== 9. 键盘可用性：关键控件是原生可聚焦元素（方案 B3）===')
  click(railBtn)
  await sleep(500)
  const panel2 = q('.settings')
  ok(!!panel2, '设置面板能再次打开')
  if (panel2) {
    const controls = [
      ...panel2.querySelectorAll('[role="tab"], .seg-btn, .ui-row-ctl button, .ui-row-ctl input, .ui-row-ctl select')
    ]
    const notFocusable = controls.filter((el) => el.tabIndex < 0 && el.getAttribute('role') !== 'tab')
    const notNative = controls.filter(
      (el) => !['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(el.tagName)
    )
    out.push(`  设置里的控件：${controls.length} 个，不可聚焦 ${notFocusable.length}，非原生 ${notNative.length}`)
    ok(controls.length >= 8, '设置面板里有很多可操作控件')
    ok(notFocusable.length === 0, '除页签（用方向键切换）外，控件都能被 Tab 聚焦')
    ok(notNative.length === 0, '全部是原生控件（Enter / Space 天然可用）')

    const density = q('[data-testid="set-density"]')
    ok(!!density, '密度分段控件存在')
    ok(
      density ? [...density.querySelectorAll('button')].length === 3 : false,
      '密度的三档都是原生 button'
    )

    key('Escape')
    await sleep(300)
    ok(!q('.settings'), '再次 Esc 关闭设置')
  }

  obs.disconnect()
  return out.join('\n')
})()
