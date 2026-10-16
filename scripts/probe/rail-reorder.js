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

  const pointerAt = (target, type, x, y) => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse'
    }))
  }

  const dragTo = async (fromEl, toEl, after) => {
    const a = fromEl.getBoundingClientRect()
    const b = toEl.getBoundingClientRect()
    const sx = a.left + a.width / 2
    const sy = a.top + a.height / 2
    const tx = b.left + b.width / 2
    const ty = after ? b.top + b.height * 0.75 : b.top + b.height * 0.25
    pointerAt(fromEl, 'pointerdown', sx, sy)
    await sleep(30)
    pointerAt(window, 'pointermove', sx, sy + 8)
    await sleep(30)
    pointerAt(window, 'pointermove', tx, ty)
    await sleep(80)
    const hints = qa('.drop-before, .drop-after').length
    const dragging = qa('.is-dragging').length
    pointerAt(window, 'pointerup', tx, ty)
    await sleep(60)
    let reachedWindow = false
    const mark = () => { reachedWindow = true }
    window.addEventListener('click', mark)
    const clickable = toEl.querySelector('.proj-pick') ?? toEl
    clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(30)
    window.removeEventListener('click', mark)
    await settle()
    return { hints, dragging, clickReachedWindow: reachedWindow }
  }

  const projectOrder = () => qa('[data-testid="rail-project-row"]').map((el) => el.dataset.dragId)
  const groupOrder = () => qa('[data-testid="rail-project-group"]').map((el) => el.dataset.groupId)
  const rowOf = (id) => q(`[data-testid="rail-project-row"][data-drag-id="${id}"]`)
  const headOf = (id) => q(`[data-testid="rail-project-group"][data-drag-id="${id}"]`)

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(250)
    }
    localStorage.setItem('yan.onboarded', '1')
    store.getState().setRailPinned(true)
    await sleep(300)

    const stamp = Date.now()
    const base = String(store.getState().settings.cwd ?? '').replace(/[\\/]+$/, '')
    const cwdOf = (n) => `${base}/probe-projects/p${n}`
    const groups = [
      { id: 'probe-reorder-a', name: '排序甲组', createdAt: stamp },
      { id: 'probe-reorder-b', name: '排序乙组', createdAt: stamp }
    ]
    const projects = [
      { id: 'pra1', cwd: cwdOf(1), name: '甲一', groupId: 'probe-reorder-a', archived: false, createdAt: stamp, updatedAt: stamp + 7 },
      { id: 'pra2', cwd: cwdOf(2), name: '甲二', groupId: 'probe-reorder-a', archived: false, createdAt: stamp, updatedAt: stamp + 6 },
      { id: 'prb1', cwd: cwdOf(3), name: '乙一', groupId: 'probe-reorder-b', archived: false, createdAt: stamp, updatedAt: stamp + 5 },
      { id: 'prb2', cwd: cwdOf(4), name: '乙二', groupId: 'probe-reorder-b', archived: false, createdAt: stamp, updatedAt: stamp + 4 },
      { id: 'prn1', cwd: cwdOf(5), name: '未分一', groupId: undefined, archived: false, createdAt: stamp, updatedAt: stamp + 3 },
      { id: 'prn2', cwd: cwdOf(6), name: '未分二', groupId: undefined, archived: false, createdAt: stamp, updatedAt: stamp + 2 },
      { id: 'prn3', cwd: cwdOf(7), name: '未分三', groupId: undefined, archived: false, createdAt: stamp, updatedAt: stamp + 1 }
    ]
    const cwdBefore = store.getState().settings.cwd
    await store.getState().patchSettings({
      projectGroups: groups,
      projects,
      recentCwds: projects.map((p) => p.cwd),
      projectOrder: []
    })
    store.setState({
      sessions: projects.map((p, i) => ({
        id: `pr-s${i}`,
        path: `${p.cwd}/session-${i}.jsonl`,
        cwd: p.cwd,
        projectId: p.id,
        title: `会话 ${i + 1}`,
        named: true,
        createdAt: stamp,
        updatedAt: stamp - i * 1000,
        messageCount: 1
      }))
    })
    await settle()

    const moreBtn = q('[data-testid="rail-more-projects"]')
    ok(!!moreBtn, '项目数超过预览上限时有「更多项目」入口')
    if (moreBtn) click(moreBtn)
    await settle()
    ok(q('[data-testid="rail-more-projects"]')?.dataset.expanded === '1', '点开后进入全量展开（data-expanded=1）')

    const initialProjects = projectOrder()
    const initialGroups = groupOrder()
    const probeIds = projects.map((p) => p.id)
    const allProbeRows = (list) => probeIds.every((id) => list.includes(id))
    out.push('  初始项目行 = ' + JSON.stringify(initialProjects))
    out.push('  初始分组标题 = ' + JSON.stringify(initialGroups))
    ok(initialGroups.join(',') === 'probe-reorder-a,probe-reorder-b', '两个分组标题按 projectGroups 顺序渲染', initialGroups.join(','))
    ok(allProbeRows(initialProjects), `探针的 7 个项目行都渲染出来了（共 ${initialProjects.length} 行）`)
    ok(initialProjects.slice(0, 2).join(',') === 'pra1,pra2', '甲组内先按活动序', initialProjects.slice(0, 2).join(','))

    const one = rowOf('pra1')
    const two = rowOf('pra2')
    ok(!!one && !!two, '找得到甲组的两个项目行')
    const d1 = await dragTo(two, one, false)
    ok(d1.dragging === 1, '拖拽中恰好一行带 is-dragging 视觉态', `实际 ${d1.dragging}`)
    ok(d1.hints === 1, '拖拽中恰好有一条插入提示线', `实际 ${d1.hints}`)
    ok(d1.clickReachedWindow === false, '拖拽松手后紧跟的 click 被吞掉（不会顺带切项目）')

    const afterProjects = projectOrder()
    out.push('  拖后项目行 = ' + JSON.stringify(afterProjects))
    ok(afterProjects.slice(0, 2).join(',') === 'pra2,pra1', '甲组内顺序真的换了（甲二到了甲一前面）', afterProjects.slice(0, 2).join(','))
    ok(allProbeRows(afterProjects), '其它组 / 未分组项目一个都没丢', `实际 ${afterProjects.length} 行`)
    ok(store.getState().settings.cwd === cwdBefore, '拖拽没有顺带切换项目（cwd 未变）')

    const saved1 = await window.yan.getSettings()
    ok(
      saved1.projectOrder.slice(0, 2).join(',') === 'pra2,pra1',
      '新顺序已经过 IPC 落盘（主进程读回一致）',
      JSON.stringify(saved1.projectOrder)
    )
    ok(
      allProbeRows(saved1.projectOrder),
      '落盘的顺序包含全部 7 个探针项目（不是只存被拖的那个）',
      `实际 ${saved1.projectOrder.length} 条`
    )

    const beforeCross = projectOrder().join(',')
    const orderBeforeCross = store.getState().settings.projectOrder.join(',')
    const a1 = rowOf('pra1')
    const b1 = rowOf('prb1')
    const d2 = await dragTo(a1, b1, true)
    ok(d2.hints === 0, '跨组的项目行上不显示插入线（归属变更不靠拖拽）', `实际 ${d2.hints}`)
    ok(projectOrder().join(',') === beforeCross, '跨组拖拽不改界面上的顺序')
    const saved2 = await window.yan.getSettings()
    ok(
      saved2.projectOrder.join(',') === orderBeforeCross,
      '跨组拖拽没有写盘',
      `${saved2.projectOrder.join(',')} vs ${orderBeforeCross}`
    )

    const headB = headOf('probe-reorder-b')
    const headA = headOf('probe-reorder-a')
    ok(!!headB && !!headA, '找得到两个分组标题')
    const d3 = await dragTo(headB, headA, false)
    ok(d3.hints === 1, '分组拖拽也有插入提示线', `实际 ${d3.hints}`)
    const groupsAfter = groupOrder()
    out.push('  拖后分组标题 = ' + JSON.stringify(groupsAfter))
    ok(groupsAfter.join(',') === 'probe-reorder-b,probe-reorder-a', '分组标题顺序换了', groupsAfter.join(','))
    const stGroups = store.getState().settings.projectGroups.map((g) => g.id)
    ok(stGroups.join(',') === 'probe-reorder-b,probe-reorder-a', 'projectGroups 数组顺序同步', stGroups.join(','))
    const saved3 = await window.yan.getSettings()
    ok(
      saved3.projectGroups.map((g) => g.id).join(',') === 'probe-reorder-b,probe-reorder-a',
      '分组顺序已经过 IPC 落盘',
      JSON.stringify(saved3.projectGroups.map((g) => g.id))
    )
    ok(
      saved3.projects.filter((p) => p.groupId === 'probe-reorder-a').length === 2 &&
        saved3.projects.filter((p) => p.groupId === 'probe-reorder-b').length === 2,
      '拖分组不动项目归属'
    )
    ok(
      saved3.projectOrder.indexOf('pra2') < saved3.projectOrder.indexOf('pra1') &&
        saved3.projectOrder.indexOf('prb1') < saved3.projectOrder.indexOf('prb2'),
      '分组换位不影响组内已排好的顺序',
      JSON.stringify(saved3.projectOrder)
    )

    const more = q('[data-testid="rail-more-projects"]')
    ok(!!more, '「更多项目」入口仍在（用来折叠回前五项）')
    if (more) {
      click(more)
      await settle()
      ok(q('[data-testid="rail-more-projects"]')?.dataset.expanded === '0', '再点一下折叠回前五项')
      const visible = qa('[data-testid="rail-project-row"]').length
      ok(visible === 5, `折叠态只渲染 5 行（实际 ${visible}）`)
      const first = qa('[data-testid="rail-project-row"]')[0]
      const firstId = first.dataset.dragId
      const fr = first.getBoundingClientRect()
      pointerAt(first, 'pointerdown', fr.left + 40, fr.top + 10)
      await sleep(30)
      pointerAt(window, 'pointermove', fr.left + 40, fr.top + 30)
      await sleep(150)
      const expandedNow = q('[data-testid="rail-more-projects"]')?.dataset.expanded
      const rowsNow = qa('[data-testid="rail-project-row"]').length
      ok(expandedNow === '1' && rowsNow > 5, '一开始拖就自动展开到全部项目（否则拖不到隐藏的行）', `expanded=${expandedNow} rows=${rowsNow}`)
      const second = qa('[data-testid="rail-project-row"]')[1].getBoundingClientRect()
      pointerAt(window, 'pointermove', second.left + 40, second.top + second.height * 0.75)
      await sleep(80)
      pointerAt(window, 'pointerup', second.left + 40, second.top + second.height * 0.75)
      await settle()
      const afterFold = projectOrder()
      ok(afterFold.indexOf(firstId) === 1, '折叠态下开始的拖拽同样生效（落到了第二位）', `${firstId}@${afterFold.indexOf(firstId)}`)
      ok(allProbeRows(afterFold), '展开后的顺序里探针项目一个不少', `实际 ${afterFold.length} 行`)
    }

    await until(() => !!q('[data-testid="rail-search"]'))
    const input = q('[data-testid="rail-search"]')
    if (input) {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '甲')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
      const rows = qa('[data-testid="rail-project-row"]')
      out.push('  搜索「甲」命中 ' + rows.length + ' 行')
      if (rows.length >= 1) {
        const r = rows[0].getBoundingClientRect()
        pointerAt(rows[0], 'pointerdown', r.left + 40, r.top + 10)
        await sleep(30)
        pointerAt(window, 'pointermove', r.left + 40, r.top + 30)
        await sleep(80)
        ok(qa('.is-dragging').length === 0, '搜索态下拖动不进入拖拽态（筛过的顺序不能当真实排列）')
        pointerAt(window, 'pointerup', r.left + 40, r.top + 30)
        await settle()
      } else {
        ok(false, '搜索「甲」应当命中甲组下的项目')
      }
      click(q('[data-testid="rail-search-clear"]'))
      await settle()
    } else {
      ok(false, '搜索框应当打开')
    }

    ok(qa('.is-dragging').length === 0, '拖完之后没有残留的 is-dragging', `实际 ${qa('.is-dragging').length}`)
    ok(qa('.drop-before, .drop-after').length === 0, '拖完之后没有残留的插入线', `实际 ${qa('.drop-before, .drop-after').length}`)
    ok(!document.body.classList.contains('rail-dragging'), 'body 上没有残留的 rail-dragging 类')

    await store.getState().patchSettings({
      projectOrder: ['ghost-not-a-project', ...store.getState().settings.projectOrder]
    })
    await sleep(200)
    const savedGhost = await window.yan.getSettings()
    ok(
      !savedGhost.projectOrder.includes('ghost-not-a-project'),
      '不存在的项目 id 不会留在 projectOrder 里',
      JSON.stringify(savedGhost.projectOrder)
    )
    ok(savedGhost.projectOrder.length > 0, '沏掉幽灵 id 的同时不误伤真实项目', `剩 ${savedGhost.projectOrder.length} 条`)

    await store.getState().patchSettings({ projectGroups: [], projects: [], recentCwds: [], projectOrder: [] })
    await sleep(200)
    const saved4 = await window.yan.getSettings()
    ok(saved4.projectOrder.length === 0, '收尾后 projectOrder 与项目一起被清掉（不残留孤儿 id）', JSON.stringify(saved4.projectOrder))
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
