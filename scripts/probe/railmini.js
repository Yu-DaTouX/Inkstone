/**
 * 左栏的折叠与收放。
 *
 * 用户 2026-09-19 的两条要求：
 *   ① 「左边栏变为完全折叠 不要留下一个边框」——
 *      收起态从 48px 的紧凑图标轨（砚 / 搜索 / 新建 / 项目文件夹 / 设置）
 *      改成**完全折叠**：0 宽、不渲染任何内容。那条轨在深色主题下就是
 *      消息区左边一条颜色不同的竖条，用户看到的「边框」就是它。
 *   ② 「项目文件夹应该默认显示前五个会话 其余进行折叠」。
 *
 * ⚠️ N14 的 mini 轨（`.rail-compact`）连同它的样式一起删掉了，所以这个
 *    场景不再测「mini 栏里有几个项目图标」；它现在的职责是
 *    「收起态真的什么都不剩」+「项目下的会话折叠」。
 *
 * ⚠️ 当前会话**不能**被藏起来：它落在折叠段里时要自动多展开到它那一行，
 *    否则用户会看不到自己正待着的会话（第 1 节最后三条断言）。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  /* 受控输入必须走原生 setter + input 事件（直接改 value React 看不到） */
  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const box = (el) => (el ? el.getBoundingClientRect() : null)
  const store = window.__yanStore
  const early = (msg) => {
    out.push(msg)
    return out.join('\n')
  }
  if (!store) return early('  ⤺ 跳过：没有 window.__yanStore（探针没被注入）')

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(250)
    }

    /* ---- 造一个项目 + 8 条会话（排序按最近活动，第一条最新） ---- */
    const stamp = Date.now()
    const base = String(store.getState().settings.cwd).replace(/[\\/][^\\/]*$/, '')
    const cwd = `${base}/yan-probe-railfold`
    const sessions = Array.from({ length: 8 }, (_, i) => ({
      id: `rf-${i}`,
      path: `${cwd}/session-${i}.jsonl`,
      cwd,
      projectId: 'rf-proj',
      title: `第 ${i + 1} 个会话`,
      named: true,
      createdAt: stamp,
      updatedAt: stamp - i * 1000,
      messageCount: 1
    }))
    store.setState({
      runners: [],
      activeRunnerId: null,
      sessions,
      /* 当前会话放在第 1 条：先验「默认只显示前五」 */
      session: { ...(store.getState().session ?? {}), cwd, sessionFile: sessions[0].path }
    })
    await store.getState().patchSettings({
      projectGroups: [],
      projects: [
        { id: 'rf-proj', cwd, name: '折叠探针', archived: false, createdAt: stamp, updatedAt: stamp }
      ],
      recentCwds: [cwd],
      projectNames: { [cwd]: '折叠探针' }
    })
    store.getState().setRailPinned(true)
    await sleep(700)

    const rows = () => qa('[data-testid="rail-session"]')
    const more = () => q('[data-testid="rail-more-sessions"]')
    const fold = () => q('[data-testid="rail-fold-sessions"]')

    out.push('=== 1. 项目下默认只列前五个会话（用户要求） ===')
    out.push(`  会话行 ${rows().length} 行（造了 8 条）`)
    ok(rows().length === 5, '一个项目默认只显示前五个会话')
    ok(!!more(), '多出来的有「更多会话」出口')
    out.push(`  出口文案 = ${JSON.stringify((more()?.textContent ?? '').trim())} · data-count=${more()?.dataset.count}`)
    ok(more()?.dataset.count === '3', '其余三条被折叠（8 − 5）')
    ok(!fold(), '还没展开时不显示「收起会话」')

    click(more())
    await sleep(400)
    out.push(`  点开后 ${rows().length} 行`)
    ok(rows().length === 8, '点开后八条都在')
    ok(!!fold(), '此时给出「收起会话」出口')
    click(fold())
    await sleep(400)
    ok(rows().length === 5, '收回去又是五行')

    /* ---- 当前会话在折叠段里：必须自动展开到它 ---- */
    store.setState({
      session: { ...(store.getState().session ?? {}), cwd, sessionFile: sessions[6].path }
    })
    await sleep(500)
    out.push(
      `  当前会话在第 7 位时：${rows().length} 行 · data-count=${more()?.dataset.count}`
    )
    ok(rows().length === 7, '当前会话不会被藏起来（自动展开到它那一行）')
    ok(more()?.dataset.count === '1', '只多展开到当前会话，剩下的仍然折叠')

    out.push('')
    out.push('=== 1b. 收起左栏 → 「更多会话」复位（实施-12 U-1） ===')
    /*
     * 先把当前会话放回第 1 条：上一节故意把它放在第 7 位来验「不会被藏起来」，
     * 而那种情况下会**自动多展开到它那一行**（5 + 2 = 7）—— 那是正确的旧行为，
     * 会干扰本节要测的「收起复位」。
     */
    store.setState({
      session: { ...(store.getState().session ?? {}), cwd, sessionFile: sessions[0].path }
    })
    await sleep(500)
    ok(rows().length === 5, '当前会话回到第 1 条（本节前置）')
    /* 前置：先展开到全部 */
    click(more())
    await sleep(400)
    ok(rows().length === 8, '先展开到全部（前置）')
    /* 顺手把一个会话行菜单打开：收起时它不能留在已折叠的栏里 */
    const rowMenuBtn = qa('.srow-menu-btn')[0]
    if (rowMenuBtn) {
      click(rowMenuBtn)
      await sleep(300)
    }
    out.push(`  会话行菜单按钮：${rowMenuBtn ? '找到' : '没找到'}，收起前菜单：${q('[data-testid="rail-menu-time"]') ? '打开' : '未打开'}`)

    store.getState().setRailPinned(false)
    await sleep(600)
    click(q('[data-testid="rail-toggle"]'))
    await sleep(700)
    out.push(`  收起再展开后 ${rows().length} 行 · data-count=${more()?.dataset.count}`)
    ok(rows().length === 5, '收起左栏后「更多会话」复位到前五个')
    ok(more()?.dataset.count === '3', '其余三条重新折叠')
    ok(!q('[data-testid="rail-menu-time"]'), '临时菜单不留在已收起的左栏里')

    /* 搜索中收起：搜索结果仍完整；清搜索后才按预览折叠 */
    const searchBtn = q('[data-testid="rail-search-btn"]')
    if (searchBtn) {
      click(searchBtn)
      await sleep(300)
      setVal(q('[data-testid="rail-search"]'), '会话')
      await sleep(500)
      const matched = rows().length
      out.push(`  搜索「会话」命中 ${matched} 行（搜索仍按预览折叠，这是既有行为）`)
      ok(matched > 0, '搜索能命中会话（前置）')
      store.getState().setRailPinned(false)
      await sleep(600)
      click(q('[data-testid="rail-toggle"]'))
      await sleep(700)
      ok(rows().length === matched, '收起再展开后搜索结果仍完整（不受预览复位影响）')
      click(q('[data-testid="rail-search-clear"]'))
      await sleep(500)
      ok(rows().length === 5, '清掉搜索后才回到预览五行')
    } else {
      out.push('  （没找到搜索入口，跳过搜索中的收起断言）')
    }

    out.push('')
    out.push('=== 2. 收起：完全折叠，不留边框（用户要求） ===')
    store.getState().setRailPinned(false)
    await sleep(700)
    const railEl = q('.rail')
    out.push(
      `  .rail display=${railEl ? getComputedStyle(railEl).display : '（已卸载）'} · 宽 ${box(railEl)?.width ?? '—'}`
    )
    ok(!railEl || getComputedStyle(railEl).display === 'none', '收起后左栏不渲染（display: none）')
    ok(!q('.rail-compact'), 'mini 图标轨已彻底移除（那条竖条不再出现）')

    const collapsed = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--w-rail-collapsed')
    )
    out.push(`  --w-rail-collapsed = ${collapsed}px`)
    ok(collapsed === 0, '收起宽度是 0（不占布局列）')

    const cols = getComputedStyle(q('.workspace')).gridTemplateColumns
    out.push(`  .workspace 列宽 = ${cols}`)
    ok(/^0(px)?\s/.test(cols.trim()), '左列实际宽度为 0（消息区贴到窗口左边）')

    ok(!!q('[data-testid="rail-toggle"]'), '标题栏留着展开入口（唯一入口）')

    click(q('[data-testid="rail-toggle"]'))
    await sleep(700)
    const backEl = q('.rail')
    ok(!!backEl && getComputedStyle(backEl).display !== 'none', '点标题栏开关能重新展开')

    out.push('')
    out.push('=== 3. 收尾：恢复展开态、清掉探针数据 ===')
    store.getState().setRailPinned(true)
    await store.getState().patchSettings({
      projectGroups: [],
      projects: [],
      recentCwds: [],
      projectNames: {}
    })
    await sleep(300)
    ok(true, '探针数据已清理')
  } catch (error) {
    out.push('  ✗ 探针异常：' + (error && error.stack ? error.stack : String(error)))
  }

  return out.join('\n')
})()
