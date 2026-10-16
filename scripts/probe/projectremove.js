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
  const settle = () => sleep(420)

  const rowOf = (id) => qa('[data-testid="rail-project-row"]').find((el) => el.dataset.dragId === id)
  const openMenu = (id) => {
    const trigger = rowOf(id)?.querySelector('.proj-rename')
    if (trigger) click(trigger)
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(250)
    }
    localStorage.setItem('yan.onboarded', '1')
    store.getState().setRailPinned(true)
    await sleep(300)

    const stamp = Date.now()
    const cwd = `${String(store.getState().settings.cwd).replace(/[\\/]+$/, '')}/probe-projects/p1`
    await store.getState().patchSettings({
      projects: [{ id: 'probe-rm', cwd, name: '探针待移除', archived: false, createdAt: stamp, updatedAt: stamp }],
      projectGroups: [],
      recentCwds: [cwd]
    })
    store.setState({
      sessions: [{
        id: 'pr-s0',
        path: `${cwd}/session-0.jsonl`,
        cwd,
        projectId: 'probe-rm',
        title: '待移除项目的会话',
        named: true,
        createdAt: stamp,
        updatedAt: stamp,
        messageCount: 1
      }]
    })
    await until(() => !!rowOf('probe-rm') || !!q('[data-testid="rail-more-projects"]'), 6000)
    if (!rowOf('probe-rm') && q('[data-testid="rail-more-projects"]')) {
      click(q('[data-testid="rail-more-projects"]'))
    }
    const rowReady = await until(() => !!rowOf('probe-rm'), 6000)
    if (!rowReady) {
      out.push('  设置中的项目 = ' + JSON.stringify(store.getState().settings?.projects))
      out.push('  DOM 项目行 = ' + JSON.stringify(qa('[data-testid="rail-project-row"]').map((row) => ({ id: row.dataset.dragId, text: row.textContent?.trim() }))))
      out.push('  侧栏可见 = ' + !!q('.rail') + ' · 搜索框 = ' + JSON.stringify(q('.rail-search input')?.value ?? null))
    }
    ok(rowReady, '项目行出现')
    if (!rowReady) {
      await store.getState().patchSettings({ projects: [], projectGroups: [], recentCwds: [] })
      return out.join('\n')
    }

    openMenu('probe-rm')
    await until(() => !!q('[data-testid="rail-project-remove"]'))
    const item = q('[data-testid="rail-project-remove"]')
    ok(!!item, '项目菜单里有动作项 rail-project-remove')
    out.push(`  菜单项文案 = ${(item?.textContent ?? '').trim()}`)
    ok(!!item && item.textContent.includes('移除项目'), '菜单项文案是「移除项目」')

    if (item) click(item)
    await until(() => !!q('.rail-delete-dialog'))
    const dialog = q('.rail-delete-dialog')
    ok(!!dialog, '点击后弹出确认框')
    const message = dialog?.querySelector('.modal-message')?.textContent ?? ''
    ok(message.includes('已归档项目'), '确认框说明会话进「已归档项目」')
    ok(/磁盘(上的)?目录(不会被改动|不受影响)/.test(message), '确认框说明磁盘目录不动')

    const cancel = dialog?.querySelector('.modal-foot .btn')
    if (cancel) click(cancel)
    await sleep(300)
    ok(!q('.rail-delete-dialog'), '取消后确认框关闭')
    ok(!!rowOf('probe-rm'), '取消后项目还在列表里')
    const cancelled = (await window.yan.getSettings()).projects.find((p) => p.id === 'probe-rm')
    ok(cancelled?.archived === false, '取消后落盘 archived 仍是 false')

    openMenu('probe-rm')
    await until(() => !!q('[data-testid="rail-project-remove"]'))
    const item2 = q('[data-testid="rail-project-remove"]')
    if (item2) click(item2)
    await until(() => !!q('[data-testid="rail-remove-project-confirm"]'))
    const confirm = q('[data-testid="rail-remove-project-confirm"]')
    ok(!!confirm, '确认框里有「移除」按钮')
    if (confirm) click(confirm)
    await until(() => !rowOf('probe-rm'))
    ok(!rowOf('probe-rm'), '移除后默认列表里不再有该项目')
    const persisted = (await window.yan.getSettings()).projects.find((p) => p.id === 'probe-rm')
    ok(persisted?.archived === true, '移除后落盘 archived = true（会话跟着进归档）')
    ok(!!persisted, '项目记录没有被删掉（只是归档，可恢复）')

    const toggle = q('.rail-archive-toggle')
    ok(!!toggle, '有「已归档项目」入口')
    if (toggle) click(toggle)
    await until(() => !!rowOf('probe-rm'))
    ok(!!rowOf('probe-rm'), '「已归档项目」视图里能看到它')
    openMenu('probe-rm')
    await until(() => !!q('[data-testid="rail-project-remove"]'))
    const restore = q('[data-testid="rail-project-remove"]')
    out.push(`  归档视图同一位置文案 = ${(restore?.textContent ?? '').trim()}`)
    ok(!!restore && restore.textContent.includes('恢复项目'), '归档视图里同一位置是「恢复项目」')
    if (restore) click(restore)
    await until(() => !rowOf('probe-rm'))
    const restored = (await window.yan.getSettings()).projects.find((p) => p.id === 'probe-rm')
    ok(restored?.archived === false, '恢复后落盘 archived = false（可逆）')

    await store.getState().patchSettings({ projects: [], projectGroups: [], recentCwds: [] })
    await sleep(200)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
