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
  out.push('=== 4. 左栏：只有按钮能控制 ===')
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
  const isOpen = () => !app.classList.contains('rail-off')
  const btn = q('[data-testid="rail-toggle"]')
  const click = () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  /*
   * ⚠️ 悬停展开**已被移除**（用户要求）。
   *
   * 原来这里有 6 条断言测「鼠标靠近左边缘 → 延迟 320ms 展开 / 离开 1.5s 收回 /
   * 中途返回取消收回」。那个功能删掉的原因是它会**抢鼠标**：
   * 想去点中栏最左边的导航轨时，侧栏先弹出来把内容推走。
   * 现在左栏只由标题栏那个按钮控制。
   */

  // 先确保是展开的（默认值就是展开）
  if (!isOpen()) {
    click()
    await until(isOpen, 2000)
  }

  /* ---- ① 悬停不再打开 ---- */
  if (isOpen()) {
    click()
    await until(() => !isOpen(), 2000)
  }
  ok(!isOpen(), '点按钮能收起左栏')

  move(3)
  await sleep(200)
  move(3)
  await sleep(1600) // 比原来的 OPEN_DELAY(320ms) + CLOSE_DELAY(1500ms) 都长
  ok(!isOpen(), '鼠标停在左边缘 1.8s 也不会展开（悬停已移除）')

  move(120)
  await sleep(600)
  ok(!isOpen(), '鼠标停在原侧栏区域内也不会展开')

  move(900)
  await sleep(300)
  ok(!isOpen(), '鼠标移开也不会因此展开')

  /* ---- ② 只有按钮能控制 ---- */
  click()
  const opened = await until(isOpen, 2000)
  ok(opened, '点按钮能展开左栏')
  const railW = Math.round(q('.rail').getBoundingClientRect().width)
  out.push('  左栏宽度: ' + railW)
  ok(railW > 200, `左栏真的展开了（${railW}px）`)

  click()
  const closed = await until(() => !isOpen(), 2000)
  ok(closed, '再点一次能收起')

  /* ---- ③ 选择被持久化（按钮是唯一手段，所以要记住） ---- */
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

  /* ---- ④ 推挤式（不是浮层） ---- */
  const cw1 = Math.round(await settle(centerW))
  const cx1 = Math.round(await settle(innerL))
  click()
  await until(isOpen, 2000)
  const cw2 = Math.round(await settle(centerW))
  const cx2 = Math.round(await settle(innerL))
  // 从「浮层」改成「推挤」是刻意的：对齐 Agents-Anywhere 的常驻列做法。
  // 浮层会把标题盖住，推挤才是面板收合的感觉。代价是中栏会重新居中。
  ok(cw2 < cw1, `中栏被左栏推挤（${cw1} → ${cw2}）`)
  ok(cx2 > cx1, `内容跟着右移（left ${cx1} → ${cx2}）`)

  /* ---- ⑤ 按钮的选中态跟着状态 ---- */
  out.push('  展开后 data-open=' + btn.dataset.open + ' aria-expanded=' + btn.getAttribute('aria-expanded'))
  // ⚠️ 这个按钮现在是**同一个元素**在两种状态下复用（收起时显示展开图标），
  //    所以数据属性从 data-pinned 改成了 data-open —— 断言跟着改。
  ok(btn.dataset.open === '1', '展开时按钮显示为选中')

  // 左栏顶部的模式开关已删。
  // 侧栏开关位置变过两次：标题栏最左上角 → 左栏头部的品牌按钮（当前）。
  // 所以这里改为断言**当前设计意图**：开关就在左栏头部，且没有重复入口。
  ok(!!btn.closest('.rail-top'), '开关在左栏头部（开关贴着它控制的东西）')
  ok(!q('[data-testid="rail-mode"]'), '左栏内不再有旧的模式开关')

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
