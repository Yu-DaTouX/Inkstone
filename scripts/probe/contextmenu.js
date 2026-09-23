/*
 * 项目上下文菜单（实施-12 U-2，cost 0）。
 *
 * 验证：菜单 Portal 到 body（不被 overflow 裁）、打开不改变行的位置/滚动高度、
 * 键盘（首项聚焦 / ↑↓ / Esc 关闭并还焦点）、外点关闭、动作项齐全。
 * 不动真实项目数据（到「关闭菜单」为止，不点重命名/归档）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => document.querySelector(sel)
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
    panel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await sleep(80)
    ok(document.activeElement === items[1], '↓ 移到第二项')
    panel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await sleep(80)
    ok(document.activeElement === items[items.length - 1], 'End 移到末项')
    panel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
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

    return out.join('\n')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
