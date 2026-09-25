/*
 * 上下文菜单（实施-12 U-2，cost 0）。
 *
 * 三类菜单走同一个 `ContextMenuSurface`：项目菜单（items）、会话行菜单
 * （信息行 + 分区 + 动作，仍是 Portal）、分组菜单（items）。
 *
 * 验证：Portal 到 body（不被 `.rail-body` 的 overflow 裁、不顶大 scrollHeight）、
 * 菜单归属（data-session-path）、键盘（首项聚焦 / ↑↓ / End / Esc 关闭并还焦点）、
 * 外点关闭、动作项齐全、列表最底一行的菜单也完整落在视口内。
 * 不动真实项目 / 会话数据（到「关闭菜单」为止，不点重命名 / 归档 / 删除）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => document.querySelector(sel)
  const qa = (sel) => [...document.querySelectorAll(sel)]
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const key = (el, k) => el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  const st = () => window.__yanStore.getState()

  try {
    for (let i = 0; i < 80; i++) {
      if (st().conn === 'ready' && st().settings) break
      await sleep(500)
    }
    /* 确保侧栏展开、有一个项目行 */
    st().setRailPinned(true)
    await sleep(400)
    let row = q('[data-testid="rail-project-row"]')
    if (!row) {
      out.push('  （无项目行，先跳过）')
      return out.join('\n')
    }

    const body = q('.rail-body')
    const rowTopBefore = row.getBoundingClientRect().top
    const scrollBefore = body?.scrollHeight ?? 0

    /* ① 省略号按钮打开 */
    const trigger = row.querySelector('.proj-rename')
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(250)
    const panel = q('[data-testid="rail-project-menu-panel"]')
    ok(!!panel, '省略号打开项目菜单')
    ok(panel?.parentElement === document.body, '菜单 Portal 到 body（不被 overflow 裁）')
    ok(!!panel?.querySelector('[role="menu"]') || panel?.getAttribute('role') === 'menu', '菜单是 menu 角色')

    /* ② 打开不改变行布局 */
    const rowTopAfter = row.getBoundingClientRect().top
    const scrollAfter = body?.scrollHeight ?? 0
    ok(Math.abs(rowTopBefore - rowTopAfter) < 1, `打开菜单不移动项目行（${rowTopBefore.toFixed(1)}→${rowTopAfter.toFixed(1)}）`)
    ok(scrollBefore === scrollAfter, `打开菜单不改变滚动高度（${scrollBefore}→${scrollAfter}）`)

    /* ③ 动作项齐全 */
    const items = Array.from(panel?.querySelectorAll('[role="menuitem"]') ?? [])
    ok(items.length >= 6, `菜单项齐全（${items.length} 项）`)
    ok(items.some((i) => i.dataset.testid === 'rail-project-new'), '有「新对话」')

    /* ④ 键盘：打开即聚焦首项，↓ 移动，Esc 关闭并还焦点给触发元素 */
    ok(document.activeElement === items[0], '打开后焦点在第一项')
    key(panel, 'ArrowDown')
    await sleep(80)
    ok(document.activeElement === items[1], '↓ 移到第二项')
    key(panel, 'End')
    await sleep(80)
    ok(document.activeElement === items[items.length - 1], 'End 移到末项')
    key(panel, 'Escape')
    await sleep(200)
    ok(!q('[data-testid="rail-project-menu-panel"]'), 'Esc 关闭菜单')
    ok(document.activeElement === trigger, '关闭后焦点还给触发元素')

    /* ⑤ 右键也能开 */
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    await sleep(250)
    ok(!!q('[data-testid="rail-project-menu-panel"]'), '右键打开项目菜单')
    /* ⑥ 外点关闭 */
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await sleep(200)
    ok(!q('[data-testid="rail-project-menu-panel"]'), '点击外部关闭')

    /* ================================================================
     * ⑦ 会话行菜单：行内块 → 同一个 Portal 外壳
     *
     * 以前它渲染在 `.srow-wrap` 里，`.rail-body` 的 `overflow: auto` 会把
     * 最后几行的菜单裁掉，还顶大栏内 scrollHeight。这里专门滚到列表底部
     * 验一遍。
     * ================================================================ */
    out.push('')
    out.push('=== 会话行菜单（Portal / 归属 / 键盘）===')
    const sessionRows = qa('.srow-wrap').filter((w) => w.querySelector('.srow'))
    ok(sessionRows.length > 0, `有会话行（${sessionRows.length} 行）`)
    if (sessionRows.length) {
      const target = sessionRows[sessionRows.length - 1]
      const targetPath = target.getAttribute('data-session-path') ?? ''
      if (body) body.scrollTop = body.scrollHeight
      await sleep(300)
      const targetTop = target.getBoundingClientRect().top
      const railScroll = body?.scrollHeight ?? 0

      const moreBtn = target.querySelector('.srow-acts button')
      ok(!!moreBtn, '会话行有动作按钮（⋯）')
      click(moreBtn)
      await sleep(250)
      const menu = q('[data-testid="rail-session-menu"]')
      ok(!!menu, '⋯ 打开会话行菜单')
      ok(menu?.parentElement === document.body, '会话菜单 Portal 到 body（不被栏内 overflow 裁）')
      ok(menu?.getAttribute('data-session-path') === targetPath, '菜单归属于打开它的那一行')
      ok(menu?.getAttribute('role') === 'menu', '会话菜单是 menu 角色')
      ok(!target.contains(menu), '菜单不在行内（不再顶大 scrollHeight）')
      ok((body?.scrollHeight ?? 0) === railScroll, `打开菜单不改变栏内 scrollHeight（${railScroll}）`)
      ok(Math.abs(target.getBoundingClientRect().top - targetTop) < 1, '打开菜单不移动会话行')
      const menuRect = menu?.getBoundingClientRect()
      ok(
        !!menuRect && menuRect.top >= -0.5 && menuRect.bottom <= window.innerHeight + 0.5,
        `列表最底一行的菜单完整落在视口内（${menuRect?.top.toFixed(0)}→${menuRect?.bottom.toFixed(0)} / 视口 ${window.innerHeight}）`
      )

      const sessionItems = Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? [])
      ok(sessionItems.length >= 6, `会话菜单项齐全（${sessionItems.length} 项）`)
      ok(sessionItems.some((i) => /重命名|rename/i.test(i.textContent ?? '')), '有「重命名」')
      ok(sessionItems.some((i) => i.classList.contains('danger')), '有危险项「删除」（样式与项目菜单同源）')
      ok(sessionItems.every((i) => i.tagName === 'BUTTON'), '所有菜单项都是可聚焦的 button')
      ok(!!menu?.querySelector('[data-testid="rail-menu-time"]'), '信息行（最近活动）保留')
      /*
       * 用户 2026-09-26 要求：右键菜单不再显示会话文件的绝对路径。
       * 路径对「找会话」没用（标题 + 最近活动已经够），却把菜单拉得很长；
       * 需要定位文件时菜单里有「打开所在文件夹」。
       */
      ok(!menu?.querySelector('.srow-menu-path'), '信息行（会话路径）已移除')
      ok(!!menu?.dataset.sessionPath, '行仍能定位到会话（data-session-path 保留）')

      ok(document.activeElement === sessionItems[0], '会话菜单打开即聚焦首项')
      key(menu, 'End')
      await sleep(80)
      ok(document.activeElement === sessionItems[sessionItems.length - 1], '会话菜单 End 移到末项')
      key(menu, 'Escape')
      await sleep(220)
      ok(!q('[data-testid="rail-session-menu"]'), 'Esc 关闭会话菜单')
      ok(document.activeElement === moreBtn, '关闭后焦点还给 ⋯ 按钮')

      /* 右键：用真实指针位置开（处理器在行主体 `.srow-row` 上） */
      const rowBody = target.querySelector('.srow-row') ?? target
      rowBody.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 70, clientY: 70 }))
      await sleep(250)
      ok(!!q('[data-testid="rail-session-menu"]'), '右键打开会话菜单')
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      await sleep(200)
      ok(!q('[data-testid="rail-session-menu"]'), '点击外部关闭会话菜单')
    }

    /* ================================================================
     * ⑧ 分组菜单：同一个组件（U-2 残余的最后一块）
     * ================================================================ */
    out.push('')
    out.push('=== 分组菜单（复用同一组件）===')
    const settingsBefore = st().settings
    const stamp = Date.now()
    const probeCwd = `${(settingsBefore.cwd ?? '.').replace(/[\\/][^\\/]*$/, '')}/yan-probe-ctx-group`
    await st().patchSettings({
      projectGroups: [{ id: 'ctx-probe-group', name: '上下文探针组', createdAt: stamp }],
      projects: [{ id: 'ctxp1', cwd: probeCwd, name: '上下文探针项目', groupId: 'ctx-probe-group', archived: false, createdAt: stamp, updatedAt: stamp }],
      recentCwds: [probeCwd]
    })
    await sleep(450)
    const groupBtn = q('[data-testid="rail-group-menu-ctx-probe-group"]')
    ok(!!groupBtn, '分组标题上有操作菜单入口')
    if (groupBtn) {
      const groupScroll = body?.scrollHeight ?? 0
      click(groupBtn)
      await sleep(250)
      const groupPanel = q('[data-testid="rail-group-menu-panel"]')
      ok(!!groupPanel, '点开分组菜单')
      ok(groupPanel?.parentElement === document.body, '分组菜单 Portal 到 body')
      ok((body?.scrollHeight ?? 0) === groupScroll, `打开分组菜单不改变栏内 scrollHeight（${groupScroll}）`)
      const groupItems = Array.from(groupPanel?.querySelectorAll('[role="menuitem"]') ?? [])
      ok(groupItems.some((i) => i.dataset.testid === 'rail-group-rename-action'), '有「重命名分组」')
      ok(groupItems.some((i) => i.dataset.testid === 'rail-group-dissolve'), '有「解散分组」')
      ok(document.activeElement === groupItems[0], '分组菜单打开即聚焦首项')
      key(groupPanel, 'Escape')
      await sleep(200)
      ok(!q('[data-testid="rail-group-menu-panel"]'), 'Esc 关闭分组菜单')
      ok(document.activeElement === groupBtn, '关闭后焦点还给分组按钮')
    }
    /* 收尾：分组数据恢复原样 */
    await st().patchSettings({
      projectGroups: settingsBefore.projectGroups ?? [],
      projects: settingsBefore.projects ?? [],
      recentCwds: settingsBefore.recentCwds ?? []
    })
    await sleep(200)

    return out.join('\n')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
