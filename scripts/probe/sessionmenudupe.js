/**
 * 同一会话是否在左栏多处渲染 → 右键时是否同时开出多个菜单。
 *
 * 左栏的「最近」区和项目树是两套渲染路径，都用 `renderSession`。
 * 如果一条会话同时出现在两处，`menuFor` 只按 `s.path` 判断 `menuOpen`，
 * 两个实例会**同时**渲染菜单（Portal 到 body、位置相同、互相重叠）；
 * 用户点到的可能是「另一个实例」的菜单项，于是动作作用在没看到的行上——
 * 表现就是「点了重命名，菜单关了，但这一行没变」。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  /** 命中测试 + 完整指针序列（尽量贴近真实鼠标） */
  const realClickAt = (x, y) => {
    const hit = document.elementFromPoint(x, y)
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
    hit?.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    hit?.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
    hit?.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    hit?.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
    hit?.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
  }
  const store = window.__yanStore
  const st = () => window.__yanStore.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else break
  }
  for (let i = 0; i < 40; i++) {
    if (st().conn === 'ready' && st().settings) break
    await sleep(500)
  }
  store.getState().setRailPinned(true)
  await sleep(600)

  /* 让前几条会进入「最近」区（recentSessions 要求 lastOpenedAt > 0） */
  store.setState({
    sessions: st().sessions.map((s, i) => (i < 3 ? { ...s, lastOpenedAt: Date.now() - i * 1000 } : s))
  })
  await sleep(700)

  const rows = qa('.srow-wrap[data-session-path]')
  const counts = new Map()
  for (const r of rows) counts.set(r.dataset.sessionPath, (counts.get(r.dataset.sessionPath) ?? 0) + 1)
  const dups = [...counts.entries()].filter(([, n]) => n > 1)
  out.push(`可见会话行 ${rows.length} 条，去重后 ${counts.size} 条`)
  out.push(`同时出现在「最近/置顶」与项目树的会话：${dups.map(([p, n]) => `${p} ×${n}`).join('  /  ') || '（无）'}`)
  /* 重复显示是设计（最近只是快捷入口）；要断言的是它不会让菜单开出两份 */
  ok(dups.length > 0, '存在两处同时显示的会话（否则这条没测到该测的）')

  if (dups.length) {
    const [path] = dups[0]
    const inst = qa('.srow-wrap[data-session-path]').filter((e) => e.dataset.sessionPath === path)
    out.push(`  用重复会话做右键：${path}`)
    const body = inst[0]?.querySelector('.srow-row') ?? inst[0]
    body?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 260 }))
    await sleep(300)
    const menus = qa('[data-testid="rail-session-menu"]')
    out.push(`  右键第一处后，同时打开的菜单数 = ${menus.length}`)
    ok(menus.length === 1, '右键只打开一个菜单（不重叠）')

    /* 端到端：点这个菜单里的「重命名」，输入框必须出现在被右键的那一行 */
    const ren = q('[data-testid="rail-rename"]')
    if (ren) {
      const rr = ren.getBoundingClientRect()
      realClickAt(Math.round(rr.left + rr.width / 2), Math.round(rr.top + rr.height / 2))
      await sleep(400)
      const inputs = qa('[data-testid="rail-rename-input"]')
      out.push(`  点重命名后，输入框数 = ${inputs.length}`)
      ok(inputs.length === 1, '只出现一个重命名输入框')
      ok(inputs.length === 1 && inst[0].contains(inputs[0]), '输入框出现在被右键的那一行（不是另一处实例）')
    } else {
      ok(false, '菜单里有「重命名」')
    }
  }

  return out.join('\n')
})()
