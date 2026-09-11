;(async () => {
  const out = []
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const box = (s) => { const e = q(s); if (!e) return '缺失'; const r = e.getBoundingClientRect(); return `l=${Math.round(r.left)} r=${Math.round(r.right)} w=${Math.round(r.width)}` }

  for (let i = 0; i < 60; i++) { if (store.getState().conn === 'ready') break; await sleep(500) }
  store.getState().closeSettings(); await sleep(400)

  out.push('=== 1. 用量条已合并（只剩一条） ===')
  const old1 = q('.ctxbar'), old2 = q('.tokbar')
  ok(!old1, '旧的 .ctxbar 已移除')
  ok(!old2, '旧的 .tokbar 已移除')
  const ub = q('[data-testid="usagebar"]')
  ok(!!ub, '.usagebar 存在')
  if (ub) {
    out.push('  内容: ' + JSON.stringify(ub.textContent.replace(/\s+/g, ' ').trim()))
    const labels = qa('.usagebar .ub-label').map(e => e.textContent)
    out.push('  字段: ' + JSON.stringify(labels))
    for (const need of ['上下文', '输入', '输出', '缓存', '速度']) ok(labels.includes(need), `含「${need}」`)
    // 位置：在 composer 下方
    const c = q('.composer'), r1 = ub.getBoundingClientRect(), r2 = c.getBoundingClientRect()
    ok(r1.top >= r2.bottom - 2, `在输入框下方（usagebar.top=${Math.round(r1.top)} composer.bottom=${Math.round(r2.bottom)}）`)
    // 居中
    const center = q('.center').getBoundingClientRect()
    const leftGap = Math.round(r1.left - center.left), rightGap = Math.round(center.right - r1.right)
    ok(Math.abs(leftGap - rightGap) <= 2, `居中（左 ${leftGap} / 右 ${rightGap}）`)
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
  out.push('=== 4. 左栏自动隐藏 ===')
  const app = q('.app')
  const move = (x) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 400, bubbles: true }))
  /** 轮询等待某个条件成立（不依赖固定 sleep，避免环境差异） */
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(150)
    }
    return fn()
  }

  // ⚠️ 不能直接断言「初始收起」——真实光标可能恰好停在屏幕左缘，
  //    窗口一出现系统就发一次 mousemove，于是它合法地展开了。
  //    所以先强制把指针挪开，等它收起，再开始测。
  move(900)
  const collapsed = await until(() => app.classList.contains('rail-off'))
  ok(collapsed, '指针离开后左栏收起')

  ok(!!q('[data-testid="rail-hotzone"]'), '有左边缘热区')

  // 靠近 → **延迟**展开（避免鼠标只是路过就弹出来）
  move(3)
  await sleep(120)
  ok(app.classList.contains('rail-off'), '刚靠近 120ms 时还没展开（有延迟）')
  const expanded = await until(() => !app.classList.contains('rail-off'), 2000)
  ok(expanded, '指针停留后展开')
  const railW = Math.round(q('.rail').getBoundingClientRect().width)
  out.push('  左栏宽度: ' + railW)
  ok(railW > 200, `左栏真的展开了（${railW}px）`)

  // 只是路过（快速划过左边缘）不该展开
  move(900)
  await until(() => app.classList.contains('rail-off'))
  move(3)
  await sleep(120)
  move(900) // 立刻划走
  await sleep(600)
  ok(app.classList.contains('rail-off'), '鼠标只是路过左边缘时不会弹出')

  // 挪走 → 有延迟地收回（先确保是展开的）
  move(3)
  await until(() => !app.classList.contains('rail-off'), 2000)
  move(900)
  await sleep(800)
  out.push('  挪走 0.8s 后 rail-off=' + app.classList.contains('rail-off'))
  ok(!app.classList.contains('rail-off'), '0.8 秒时还没收回（说明有 1.5s 延迟）')
  const late = await until(() => app.classList.contains('rail-off'))
  ok(late, '延迟后自动收回')

  // 中途回到栏内 → 取消收回（同样先确保展开）
  move(3)
  await until(() => !app.classList.contains('rail-off'), 2000)
  move(900)
  await sleep(700)
  move(120) // 回到侧栏范围内
  await sleep(1600)
  out.push('  中途回到栏内后 rail-off=' + app.classList.contains('rail-off'))
  ok(!app.classList.contains('rail-off'), '中途返回会取消收回')

  // 收起状态下，指针落在侧栏原来的位置不该误展开
  move(3)
  await until(() => !app.classList.contains('rail-off'), 2000)
  move(900)
  await until(() => app.classList.contains('rail-off'))
  move(120)
  await sleep(400)
  ok(app.classList.contains('rail-off'), '收起后指针在 x=120 不会误展开')

  // 浮层：展开/收起不该改变中栏宽度与内容位置
  move(900)
  await until(() => app.classList.contains('rail-off'))
  const cw1 = Math.round(q('.center').getBoundingClientRect().width)
  const cx1 = Math.round(q('.stream-inner').getBoundingClientRect().left)
  move(3)
  await until(() => !app.classList.contains('rail-off'), 2000)
  const cw2 = Math.round(q('.center').getBoundingClientRect().width)
  const cx2 = Math.round(q('.stream-inner').getBoundingClientRect().left)
  ok(cw1 === cw2, `中栏宽度不随左栏变化（${cw1} → ${cw2}）`)
  ok(cx1 === cx2, `内容位置不跳（left ${cx1} → ${cx2}）`)

  // 钉住
  const btn = q('[data-testid="rail-toggle"]')
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(300)
  out.push('  钉住后 data-pinned=' + btn.dataset.pinned)
  ok(btn.dataset.pinned === '1', '标题栏按钮能钉住')
  move(900)
  await sleep(1900)
  ok(!app.classList.contains('rail-off'), '钉住后不会自动收回')

  // 取消钉住 → 恢复自动隐藏
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(300)
  move(900)
  const autoAgain = await until(() => app.classList.contains('rail-off'))
  ok(autoAgain, '取消钉住后恢复自动隐藏')

  // 左栏顶部的模式开关
  move(3)
  await until(() => !app.classList.contains('rail-off'), 2000)
  const sw = q('[data-testid="rail-mode"]')
  ok(!!sw, '左栏顶部有模式开关')
  if (sw) {
    const pinBtn = q('[data-testid="rail-mode-pin"]')
    const autoBtn = q('[data-testid="rail-mode-auto"]')
    out.push('  按钮: ' + JSON.stringify([pinBtn?.textContent, autoBtn?.textContent]))
    ok(autoBtn.classList.contains('sel'), '默认选中「自动」')

    pinBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(300)
    ok(pinBtn.classList.contains('sel'), '点「固定」后选中态切换')
    move(900)
    await sleep(1900)
    ok(!app.classList.contains('rail-off'), '固定后不自动收起')

    autoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(300)
    move(900)
    await until(() => app.classList.contains('rail-off'))
    ok(app.classList.contains('rail-off'), '点「自动」后恢复自动隐藏')
  }

  out.push('=== 5. 溢出 ===')
  for (const sel of ['.app', '.workspace', '.center', '.usagebar', '.rightpanel']) {
    const e = q(sel); if (!e) continue
    const over = e.scrollWidth - e.clientWidth
    ok(over <= 0, `${sel} 无横向溢出（差 ${over}）`)
  }

  out.push('')
  out.push('=== 6. 布局宽度 ===')
  for (const sel of ['.rail', '.center', '.rightpanel', '.usagebar', '.composer']) out.push('  ' + sel.padEnd(14) + box(sel))

  return out.join('\n')
})()
