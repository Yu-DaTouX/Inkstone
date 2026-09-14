/**
 * 首次引导（N20）：第 2 栏「模型接入」的两个按钮布局。
 *
 * 用户反馈：首次打开软件的「开始之前」里，第 2 栏「模型接入」的
 * 「重新检测」和「去配置」两个按钮 UI 错位。
 *
 * 怎么进到引导层：**不重置 `yan.onboarded`**，改从
 * 设置 → 关于 → 「重新查看」打开（这也是本轮新增的入口，见 Settings.tsx
 * 的 onShowOnboarding）。这样探针既能在真实组件上量布局，
 * 又不会动用户正式使用的首次启动标记。
 *
 * 量的是**几何**而不是 CSS 文本：两个按钮是否在同一个右边界上对齐、
 * 是否与第 2 栏的文案重叠、是否溢出卡片、文字有没有被裁。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: +r.x.toFixed(1),
      y: +r.y.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
      right: +r.right.toFixed(1),
      bottom: +r.bottom.toFixed(1)
    }
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(200)
    }
    await sleep(600)

    /* 探针环境本来就不会自动弹引导；这里只是保证它不会挡住后面的操作 */
    localStorage.setItem('yan.onboarded', '1')

    store.getState().openSettings('about')
    ok(await until(() => q('[data-testid="ob-reopen"]')), '设置 → 关于 有「重新查看」入口')
    click(q('[data-testid="ob-reopen"]'))
    ok(await until(() => q('.ob-card')), '点「重新查看」真的打开了引导层')
    await sleep(700)

    const card = q('.ob-card')
    const row = q('[data-testid="ob-auth"]')
    ok(!!row, '第 2 栏（模型接入）渲染出来了')
    if (!row) return out.join('\n')

    const act = row.querySelector('.ob-row-act')
    const btns = act ? [...act.querySelectorAll('button')] : []
    const desc = row.querySelector('.ob-row-desc')
    const title = row.querySelector('.ob-row-title')
    ok(btns.length === 2, `第 2 栏有两个按钮（实际 ${btns.length}）`)

    const boxAct = box(act)
    const boxRow = box(row)
    const boxCard = box(card)
    const boxDesc = box(desc)
    const boxes = btns.map(box)
    const labels = btns.map((b) => (b.textContent || '').trim())
    out.push(`  窗口 ${window.innerWidth}×${window.innerHeight}`)
    out.push(`  卡片 ${boxCard?.w.toFixed(0)}×${boxCard?.h.toFixed(0)}  第2栏 ${boxRow?.w.toFixed(0)}×${boxRow?.h.toFixed(0)}`)
    out.push(`  操作区 ${boxAct?.w.toFixed(1)}×${boxAct?.h.toFixed(1)} @ x=${boxAct?.x}`)
    boxes.forEach((b, i) => out.push(`    「${labels[i]}」 ${b?.w.toFixed(1)}×${b?.h.toFixed(1)} x=${b?.x} right=${b?.right} y=${b?.y}`))
    out.push(`  标题 ${JSON.stringify((title?.textContent || '').trim())}`)
    out.push(`  说明区 right=${boxDesc?.right} bottom=${boxDesc?.bottom}`)
    if (act && btns[0]) {
      const csAct = getComputedStyle(act)
      const csBtn = getComputedStyle(btns[0])
      out.push(`  诊断 row grid-template-columns=${getComputedStyle(row).gridTemplateColumns}`)
      out.push(`  诊断 act: width=${csAct.width} minWidth=${csAct.minWidth} flex=${csAct.flex} overflow=${csAct.overflow} alignSelf=${csAct.alignSelf}`)
      out.push(`  诊断 btn: width=${csBtn.width} minWidth=${csBtn.minWidth} overflow=${csBtn.overflow} ws=${csBtn.whiteSpace} box=${csBtn.boxSizing} pad=${csBtn.padding} display=${csBtn.display}`)
    }

    /* ---- 几何断言 ---- */
    if (boxes.length === 2 && boxAct) {
      const [b0, b1] = boxes

      /* 1. 竖排：x 对齐（错位最直观的表现就是一个左一个右） */
      ok(Math.abs(b0.x - b1.x) <= 1, `两个按钮左边界对齐（差 ${Math.abs(b0.x - b1.x).toFixed(1)}px）`)
      ok(b1.y >= b0.bottom - 1, '两个按钮竖排不重叠')

      /* 2. 不溢出操作区/第 2 栏/卡片 */
      ok(boxes.every((b) => b.right <= boxAct.right + 1), '按钮不溢出操作区右边界')
      ok(!!boxRow && boxes.every((b) => b.right <= boxRow.right + 1), '按钮不溢出第 2 栏')
      ok(!!boxCard && boxes.every((b) => b.right <= boxCard.right + 1), '按钮不溢出引导卡片')

      /* 3. 不与文案重叠（文案区右边界必须在按钮左边界之外） */
      ok(!!boxDesc && boxDesc.right <= Math.min(b0.x, b1.x) + 1, `说明文字不与按钮重叠（文案 right=${boxDesc?.right}，按钮 left=${Math.min(b0.x, b1.x)}）`)
      ok(!!title && box(title).right <= Math.min(b0.x, b1.x) + 1, '标题不与按钮重叠')

      /* 4. 文字完整：不被裁、不换行成两行 */
      const clipped = btns.filter((b) => b.scrollWidth > b.clientWidth + 1)
      out.push('  文字溢出检查 scrollWidth/clientWidth = ' + btns.map((b) => `${b.scrollWidth}/${b.clientWidth}`).join('  '))
      ok(clipped.length === 0, '按钮文字没有被裁（scrollWidth ≤ clientWidth）')
      const tall = boxes.filter((b) => b.h > 34)
      ok(tall.length === 0, `按钮没有被压成多行（最高 ${Math.max(...boxes.map((b) => b.h)).toFixed(1)}px）`)
      ok(boxes.every((b) => b.h >= 20), '按钮高度正常（≥ 20px，可点击）')

      /* 5. 同一个操作区里两个按钮宽度一致（观感上「错位」的另一种来源） */
      out.push(`  宽度差 ${Math.abs(b0.w - b1.w).toFixed(1)}px`)
      ok(Math.abs(b0.w - b1.w) <= 1, '两个按钮等宽（同一操作区的按钮宽度一致）')
    }

    /* ---- 交互：重新检测 / 去配置往返 ---- */
    out.push('')
    out.push('=== 交互：重新检测 / 去配置往返 ===')
    const recheck = q('[data-testid="ob-recheck-auth"]')
    if (recheck) {
      click(recheck)
      await sleep(900)
      const row2 = q('[data-testid="ob-auth"]')
      ok(!!row2, '点「重新检测」后第 2 栏仍在（浅查不阻塞界面）')
      out.push('  重测后 data-ok = ' + JSON.stringify(row2?.getAttribute('data-ok')))
    }
    const goAuth = q('[data-testid="ob-open-auth"]')
    if (goAuth) {
      click(goAuth)
      ok(await until(() => q('.settings')), '点「去配置」打开了设置面板')
      const selTab = q('.settings-tab.sel')
      out.push('  选中 tab = ' + JSON.stringify((selTab?.textContent || '').trim()))
      ok(/接入|Access/i.test(selTab?.textContent || ''), '设置停在「模型接入」页')

      /* 从配置页返回：关掉设置，引导层应该还在（它是下层模态，不能被顶掉） */
      const closeTab = [...document.querySelectorAll('.settings-tab')].find((x) => /关闭|Close/.test(x.textContent || ''))
      if (closeTab) click(closeTab)
      await sleep(500)
      ok(!!q('.ob-card'), '从配置页返回后引导层还在')
      const row2 = q('[data-testid="ob-auth"]')
      const btns2 = [...(row2?.querySelectorAll('.ob-row-act button') ?? [])]
      ok(btns2.length === 2, '往返后第 2 栏两个按钮仍在')
      ok(
        btns2.every((b) => b.scrollWidth <= b.clientWidth + 1),
        '往返后按钮文字仍然完整（布局没被破坏）'
      )
      const boxes2 = btns2.map(box)
      if (boxes2.length === 2) {
        ok(Math.abs(boxes2[0].x - boxes2[1].x) <= 1, '往返后两个按钮仍然对齐')
      }
    }

    /* 关闭引导，别影响后面的场景 */
    const done = q('[data-testid="ob-done"]') ?? q('[data-testid="ob-close"]')
    if (done) click(done)
    await sleep(400)
    ok(!q('.ob-card'), '引导层能正常关闭')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
