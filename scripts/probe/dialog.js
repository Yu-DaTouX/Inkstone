/**
 * 弹窗的就地行为：快捷键让位 / 焦点圈定 / Esc / 焦点恢复 / 图标按钮名称。
 *
 * ── 为什么这个场景必须带真按键 ──
 * Shift+Tab 是**主进程**用 `before-input-event` 拦的。渲染端 dispatchevent
 * 造出来的 KeyboardEvent 根本走不到那个钩子，所以「面板打开时它会被让出来」
 * 这件事只能靠 test-live 的 YAN_PROBE_KEYS（sendInputEvent）来验。
 *
 * 时序（主进程固定间隔 1.6s，第一个在探针开始后 1.8s）：
 *   #1 面板**开着**（t≈1.8）→ 应被守卫拦下，不产生 cycleThinking
 *   #2 面板**关了**（t≈3.4）→ 应恢复正常
 * 断言不绑定绝对时刻，而是记录「面板开着的区间」，再看动作落在区间哪一侧。
 */
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

  /* 主进程发来的动作，带时间戳 —— 用来判断落在「面板打开区间」的哪一侧 */
  const seen = []
  window.yan.onHotkey?.((a) => seen.push({ a, t: Date.now() }))

  /*
   * 隔离环境里没有凭证 → 首次引导会自动弹出，它**也是一层模态**，
   * 会把守卫一直摁住，干扰本场景。出现就立刻关掉（不阻塞主流程）。
   * 真实用户路径不受影响 —— 这里只是让场景可控。
   */
  const obs = new MutationObserver(() => {
    const x = document.querySelector('[data-testid="ob-close"]')
    if (x) x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  obs.observe(document.body, { childList: true, subtree: true })

  out.push('=== 1. 打开设置面板 ===')
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
  /*
   * 初始焦点是在 requestAnimationFrame 里做的 —— 固定 sleep 在 16 个场景
   * 连着跑时会漏（实测抖动过一次）。改成轮询等它落位。
   */
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
        (el) => !el.disabled && el.getClientRects().length > 0
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
  /*
   * ⚠️ 这里靠**真按键的固定时序**（主进程每隔 1.6s 发一个，第一个在 1.8s）。
   *    场景连跑时机器负载高，固定 sleep 会漂 —— 实测报过一次
   *    「关闭后没恢复」（其实是第二个键还没到）。
   *    所以：让它盖住**前两个**按键（t≈1.8 / 3.4），后面留一个做对照，
   *    并且对照那侧用**轮询**等。
   */
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
    /*
     * 对照实验（**只输出，不断言**）：
     * 手动告诉主进程「没有模态了」，再看下一个按键。
     *   · 收到 → 说明渲染端没把 guard 复位（真问题，关闭设置后快捷键会一直失效）
     *   · 没收到 → 多数是按键时序没跑到（本场景靠固定间隔的真按键，负载高时会漂）
     * 不用 ok() 把它变成“通过” —— 那会把上面那个失败掩盖掉。
     */
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
  /*
   * 「回到底部」只在用户往上翻（!stick）时渲染。
   * 隔离 fixture 只有几条消息，内容高度不够粘顶 —— 这里把内容临时撑高，
   * 让它真的出现（测试用完不恢复，探针跑完进程就退）。
   */
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

  /* 全局扫描：当前渲染的按钮里有没有「无文字又无名称」的 */
  const nameless = [...document.querySelectorAll('button')].filter((b) => {
    const text = (b.textContent || '').trim()
    const named = b.getAttribute('aria-label') || b.getAttribute('title')
    return !text && !named
  })
  out.push(`  无名称按钮数: ${nameless.length}`)
  nameless.slice(0, 5).forEach((b) => out.push('  ✗ ' + b.className))
  ok(nameless.length === 0, '所有渲染出来的按钮都有文字或可访问名称')

  obs.disconnect()
  return out.join('\n')
})()
