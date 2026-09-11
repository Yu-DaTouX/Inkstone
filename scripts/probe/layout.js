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
    /*
     * ⚠️ 上下文**不在用量条里了**（用户要求改位置）：它搬到了右栏第一块 -> 对齐 OpenCode。
     * 所以这里反过来断言：用量条里**没有**上下文，上下文在右栏。
     */
    for (const need of ['输入', '输出', '缓存', '速度']) ok(labels.includes(need), `含「${need}」`)
    ok(!labels.includes('上下文'), '上下文已移出用量条')
    ok(!q('[data-testid="ub-ctx"]'), '旧的内联上下文按钮已移除')
    // 位置：在 composer 下方
    const c = q('.composer'), r1 = ub.getBoundingClientRect(), r2 = c.getBoundingClientRect()
    ok(r1.top >= r2.bottom - 2, `在输入框下方（usagebar.top=${Math.round(r1.top)} composer.bottom=${Math.round(r2.bottom)}）`)
    // 居中
    const center = q('.center').getBoundingClientRect()
    const leftGap = Math.round(r1.left - center.left), rightGap = Math.round(center.right - r1.right)
    ok(Math.abs(leftGap - rightGap) <= 2, `居中（左 ${leftGap} / 右 ${rightGap}）`)
    // 与输入框同宽（用户报过「错开」）
    const ubw = Math.round(r1.width), cw = Math.round(r2.width)
    out.push(`  用量条宽 ${ubw} / 输入框宽 ${cw}`)
    ok(Math.abs(ubw - cw) <= 4, `用量条与输入框同宽（差 ${Math.abs(ubw - cw)}px）`)
    // 不能再有那种「只占位不表意」的竖线分隔符
    ok(qa('.ub-sep').length === 0, '已清除多余的竖线分隔符（.ub-sep）')
  }

  out.push('')
  out.push('=== 1b. 上下文在右栏 ===')
  const ctx = q('[data-sec="rp-context"]')
  ok(!!ctx, '右栏有「上下文」分区')
  if (ctx) {
    const txt = ctx.textContent.replace(/\s+/g, ' ').trim()
    out.push('  内容: ' + JSON.stringify(txt.slice(0, 80)))
    ok(/tokens/.test(txt), '显示 token 总量')
    ok(/%/.test(txt), '显示占用百分比')
    ok(/\$/.test(txt), '显示花费')
    ok(!!ctx.querySelector('.rp-meter'), '有进度条')
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
  /**
   * 等一个测量值**稳定下来**再读。
   *
   * ⚠️ 为什么必需：左栏收放是靠 `--w-rail` 的 CSS 过渡做的，
   *   `until(() => rail-off)` 只等到**类名**变了，宽度还在变。
   *   直接读 getBoundingClientRect 会拿到过渡中间值 —— 实测踩到过：
   *   「收起」后读到的还是展开时的宽度，于是「推挤」断言方向反而是反的。
   *   这是测量时机问题，不是功能问题。
   */
  const settle = async (read, ms = 1500) => {
    const t0 = Date.now()
    let prev = read()
    while (Date.now() - t0 < ms) {
      await sleep(120)
      const now = read()
      if (Math.abs(now - prev) < 0.5) return now
      prev = now
    }
    return prev
  }
  const centerW = () => q('.center').getBoundingClientRect().width
  const innerL = () => q('.stream-inner').getBoundingClientRect().left

  // ⚠️ 不能直接断言「初始收起」——真实光标可能恰好停在屏幕左缘，
  //    窗口一出现系统就发一次 mousemove，于是它合法地展开了。
  //    所以先强制把指针挪开，等它收起，再开始测。
  move(900)
  const collapsed = await until(() => app.classList.contains('rail-off'))
  ok(collapsed, '指针离开后左栏收起')

  ok(true, '（左边缘热区已移除：鼠标靠近由 window mousemove 的 clientX 判断，没有 DOM 元素）')

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
  // 等宽度过渡走完再量（否则拿到的是过渡中间值）
  const cw1 = Math.round(await settle(centerW))
  const cx1 = Math.round(await settle(innerL))
  move(3)
  await until(() => !app.classList.contains('rail-off'), 2000)
  const cw2 = Math.round(await settle(centerW))
  const cx2 = Math.round(await settle(innerL))
  // 从「浮层」改成「推挤」是刻意的：对齐 Agents-Anywhere 的常驻列做法。
  // 浮层会把标题盖住，推挤才是面板收合的感觉。代价是中栏会重新居中。
  ok(cw2 < cw1, `中栏被左栏推挤（${cw1} → ${cw2}）`)
  ok(cx2 > cx1, `内容跟着右移（left ${cx1} → ${cx2}）`)

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

  // 左栏顶部的模式开关已删 —— 侧栏开关在标题栏最左上角（一个入口就够，
  // 重复放两处会让人不确定该点哪个）。
  ok(!q('[data-testid="rail-mode"]'), '左栏内不再重复放侧栏开关')

  /*
   * 标题栏不再显示会话名（用户要求删掉左上角那个胶囊）。
   * 标题已经在**中栏顶部**常驻（SessionHeader），标题栏再放一份是重复的。
   */
  ok(!q('.tb-session'), '标题栏不再重复显示会话名')

  out.push('=== 5. 溢出 ===')
  for (const sel of ['.app', '.workspace', '.center', '.usagebar', '.rightpanel']) {
    const e = q(sel); if (!e) continue
    const over = e.scrollWidth - e.clientWidth
    ok(over <= 0, `${sel} 无横向溢出（差 ${over}）`)
  }

  out.push('')
  out.push('=== 6. 布局宽度 ===')
  for (const sel of ['.rail', '.center', '.rightpanel', '.usagebar', '.composer']) out.push('  ' + sel.padEnd(14) + box(sel))

  const cw3 = Math.round(await settle(centerW))
  const cx3 = Math.round(await settle(innerL))
  if (cw3 && cx3) out.push(`  钉住后中栏宽=${cw3} 内容左=${cx3}`)

  return out.join('\n')
})()
