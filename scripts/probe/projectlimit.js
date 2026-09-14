/**
 * 项目默认只展开前五个（N17）。
 *
 * 用户反馈：项目多了以后左栏一屏放不下，常用的几个被淹没。
 * 现在默认截断到前 5 个（**显示层**，归属不动），超出部分收在
 * 「更多项目（N）」后面；当前项目如果落在第 5 个之后，自动展开到它，
 * 搜索时临时显示全部匹配。
 *
 * 数据造在隔离目录的 desktop.json 里（patchSettings），不碰真实项目。
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
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const setValue = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const settle = () => sleep(450)
  const projCount = () => qa('.proj').length
  const groupTitles = () => qa('[data-testid="rail-project-group"]').map((el) => (el.querySelector('.proj-group-name')?.textContent ?? '').trim())

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(250)
    }
    localStorage.setItem('yan.onboarded', '1')
    store.getState().setRailPinned(true)
    await settle()

    /* ---- 造数据：甲组 5 个（排在最前）+ 乙组 2 个（会被截断）---- */
    const stamp = Date.now()
    const base = String(store.getState().settings.cwd).replace(/[\\/][^\\/]*$/, '')
    const mk = (n, groupId) => {
      const cwd = `${base}/yan-probe-pl-${n}`
      return {
        project: { id: `pl${n}`, cwd, name: `项目${n}`, groupId, archived: false, createdAt: stamp, updatedAt: stamp },
        name: `第${n}号项目`
      }
    }
    const a = [1, 2, 3, 4, 5].map((n) => mk(n, 'pl-group-a'))
    const b = [6, 7].map((n) => mk(n, 'pl-group-b'))
    const all = [...a, ...b]
    const groups = [
      { id: 'pl-group-a', name: '甲组', createdAt: stamp },
      { id: 'pl-group-b', name: '乙组', createdAt: stamp }
    ]
    const projectNames = {}
    for (const x of all) projectNames[x.project.cwd] = x.name
    await store.getState().patchSettings({
      projectGroups: groups,
      projects: all.map((x) => x.project),
      recentCwds: all.map((x) => x.project.cwd),
      projectNames: { ...store.getState().settings.projectNames, ...projectNames }
    })
    /* 当前项目放在第一个（在前五之内） */
    store.setState({ session: { ...(store.getState().session ?? {}), cwd: a[0].project.cwd } })
    await settle()

    out.push(`  项目总数 = ${projCount()}，分组标题 = ${JSON.stringify(groupTitles())}`)
    const collapsedCount = projCount()
    ok(collapsedCount === 5, `默认只显示 5 个项目（实际 ${collapsedCount}）`)
    ok(groupTitles().length === 1 && groupTitles()[0] === '甲组', '被截断的乙组不显示空标题')

    const more = q('[data-testid="rail-more-projects"]')
    ok(!!more, '有「更多项目」入口')
    out.push('  按钮文案 = ' + JSON.stringify((more?.textContent || '').trim()))
    const hiddenNum = Number(((more?.textContent || '').match(/(\d+)/) || [])[1])
    ok(hiddenNum > 0, `按钮显示隐藏的项目数（${hiddenNum}）`)
    ok(more?.dataset.expanded === '0', '默认处于折叠态')

    /* ---- 展开 ---- */
    if (more) click(more)
    await settle()
    const expandedCount = projCount()
    ok(expandedCount === collapsedCount + hiddenNum, `展开后显示全部项目（${collapsedCount} + ${hiddenNum} = ${expandedCount}）`)
    ok(groupTitles().length === 2 && groupTitles().includes('乙组'), '展开后乙组标题出现（分组结构没被破坏）')
    ok(q('[data-testid="rail-more-projects"]')?.dataset.expanded === '1', '按钮变成展开态（文案为「收起」）')
    out.push('  展开后按钮文案 = ' + JSON.stringify((q('[data-testid="rail-more-projects"]')?.textContent || '').trim()))

    /* ---- 收起 ---- */
    click(q('[data-testid="rail-more-projects"]'))
    await settle()
    ok(projCount() === 5, `收起后回到 5 个（实际 ${projCount()}）`)

    /* ---- 当前项目在第 5 个之后：自动展开 ---- */
    store.setState({ session: { ...(store.getState().session ?? {}), cwd: b[0].project.cwd } })
    await sleep(700)
    out.push(`  当前项目=乙组首个 → 显示 ${projCount()} 个`)
    ok(projCount() === expandedCount, '当前项目在默认范围之外时自动展开（能看见自己在哪）')
    ok(!!q('.proj-head[data-current="1"]'), '当前项目行带 data-current 标记')

    /* ---- 搜索：临时显示全部匹配，清空后回到折叠态 ---- */
    click(q('[data-testid="rail-search-btn"]'))
    await sleep(350)
    const search = q('[data-testid="rail-search"]')
    ok(!!search, '搜索框打开')
    const body = q('.rail-body')
    const scrollBefore = body?.scrollTop ?? 0
    setValue(search, '第6号')
    await settle()
    out.push(`  搜「第6号」→ ${projCount()} 个项目`)
    ok(projCount() === 1, '搜索时只显示匹配的项目（不受 5 个限制）')

    /* 清空：折叠状态、焦点、滚动位置都回来 */
    click(q('[data-testid="rail-search-clear"]'))
    await settle()
    ok(!!q('[data-testid="rail-search"]'), '清空按钮不会关掉搜索框')
    ok(document.activeElement === q('[data-testid="rail-search"]'), '清空后焦点回到搜索框')
    ok(projCount() === expandedCount, `清空搜索后恢复当前项目所在的展开态（实际 ${projCount()}）`)
    out.push(`  滚动位置 ${scrollBefore} → ${body?.scrollTop ?? 0}`)
    ok(Math.abs((body?.scrollTop ?? 0) - scrollBefore) <= 2, '滚动位置没有被搜索清空改动')

    /* ---- 收尾 ---- */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(200)
    await store.getState().patchSettings({ projectGroups: [], projects: [], recentCwds: [], projectNames: {} })
    await sleep(200)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
