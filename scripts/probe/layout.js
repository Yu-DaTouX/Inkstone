;(async () => {
  const out = []
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const skip = (s) => out.push('  ⤺ 跳过：' + s)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const box = (s) => { const e = q(s); if (!e) return '缺失'; const r = e.getBoundingClientRect(); return `l=${Math.round(r.left)} r=${Math.round(r.right)} w=${Math.round(r.width)}` }

  for (let i = 0; i < 60; i++) { if (store.getState().conn === 'ready') break; await sleep(500) }
  store.getState().closeSettings(); await sleep(400)
  if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)
  await sleep(400)
  q('[data-testid="right-window-tab-start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(500)

  out.push('=== 1. 用量条已合并（只剩一条） ===')
  const old1 = q('.ctxbar'), old2 = q('.tokbar')
  ok(!old1, '旧的 .ctxbar 已移除')
  ok(!old2, '旧的 .tokbar 已移除')
  const ub = q('[data-testid="usagebar"]')
  if (ub) ok(true, '.usagebar 存在')
  else skip(`pi 未就绪（conn=${store.getState().conn}），没有用量数据 → 用量条不渲染`)
  const ubEmpty = ub?.getAttribute('data-state') === 'no-usage'
  if (ub && ubEmpty) skip('还没有用量数据，用量条是空占位')
  if (ub && !ubEmpty) {
    out.push('  内容: ' + JSON.stringify(ub.textContent.replace(/\s+/g, ' ').trim()))
    const labels = qa('.usagebar .ub-label').map(e => e.textContent)
    out.push('  字段: ' + JSON.stringify(labels))
    for (const need of ['输入', '输出', '缓存', '速度']) ok(labels.includes(need), `含「${need}」`)
    ok(!labels.includes('上下文'), '上下文已移出用量条')
    ok(!q('[data-testid="ub-ctx"]'), '旧的内联上下文按钮已移除')
    const inStatusBar = !!ub.closest('.statusbar, [data-testid="statusbar"]')
    const c = q('.composer'), r1 = ub.getBoundingClientRect(), r2 = c.getBoundingClientRect()
    ok(r1.top >= r2.bottom - 2, `在输入框下方（usagebar.top=${Math.round(r1.top)} composer.bottom=${Math.round(r2.bottom)}）`)
    if (!inStatusBar) {
    const center = q('.center').getBoundingClientRect()
    const leftGap = Math.round(r1.left - center.left), rightGap = Math.round(center.right - r1.right)
    ok(Math.abs(leftGap - rightGap) <= 2, `居中（左 ${leftGap} / 右 ${rightGap}）`)
    const ubw = Math.round(r1.width), cw = Math.round(r2.width)
    out.push(`  用量条宽 ${ubw} / 输入框宽 ${cw}`)
    ok(Math.abs(ubw - cw) <= 4, `用量条与输入框同宽（差 ${Math.abs(ubw - cw)}px）`)
    }
    ok(qa('.ub-sep').length === 0, '已清除多余的竖线分隔符（.ub-sep）')
  }

  out.push('')
  out.push('=== 1b. 输入框上下文浮层 ===')
  const ctxTrigger = q('[data-testid="composer-context"]')
  ok(!!ctxTrigger, '输入框旁有上下文圆环入口')
  if (ctxTrigger) {
    ctxTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    let popover = null
    for (let i = 0; i < 30 && !popover; i++) {
      await sleep(100)
      popover = q('.ui-detail-popover[role="dialog"]')
    }
    ok(!!popover, '点击圆环打开上下文浮层')
    if (popover) {
      const tokens = popover.querySelector('[data-testid="ctx-tokens"]')
      out.push('  tokens: ' + JSON.stringify(tokens?.textContent?.trim() ?? '缺失'))
      ok(!!tokens && tokens.textContent.trim().length > 0, '浮层显示 Agent 报告的 token 总量或未知状态')
      const usage = popover.querySelector('.ui-usage-bar[role="img"]')
      ok(!!usage && !!usage.getAttribute('aria-label'), '浮层有可访问的分类用量条')
      const auto = popover.querySelector('[data-testid="rp-auto-compact"]')
      const manual = popover.querySelector('[data-testid="rp-compact-now"]')
      ok(!!auto, '浮层提供原生自动压缩开关')
      ok(!!manual, '浮层提供手动压缩操作')
      if (manual) {
        const busy = !!store.getState().session?.isAgentRunning || !!store.getState().session?.isStreaming || !!store.getState().session?.isCompacting
        const shouldDisable = busy || !store.getState().session?.sessionId
        ok(manual.disabled === shouldDisable, '手动压缩控件只在会话缺失或忙碌时禁用')
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(120)
      ok(!q('.ui-detail-popover[role="dialog"]'), 'Escape 可关闭上下文浮层')
    }
  }

  out.push('')
  out.push('=== 2. 消息旁不再显示上下文 ===')
  ok(!q('.msg-usage'), '消息标签里没有 .msg-usage')
  const labels = qa('.msg-label').map(e => e.textContent.replace(/\s+/g, ' ').trim())
  out.push('  消息标签: ' + JSON.stringify(labels.slice(0, 3)))
  ok(!labels.some(l => /\d+(\.\d+)?k?\s*tok/i.test(l)), '消息标签里没有 token 数字')

  out.push('')
  out.push('=== 3. 任务在右栏 ===')
  ok(!q('.todo-group'), '左栏里不再有任务区块')
  const rp = q('[data-testid="rightpanel"]')
  out.push('  rightpanel: ' + (rp ? '存在' : '不存在（当前无任务）'))
  ok(!q('.rail .todo'), '左栏里没有任务项')
  if (rp) {
    out.push('  右栏内容: ' + JSON.stringify(rp.textContent.replace(/\s+/g, ' ').trim().slice(0, 80)))
    const center = q('.center').getBoundingClientRect()
    const r = rp.getBoundingClientRect()
    ok(r.left >= center.right - 2, `右栏在中栏右侧（center.right=${Math.round(center.right)} rp.left=${Math.round(r.left)}）`)
  }

  out.push('')
  out.push('=== 4. 左栏：只有按钮能控制 ===')
  const app = q('.app')
  const move = (x) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 400, bubbles: true }))
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(150)
    }
    return fn()
  }
  const settle = async (read, ms = 3000) => {
    const t0 = Date.now()
    let prev = read()
    let stable = 0
    while (Date.now() - t0 < ms) {
      await sleep(150)
      const now = read()
      stable = Math.abs(now - prev) < 0.5 ? stable + 1 : 0
      if (stable >= 3) return now
      prev = now
    }
    return prev
  }
  const workspaceViewport = () => q('.tile-workspace-scroll')
  const viewportWidth = () => workspaceViewport()?.getBoundingClientRect().width ?? 0
  const viewportLeft = () => workspaceViewport()?.getBoundingClientRect().left ?? 0
  const isOpen = () => !app.classList.contains('rail-off')
  const btn = q('[data-testid="rail-toggle"]')
  const click = () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  if (!isOpen()) {
    click()
    await until(isOpen, 2000)
  }

  if (isOpen()) {
    click()
    await until(() => !isOpen(), 2000)
  }
  ok(!isOpen(), '点按钮能收起左栏')

  move(3)
  await sleep(200)
  move(3)
  await sleep(1600)
  ok(!isOpen(), '鼠标停在左边缘 1.8s 也不会展开（悬停已移除）')

  move(120)
  await sleep(600)
  ok(!isOpen(), '鼠标停在原侧栏区域内也不会展开')

  move(900)
  await sleep(300)
  ok(!isOpen(), '鼠标移开也不会因此展开')

  click()
  const opened = await until(isOpen, 2000)
  ok(opened, '点按钮能展开左栏')
  const railW = Math.round(q('.rail').getBoundingClientRect().width)
  out.push('  左栏宽度: ' + railW)
  ok(railW > 200, `左栏真的展开了（${railW}px）`)

  click()
  const closed = await until(() => !isOpen(), 2000)
  ok(closed, '再点一次能收起')

  click()
  await until(isOpen, 2000)
  await sleep(300)
  out.push('  展开后 localStorage = ' + localStorage.getItem('yan.rail-open'))
  ok(localStorage.getItem('yan.rail-open') === '1', '展开状态会落盘')
  click()
  await until(() => !isOpen(), 2000)
  await sleep(300)
  out.push('  收起后 localStorage = ' + localStorage.getItem('yan.rail-open'))
  ok(localStorage.getItem('yan.rail-open') === '0', '收起状态会落盘')

  const viewport = workspaceViewport()
  const canvas = q('.tile-workspace-canvas')
  ok(!!viewport && !!canvas && viewport.contains(canvas), '磁贴画布位于工作区自己的滚动 viewport 内')
  const cw1 = Math.round(await settle(viewportWidth))
  const cx1 = Math.round(await settle(viewportLeft))
  click()
  await until(isOpen, 2000)
  const cw2 = Math.round(await settle(viewportWidth))
  const cx2 = Math.round(await settle(viewportLeft))
  ok(cw2 < cw1, `展开侧栏后工作区 viewport 变窄（${cw1} → ${cw2}）`)
  ok(cx2 > cx1, `展开侧栏后工作区 viewport 右移（left ${cx1} → ${cx2}）`)
  if (viewport && canvas) {
    const canvasWidth = Math.round(canvas.getBoundingClientRect().width)
    const overflow = viewport.scrollWidth - viewport.clientWidth
    const page = q('.app')
    const pageOverflow = page ? page.scrollWidth - page.clientWidth : 0
    const overflowX = getComputedStyle(viewport).overflowX
    out.push(`  viewport=${Math.round(viewport.clientWidth)} canvas=${canvasWidth} scrollWidth=${viewport.scrollWidth} scrollLeft=${viewport.scrollLeft} overflowX=${overflowX}`)
    ok(overflowX === 'auto' || overflowX === 'scroll', '工作区自身负责磁贴画布的横向溢出')
    ok(pageOverflow <= 0, `工作区画布不撑出应用（app 横向溢出 ${pageOverflow}px）`)
    if (overflow > 0) {
      const before = viewport.scrollLeft
      viewport.scrollLeft = viewport.scrollWidth
      await sleep(2 * 150)
      const reachedEnd = viewport.scrollLeft >= viewport.scrollWidth - viewport.clientWidth - 1
      ok(reachedEnd, `超出 viewport 的画布可在工作区内滚动到末端（${before} → ${viewport.scrollLeft}）`)
      viewport.scrollLeft = before
    } else {
      ok(canvasWidth <= viewport.clientWidth + 1, '画布未超出 viewport 时保持在工作区内')
    }
  }

  out.push('  展开后 data-open=' + btn.dataset.open + ' aria-expanded=' + btn.getAttribute('aria-expanded'))
  ok(btn.dataset.open === '1', '展开时按钮显示为选中')

  ok(!!btn.closest('.titlebar'), '开关在标题栏里（位置与面板收放无关）')
  ok(!q('[data-testid="mode-switch"]'), '左栏内不再有工作区拨杆（实施-27 B3 已搬到设置）')

  ok(!q('.tb-session'), '标题栏不再重复显示会话名')

  out.push('=== 5. 溢出 ===')
  for (const sel of ['.app', '.workspace', '.tile-workspace']) {
    const e = q(sel); if (!e) continue
    const over = e.scrollWidth - e.clientWidth
    ok(over <= 0, `${sel} 无横向溢出（差 ${over}）`)
  }

  out.push('')
  out.push('=== 6. 布局宽度 ===')
  for (const sel of ['.rail', '.tile-workspace', '.tile-workspace-scroll', '.tile-workspace-canvas', '.usagebar', '.composer']) out.push('  ' + sel.padEnd(26) + box(sel))

  const cw3 = Math.round(await settle(viewportWidth))
  const cx3 = Math.round(await settle(viewportLeft))
  if (cw3 && cx3) out.push(`  工作区 viewport 宽=${cw3} 左=${cx3}`)

  return out.join('\n')
})()
