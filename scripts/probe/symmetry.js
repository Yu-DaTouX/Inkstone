/**
 * 面板开关的**位置稳定性**与收起态的可达性。
 *
 * ── 这个场景的目标变过，值得说明 ──
 * 最初它断言「展开态与收起态的按钮**几何完全相同**」—— 因为当时的设计
 * 是两个状态复用同一个按钮（8px 缝之前）。用户在「开关放哪 / 收起后长什么样」
 * 这件事上提过几次要求，最终形态是：
 *   · 展开态：面板头部一个 26×26 的图标按钮
 *   · 收起态：一条 8px 的缝 + **悬停才显**的展开按钮
 * 两者**不可能几何相同**（也不该相同），所以原来那条断言不再成立。
 *
 * 但用户真正在意的性质没变，而且它才是当初两种 bug 的根源：
 *   ① **按钮不能跳位置** —— 收起再展开后，按钮必须回到原来那一格
 *      （曾经因为两个状态用两个不同元素/不同尺寸而错位）
 *   ② **收起后必须点得到** —— 曾经透明左栏盖在把手上，
 *      `elementFromPoint` 命中的是别的元素，按钮等于不可用
 * 这个场景现在就断言这两条 —— 它们与具体设计无关，不会被下次改版推翻。
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
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
  }
  /**
   * 量到**稳定值**再返回（连读两次相同才算）。
   * 面板收放有 120–200ms 过渡，中途量出的矩形是随机的 —— 这是本场景
   * 唯一真正的不确定来源，必须等。
   */
  const rect = async (sel) => {
    let prev = rawRect(sel)
    const t0 = Date.now()
    while (Date.now() - t0 < 2500) {
      await sleep(90)
      const cur = rawRect(sel)
      if (!cur) return null
      if (prev && cur.x === prev.x && cur.y === prev.y && cur.w === prev.w && cur.h === prev.h) return cur
      prev = cur
    }
    return prev
  }

  const until = async (fn, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }

  /** 关掉首次引导层（轮询等它出现再关 —— 不要假设它已经没了） */
  const dismissOnboarding = async () => {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = document.querySelector('.ob-card')
      if (!card) return 'none'
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) click(btn)
      await sleep(200)
    }
    return 'still-open'
  }

  /**
   * 一个面板的往返测试：
   *   展开 → 量按钮位置 → 收起 → 验证「缝很窄 + 入口可点」→ 展开 → 再量
   *   两次位置必须完全一致（用户报过的「跳位置」）。
   */
  const roundTrip = async (label, cfg) => {
    out.push(`\n=== ${label} ===`)
    // 显式置为展开态（不假设前一个场景留下的状态）
    await cfg.ensureOpen()
    await sleep(600)

    const before = await rect(cfg.openBtn)
    if (!before) {
      bad(`${label}：展开态找不到开关`)
      return
    }
    out.push(`  展开态按钮 ${JSON.stringify(before)}`)

    click(document.querySelector(cfg.openBtn))
    await sleep(700)

    const slotW = cfg.collapsedWidth()
    const entry = document.querySelector(cfg.entry)
    out.push(`  收起后 列宽=${slotW.toFixed(1)}  入口=${entry ? '存在' : '缺失'}`)
    if (slotW <= 12) ok('收起成一条细缝（≤12px）—— 不再留 40px 的竖条')
    else bad(`收起后仍占 ${slotW.toFixed(1)}px`)
    if (entry) ok('收起态有展开入口（否则面板锁死）')
    else bad('收起后没有展开入口')

    /* 入口必须**真的点得到**：用 elementFromPoint 看命中的是谁 */
    if (entry) {
      const r = entry.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(12, r.height / 2))
      const owner = hit ? hit.closest('button') : null
      out.push(`  elementFromPoint → ${owner ? owner.dataset.testid : String(hit)}`)
      if (owner && owner.dataset.testid === cfg.entryTestId) ok('命中的就是展开入口（没被别的东西盖住）')
      else bad(`点不到入口，命中 ${owner ? owner.dataset.testid : hit}`)
      click(owner ?? entry)
      await until(() => store.getState().railPinned === true || !!document.querySelector(cfg.openBtn), 3000)
      await sleep(700)
    }

    const after = await rect(cfg.openBtn)
    out.push(`  往返后按钮 ${JSON.stringify(after)}`)
    if (before && after && before.x === after.x && before.y === after.y && before.w === after.w && before.h === after.h) {
      ok('收起再展开后按钮回到**同一格**（不跳位置）')
    } else {
      bad(`按钮跳了位置：${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    }
  }

  try {
    const obState = await dismissOnboarding()
    out.push('  引导层: ' + obState)
    if (obState === 'still-open') bad('引导层关不掉，几何测量会量到遮罩')

    const rpOpen = () => !!document.querySelector('[data-testid="rightpanel"]')

    await roundTrip('左栏：收起 → 展开', {
      openBtn: '[data-testid="rail-toggle"]',
      entry: '[data-testid="rail-expand"]',
      entryTestId: 'rail-expand',
      collapsedWidth: () => document.querySelector('.rail-slot')?.getBoundingClientRect().width ?? -1,
      ensureOpen: async () => {
        store.getState().setRailPinned(true)
        await sleep(400)
      }
    })

    await roundTrip('右栏（工具栏）：收起 → 展开', {
      openBtn: '[data-testid="rightpanel-hide"]',
      entry: '[data-testid="rightpanel-toggle"]',
      entryTestId: 'rightpanel-toggle',
      collapsedWidth: () => document.querySelector('.rightstub')?.getBoundingClientRect().width ?? -1,
      ensureOpen: async () => {
        if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
        await sleep(400)
      }
    })

    out.push('\n=== 连点 12 次（快速切换不应崩）===')
    for (let i = 0; i < 12; i++) {
      const t = document.querySelector('[data-testid="rail-toggle"]') || document.querySelector('[data-testid="rail-expand"]')
      if (t) click(t)
      await sleep(60)
    }
    await sleep(900)
    if (document.querySelector('.app')) ok('页面存活，railPinned=' + store.getState().railPinned)
    else bad('页面没了')
    store.getState().setRailPinned(true)
  } catch (e) {
    bad('抛异常：' + (e && e.message ? e.message : String(e)))
  }

  const failed = out.filter((l) => l.includes('✗')).length
  if (failed > 0) {
    out.push('')
    out.push('--- 失败现场 ---')
    const st = store.getState()
    out.push('  railPinned=' + st.railPinned + '  rightPanelOpen=' + st.settings?.rightPanelOpen)
    out.push('  uiScale=' + st.settings?.uiScale)
    const overlays = ['.ob-card', '.settings', '.modal-scrim', '.rail-user-pop', '.tool-lib'].filter((s2) => document.querySelector(s2))
    out.push('  打开的浮层: ' + (overlays.length ? overlays.join(', ') : '（无）'))
  }
  out.push('')
  out.push(failed === 0 ? '[symmetry] 全部通过' : '[symmetry] ' + failed + ' 条失败')
  return out.join('\n')
})()
