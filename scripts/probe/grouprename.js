;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }
  const setValue = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const commitInput = async (el, value) => {
    setValue(el, value)
    await sleep(80)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await sleep(150)
    if (document.querySelector('[data-testid="rail-group-rename"]') === el) {
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await sleep(150)
    }
  }
  const titles = () => qa('[data-testid="rail-project-group"]').map((el) => (el.querySelector('.proj-group-name')?.textContent ?? el.textContent ?? '').trim())
  const settle = () => sleep(420)

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(250)
    }
    localStorage.setItem('yan.onboarded', '1')
    store.getState().setRailPinned(true)
    await sleep(300)

    const stamp = Date.now()
    const probeRoot = String(store.getState().settings.cwd).replace(/[\\/]+$/, '')
    const cwdOf = (n) => `${probeRoot}/probe-projects/p${n}`
    const groups = [
      { id: 'probe-group-a', name: '探针甲组', createdAt: stamp },
      { id: 'probe-group-b', name: '探针乙组', createdAt: stamp }
    ]
    const projects = [
      { id: 'pga1', cwd: cwdOf(1), name: '项目一', groupId: 'probe-group-a', archived: false, createdAt: stamp, updatedAt: stamp },
      { id: 'pga2', cwd: cwdOf(2), name: '项目二', groupId: 'probe-group-a', archived: false, createdAt: stamp, updatedAt: stamp },
      { id: 'pgb1', cwd: cwdOf(3), name: '项目三', groupId: 'probe-group-b', archived: false, createdAt: stamp, updatedAt: stamp },
      { id: 'pgn1', cwd: cwdOf(4), name: '项目四', groupId: undefined, archived: false, createdAt: stamp, updatedAt: stamp }
    ]
    const cwds = projects.map((p) => p.cwd)
    await store.getState().patchSettings({ projectGroups: groups, projects, recentCwds: cwds })
    const sessions = projects.map((p, i) => ({
      id: `gr-s${i}`,
      path: `${p.cwd}/session-${i}.jsonl`,
      cwd: p.cwd,
      projectId: p.id,
      title: `会话 ${i + 1}`,
      named: true,
      createdAt: stamp,
      updatedAt: stamp - i * 1000,
      messageCount: 1
    }))
    store.setState({
      sessions,
      session: { ...(store.getState().session ?? {}), cwd: sessions[0].cwd, sessionFile: sessions[0].path }
    })
    await settle()

    const before = titles()
    out.push('  分组标题 = ' + JSON.stringify(before))
    ok(before.length === 2, `渲染出两个分组标题（实际 ${before.length}）`)
    ok(before.includes('探针甲组') && before.includes('探针乙组'), '标题里是分组名（图标/按钮不带文字）')

    const menuBtn = q('[data-testid="rail-group-menu-probe-group-a"]')
    ok(!!menuBtn, '分组标题上有操作菜单入口')
    if (menuBtn) click(menuBtn)
    ok(await until(() => !!q('[data-testid="rail-group-menu-panel"]')), '点开菜单')
    const renameAction = q('[data-testid="rail-group-rename-action"]')
    ok(!!renameAction, '菜单里有「重命名分组」')
    ok(!!q('[data-testid="rail-group-dissolve"]'), '菜单里有「解散分组」')

    if (renameAction) click(renameAction)
    ok(await until(() => !!q('[data-testid="rail-group-rename"]')), '点重命名后出现行内输入框')
    const input = q('[data-testid="rail-group-rename"]')
    ok(input?.value === '探针甲组', '输入框预填当前分组名')

    await commitInput(input, '   ')
    await sleep(400)
    ok(!!q('[data-testid="rail-group-error"]'), '空白名被拒绝并给出提示')
    ok(!!q('[data-testid="rail-group-rename"]'), '空白名时保留输入框（不静默关闭）')
    out.push('  空白名提示 = ' + JSON.stringify(q('[data-testid="rail-group-error"]')?.textContent))

    await commitInput(q('[data-testid="rail-group-rename"]'), '探针乙组')
    await sleep(400)
    ok(!!q('[data-testid="rail-group-error"]'), '重复名被拒绝并给出提示')
    ok(!!q('[data-testid="rail-group-rename"]'), '重复名时保留输入框')
    out.push('  重名提示 = ' + JSON.stringify(q('[data-testid="rail-group-error"]')?.textContent))

    await commitInput(q('[data-testid="rail-group-rename"]'), '探针甲组·改')
    await until(() => !q('[data-testid="rail-group-rename"]'))
    await settle()
    const after = titles()
    out.push('  改名后 = ' + JSON.stringify(after))
    ok(after.includes('探针甲组·改'), '分组标题变成新名字')
    ok(!after.includes('探针甲组'), '旧名字消失')

    const st = store.getState().settings
    const gA = st.projectGroups.find((g) => g.id === 'probe-group-a')
    ok(!!gA && gA.name === '探针甲组·改', '设置里分组名已更新')
    ok(
      st.projectGroups.some((g) => g.id === 'probe-group-b' && g.name === '探针乙组'),
      '另一个分组不受影响'
    )
    ok(
      st.projects.filter((p) => p.groupId === 'probe-group-a').length === 2,
      '两个项目的 groupId 保持 probe-group-a（归属不变）'
    )
    ok(st.projectGroups.length === 2, '分组数量不变（没有新建/删除）')

    const rowCountBefore = qa('.proj').length
    const dissolve = q('[data-testid="rail-group-menu-probe-group-a"]')
    if (dissolve) click(dissolve)
    await until(() => !!q('[data-testid="rail-group-dissolve"]'))
    const btn = q('[data-testid="rail-group-dissolve"]')
    if (btn) click(btn)
    await settle()
    const st2 = store.getState().settings
    out.push('  解散后分组 = ' + JSON.stringify(st2.projectGroups.map((g) => g.name)))
    ok(st2.projectGroups.length === 1 && st2.projectGroups[0].id === 'probe-group-b', '甲组从设置里消失')
    ok(st2.projects.filter((p) => p.groupId === 'probe-group-a').length === 0, '原组内项目已脱离分组')
    out.push('  解散后项目数 = ' + st2.projects.length + ' / cwds = ' + JSON.stringify(st2.projects.map((p) => p.cwd).filter((c) => /probe-projects/.test(c))))
    ok(
      cwds.every((c) => st2.projects.some((p) => p.cwd === c)),
      '四个项目的记录都还在（解散分组只动 groupId，不删项目）'
    )
    ok(qa('.proj').length === rowCountBefore, `项目行数量不变（${rowCountBefore}）`)
    ok(!titles().includes('探针甲组·改'), '界面上不再显示已解散的分组标题')
    ok(titles().includes('探针乙组'), '其它分组照旧')

    await store.getState().patchSettings({ projectGroups: [], projects: [], recentCwds: [] })
    await sleep(200)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
