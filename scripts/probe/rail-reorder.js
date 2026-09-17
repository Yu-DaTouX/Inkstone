/**
 * 项目 / 分组拖拽排序（N01）。
 *
 * 用户反馈的「分组不全面」第二条：分组和项目的**顺序**定不下来 ——
 * 之前项目按最近活动自动排、分组按创建顺序，用户没法把常用的挪到前面。
 *
 * 这里用**合成的 PointerEvent** 走真实渲染路径：
 *   pointerdown（行上）→ pointermove（越过阈值）→ pointermove（落点）→ pointerup
 * 实现里没有用 HTML5 的 draggable，所以这条路径与应用里用户手拖的那条是**同一条**；
 * 断言看三处：
 *   1. 界面上行的先后（DOM 顺序）
 *   2. store 里的设置（projectOrder / projectGroups）
 *   3. `window.yan.getSettings()` 读回的值 —— 证明真的过了 IPC 写盘
 *
 * 另外验三条边界：折叠态下能拖、搜索态下不能拖、拖完紧跟的 click 被吞掉。
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
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }
  const settle = () => sleep(420)

  /** 合成一次指针事件（React 的 onPointerDown 走合成冒泡，window 监听直接收到） */
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

  /**
   * 把 `fromEl` 这一行拖到 `toEl` 的上半（after=false）或下半（after=true）。
   *
   * 中间那次「越过阈值」的移动不能省：实现里按下时只是**记录候选**，
   * 没超过 4px 一律当点击 —— 否则项目行的单击就没法用了。
   * 返回落点提示线的数量（拖拽中应恰好有 1 条）。
   */
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
    /* 浏览器在 pointerup 之后一定会补一个 click；实现必须吞掉它，否则会顺带切项目 */
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
    /* 展开完整侧栏（mini 态下没有项目行） */
    store.getState().setRailPinned(true)
    await sleep(300)

    /* ---- 造 2 个分组 + 7 个项目（超过「前五项」预览上限，用来验折叠态的拖拽）---- */
    const stamp = Date.now()
    const base = String(store.getState().settings.cwd ?? '').replace(/[\\/][^\\/]*$/, '')
    const cwdOf = (n) => `${base}/yan-probe-reorder-${n}`
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
    await settle()

    /* 默认只展开前五项 —— 先点开「更多项目」，让七个行都在 */
    const moreBtn = q('[data-testid="rail-more-projects"]')
    ok(!!moreBtn, '项目数超过预览上限时有「更多项目」入口')
    if (moreBtn) click(moreBtn)
    await settle()
    ok(q('[data-testid="rail-more-projects"]')?.dataset.expanded === '1', '点开后进入全量展开（data-expanded=1）')

    const initialProjects = projectOrder()
    const initialGroups = groupOrder()
    const probeIds = projects.map((p) => p.id)
    /** 探针造的 7 个项目一个不少（环境里可能还有别的项目记录，不按绝对数量断言） */
    const allProbeRows = (list) => probeIds.every((id) => list.includes(id))
    out.push('  初始项目行 = ' + JSON.stringify(initialProjects))
    out.push('  初始分组标题 = ' + JSON.stringify(initialGroups))
    ok(initialGroups.join(',') === 'probe-reorder-a,probe-reorder-b', '两个分组标题按 projectGroups 顺序渲染', initialGroups.join(','))
    ok(allProbeRows(initialProjects), `探针的 7 个项目行都渲染出来了（共 ${initialProjects.length} 行）`)
    ok(initialProjects.slice(0, 2).join(',') === 'pra1,pra2', '甲组内先按活动序', initialProjects.slice(0, 2).join(','))

    /* ---- 1. 同组内拖项目：把「甲二」拖到「甲一」之前 ---- */
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

    /* ---- 2. 跨组落点必须被拒绝（同组才允许换序）---- */
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

    /* ---- 3. 拖分组：把「乙组」拖到「甲组」之前 ---- */
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
    /* 分组换了位置，但组内项目归属不能被顺带改掉 */
    ok(
      saved3.projects.filter((p) => p.groupId === 'probe-reorder-a').length === 2 &&
        saved3.projects.filter((p) => p.groupId === 'probe-reorder-b').length === 2,
      '拖分组不动项目归属'
    )
    /* 组内项目的先后也要保住（分组换位只换标题的顺序） */
    ok(
      saved3.projectOrder.indexOf('pra2') < saved3.projectOrder.indexOf('pra1') &&
        saved3.projectOrder.indexOf('prb1') < saved3.projectOrder.indexOf('prb2'),
      '分组换位不影响组内已排好的顺序',
      JSON.stringify(saved3.projectOrder)
    )

    /* ---- 4. 折叠态（默认只展开前 5 个）下开始拖 → 自动展开 ---- */
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
      /*
       * 落点选**第二行**（与第一行同组）—— 分组之间不接受落点，
       * 选第 3 行就可能跨组、进而什么都验不到。
       */
      const second = qa('[data-testid="rail-project-row"]')[1].getBoundingClientRect()
      pointerAt(window, 'pointermove', second.left + 40, second.top + second.height * 0.75)
      await sleep(80)
      pointerAt(window, 'pointerup', second.left + 40, second.top + second.height * 0.75)
      await settle()
      const afterFold = projectOrder()
      ok(afterFold.indexOf(firstId) === 1, '折叠态下开始的拖拽同样生效（落到了第二位）', `${firstId}@${afterFold.indexOf(firstId)}`)
      ok(allProbeRows(afterFold), '展开后的顺序里探针项目一个不少', `实际 ${afterFold.length} 行`)
    }

    /* ---- 5. 搜索态下不允许拖 ---- */
    click(q('[data-testid="rail-search-btn"]'))
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

    /* ---- 6. 收尾：视觉态不能残留 ---- */
    ok(qa('.is-dragging').length === 0, '拖完之后没有残留的 is-dragging', `实际 ${qa('.is-dragging').length}`)
    ok(qa('.drop-before, .drop-after').length === 0, '拖完之后没有残留的插入线', `实际 ${qa('.drop-before, .drop-after').length}`)
    ok(!document.body.classList.contains('rail-dragging'), 'body 上没有残留的 rail-dragging 类')

    /* ---- 7. 设置里的陈旧项目 id 要被清掉（读盘与写盘两处清洗）---- */
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

    /* 把探针造的数据清掉（隔离目录，但仍然不给下一场景留脏数据） */
    await store.getState().patchSettings({ projectGroups: [], projects: [], recentCwds: [], projectOrder: [] })
    await sleep(200)
    const saved4 = await window.yan.getSettings()
    ok(saved4.projectOrder.length === 0, '收尾后 projectOrder 与项目一起被清掉（不残留孤儿 id）', JSON.stringify(saved4.projectOrder))
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
