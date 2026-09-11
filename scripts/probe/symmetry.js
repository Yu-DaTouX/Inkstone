/**
 * 面板开关的**几何对称性**：展开态与收起态必须逐像素相同，且都要点得到。
 *
 * 为什么单独一个场景（这是一个反复犯的错）：
 *   ① 第一版：收起后渲染**另一个元素**（.rail-stub），几何与展开态完全不同
 *      → 用户报「展开前和展开后的按钮大小位置不对称」
 *   ② 第二版：虽然位置对了，但过时的 `.app.rail-off .rail{opacity:1;
 *      pointer-events:auto}` 让透明左栏盖在把手上，实测 elementFromPoint
 *      命中 rail-brand-btn 而不是把手 → 按钮**点不到**（用户报「闪退」）
 *
 * 两次都是「存在性断言」测不出来的 —— 按钮一直都在、也能点，
 * 只是位置不对/被盖住。所以这个场景专门量 getBoundingClientRect
 * 与 elementFromPoint。这类断言值得长期保留。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const rawRect = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }
  }
  /*
   * 量到**稳定值**再返回：连续两次读数不同就继续等（最多 2s）。
   * 为什么：面板收放有 120–160ms 的过渡，缩放变化后也会有一次重排。
   * 在过渡中途量出来的矩形是随机的 —— 这是本场景唯一真正的不确定来源。
   */
  const rect = async (sel) => {
    let prev = rawRect(sel)
    const t0 = Date.now()
    while (Date.now() - t0 < 2000) {
      await sleep(90)
      const cur = rawRect(sel)
      if (!cur) return null
      if (prev && cur.x === prev.x && cur.y === prev.y && cur.w === prev.w && cur.h === prev.h) {
        return { x: +cur.x.toFixed(1), y: +cur.y.toFixed(1), w: +cur.w.toFixed(1), h: +cur.h.toFixed(1) }
      }
      prev = cur
    }
    return prev ? { x: +prev.x.toFixed(1), y: +prev.y.toFixed(1), w: +prev.w.toFixed(1), h: +prev.h.toFixed(1) } : null
  }
  /* 轮询到某个条件成立（本项目硬约定：不用固定 sleep 等 UI） */
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }

  /*
   * 关掉首次引导层（隔离目录 = 首次运行，它会盖在整个界面上）。
   * ⚠️ 必须**轮询等它出现**再关 —— 上一版是「到了就找按钮，找不到就算了」：
   *    引导层晚出现（数据就绪后才渲染）时它就一直开着，
   *    于是 elementFromPoint 量到的是遮罩而不是开关 → 偶发失败。
   */
  const dismissOnboarding = async () => {
    localStorage.setItem('yan.onboarded', '1')
    const t0 = Date.now()
    while (Date.now() - t0 < 4000) {
      const card = document.querySelector('.ob-card') || document.querySelector('.ob-scrim')
      if (!card) return 'none'
      const btn = [...document.querySelectorAll('.ob-card button')].find((b) => /开始使用|开始|Get started|完成/.test(b.textContent))
      if (btn) {
        click(btn)
        await sleep(300)
        if (!document.querySelector('.ob-card')) return 'dismissed'
      }
      await sleep(150)
    }
    return 'still-open'
  }

  const eq = (a, b, label, tol = 1) => {
    if (!a || !b) { bad(label + '：量不到'); return }
    const keys = ['x', 'y', 'w', 'h']
    const diff = keys.filter((k) => Math.abs(a[k] - b[k]) > tol)
    if (!diff.length) ok(label + ' 几何完全一致 ' + JSON.stringify(a))
    else bad(label + ' 不对称：' + diff.map((k) => k + ' ' + a[k] + '→' + b[k]).join(', ') + '  (展 ' + JSON.stringify(a) + ' 收 ' + JSON.stringify(b) + ')')
  }

  try {
    const obState = await dismissOnboarding()
    out.push('  引导层: ' + obState)
    if (obState === 'still-open') bad('引导层关不掉，几何测量会量到遮罩')
    await until(() => !document.querySelector('.ob-card'), 2000)

    /*
     * ⚠️ 必须**显式置为展开态**再开始量。
     *    本探针一开始假设「起始是展开的」，于是全量跑时（前一个场景
     *    把左栏留在了收起态）整个场景的「前/后」颠倒了 —— 4 条断言
     *    全错。这正是 HANDOFF §8 里那条老教训：
     *    **探针不该依赖可能变化的状态**。单跑必过、全量才炸，
     *    与本项目之前踩过的 todos 场景是同一个坑。
     */
    store.getState().setRailPinned(true)
    await sleep(700)
    out.push('  起始 railPinned=' + store.getState().railPinned + '（已显式置为展开）')
    out.push('=== 1. 左栏开关：展开 vs 收起 几何必须一致 ===')
    const before = await rect('[data-testid="rail-toggle"]')
    out.push('  展开时 ' + JSON.stringify(before) + '  标题=' + document.querySelector('[data-testid="rail-toggle"]')?.title)
    click(document.querySelector('[data-testid="rail-toggle"]'))
    await sleep(800)
    const after = await rect('[data-testid="rail-toggle"]')
    out.push('  收起时 ' + JSON.stringify(after) + '  标题=' + document.querySelector('[data-testid="rail-toggle"]')?.title)
    eq(before, after, '左栏开关')

    out.push('\n=== 2. 收起后开关必须**点得到**（上次的 bug：被透明左栏盖住）===')
    const r = after
    const hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2)
    const owner = hit ? hit.closest('button') : null
    out.push('  elementFromPoint → ' + (owner ? owner.className + ' | ' + owner.dataset.testid : String(hit)))
    if (owner && owner.dataset.testid === 'rail-toggle') ok('命中的就是开关本身（不再被盖住）')
    else bad('点不到开关，命中 ' + (owner ? owner.dataset.testid : hit))

    out.push('\n=== 3. 点它应该能展开 ===')
    click(owner || document.querySelector('[data-testid="rail-toggle"]'))
    await sleep(800)
    if (store.getState().railPinned) ok('已展开')
    else bad('点不动，展不开')

    out.push('\n=== 4. 收起后左栏内容应隐藏（但开关留着）===')
    click(document.querySelector('[data-testid="rail-toggle"]'))
    await sleep(800)
    const vis = (sel) => {
      const e = document.querySelector(sel)
      return e ? getComputedStyle(e).visibility : 'none'
    }
    out.push('  .rail-action visibility=' + vis('.rail-action') + '  .rail-search-btn=' + vis('.rail-search-btn') + '  .rail-brand-btn=' + vis('.rail-brand-btn'))
    if (vis('.rail-action') === 'hidden') ok('非头部内容已隐藏')
    else bad('.rail-action 没隐藏')
    if (vis('.rail-brand-btn') === 'visible') ok('开关仍可见')
    else bad('开关被藏了（会锁死）')
    const slotW = document.querySelector('.rail-slot')?.getBoundingClientRect().width
    out.push('  收起列宽 = ' + slotW + '（应 ≥ 12+26+12 = 50）')
    if (slotW >= 50) ok('列宽容得下开关')
    else bad('列宽不够，按钮会被裁：' + slotW)

    out.push('\n=== 5. 右栏开关：展开 vs 收起 几何必须一致 ===')
    /*
     * 先把两侧都**显式置为展开**，否则下面的「前/后」对比没有意义
     * （与上面第 1 节同一个理由：不依赖前一个场景留下的状态）。
     */
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await sleep(800)
    const rpBefore = await rect('[data-testid="rightpanel-hide"]')
    out.push('  展开时 ' + JSON.stringify(rpBefore))
    click(document.querySelector('[data-testid="rightpanel-hide"]'))
    await sleep(800)
    const rpAfter = await rect('[data-testid="rightpanel-toggle"]')
    out.push('  收起时 ' + JSON.stringify(rpAfter))
    eq(rpBefore, rpAfter, '右栏开关')

    out.push('\n=== 6. 右栏收起后开关也要点得到 ===')
    const rr = rpAfter
    const hit2 = document.elementFromPoint(rr.x + rr.w / 2, rr.y + rr.h / 2)
    const owner2 = hit2 ? hit2.closest('button') : null
    out.push('  elementFromPoint → ' + (owner2 ? owner2.dataset.testid : String(hit2)))
    if (owner2 && owner2.dataset.testid === 'rightpanel-toggle') ok('命中的是右栏开关')
    else bad('点不到右栏开关，命中 ' + (owner2 ? owner2.dataset.testid : hit2))
    click(owner2 || document.querySelector('[data-testid="rightpanel-toggle"]'))
    await sleep(700)
    if (document.querySelector('[data-testid="rightpanel"]')) ok('右栏已展开')
    else bad('右栏展不开')

    out.push('\n=== 7. 连续点 12 次（快速切换不应崩）===')
    for (let i = 0; i < 12; i++) {
      const t = document.querySelector('[data-testid="rail-toggle"]')
      click(t)
      await sleep(60)
    }
    await sleep(900)
    if (document.querySelector('.app')) ok('页面存活，railPinned=' + store.getState().railPinned)
    else bad('页面没了')
  } catch (e) {
    bad('抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[symmetry] 全部通过' : '[symmetry] ' + failed + ' 条失败')
  return out.join('\n')
})()
