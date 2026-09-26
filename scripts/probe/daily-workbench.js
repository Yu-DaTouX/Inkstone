/**
 * 日常模式工作台（实施-18 S5，cost 0）。
 *
 * 覆盖两件事：
 *   · 会话地图：入口只在 daily 出现、节点/边/泳道数正确、搜索弱化不删、
 *     键盘移动与打开、关闭按钮与 Esc 退出；
 *   · 工作台首页：无消息时四张卡 + 地图入口都在。
 *
 * 会话是**注入**的合成数据（不连接真实会话文件）；这里验的是渲染与交互，
 * 不代表真实会话规模下的性能（那要真机跑，见 §7 的性能风险）。
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
  const store = window.__yanStore
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const key = (el, k) =>
    el && el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  const setInput = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const sessions = [
    {
      id: 's1', path: 'C:/yan-probe/s1.jsonl', cwd: 'C:/proj/a', title: '根会话', named: false,
      projectId: 'pa', createdAt: 1, updatedAt: 1, messageCount: 3, lastActivityAt: 100
    },
    {
      id: 's2', path: 'C:/yan-probe/s2.jsonl', cwd: 'C:/proj/a', title: '分支一', named: false,
      projectId: 'pa', parentSession: 'C:/yan-probe/s1.jsonl', createdAt: 10, updatedAt: 10,
      messageCount: 1, lastActivityAt: 200
    },
    {
      id: 's3', path: 'C:/yan-probe/s3.jsonl', cwd: 'C:/proj/b', title: '另一项目', named: false,
      projectId: 'pb', createdAt: 20, updatedAt: 20, messageCount: 5, lastActivityAt: 300
    }
  ]
  const inject = () => store.setState({ sessions, messages: [] })
  const openMap = async () => {
    for (let i = 0; i < 25; i++) {
      if (q('[data-testid="view-switch"]')) break
      await sleep(200)
    }
    click(q('[data-testid="view-map"]'))
    for (let i = 0; i < 25; i++) {
      if (q('.wb-map')) break
      await sleep(200)
    }
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.stream') && store.getState().settings) break
      await sleep(250)
    }
    await sleep(800)

    /* ---- 日常模式 + 工作台首页 ---- */
    inject()
    await store.getState().setWorkspaceMode('daily')
    await sleep(700)
    out.push(
      '  诊断 mode=' +
        store.getState().workspaceMode +
        ' settingsMode=' +
        store.getState().settings?.workspaceMode +
        ' testids=' +
        qa('[data-testid]')
          .map((e) => e.dataset.testid)
          .slice(0, 30)
          .join(',') +
        ' crash=' +
        (q('[data-testid="crash-detail"]')?.textContent ?? '-').replace(/\s+/g, ' ').slice(0, 240)
    )
    ok(q('[data-testid="view-switch"]') !== null, '日常模式：会话标题旁出现对话/地图切换')

    for (let i = 0; i < 25; i++) {
      if (q('[data-testid="workbench-home"]')) break
      await sleep(200)
      if (i % 5 === 4) inject()
    }
    ok(q('[data-testid="workbench-home"]') !== null, '日常模式空会话显示工作台首页')
    for (const id of ['wb-card-continue', 'wb-card-goal', 'wb-card-todos', 'wb-card-sources', 'wb-card-map']) {
      ok(q(`[data-testid="${id}"]`) !== null, `首页卡片存在：${id}`)
    }

    /* ---- 会话地图：结构 ---- */
    await openMap()
    ok(q('.wb-map') !== null, '点击入口打开会话地图')
    const nodes = qa('[data-testid="map-node"]')
    ok(nodes.length === 3, `地图渲染 3 个节点（实际 ${nodes.length}）`)
    ok(qa('.wb-edge').length === 1, `父子边 1 条（实际 ${qa('.wb-edge').length}）`)
    ok(qa('.wb-lane').length === 2, `跨项目分 2 条泳道（实际 ${qa('.wb-lane').length}）`)
    ok(q('[data-testid="map-info"]') !== null, '地图底部有焦点信息条')

    /* ---- 画布：工具条 / 缩放 / 整理 ---- */
    ok(q('[data-testid="map-tools"]') !== null, '画布工具条在（整理 / 定位 / 适配 / 缩放）')
    const zoomBefore = q('[data-testid="map-zoom-level"]')?.textContent
    click(q('[data-testid="map-zoom-in"]'))
    await sleep(250)
    const zoomAfter = q('[data-testid="map-zoom-level"]')?.textContent
    ok(zoomAfter !== zoomBefore, `缩放按钮改变比例（${zoomBefore} → ${zoomAfter}）`)
    click(q('[data-testid="map-tidy"]'))
    await sleep(250)
    ok(q('[data-testid="map-zoom-level"]')?.textContent === '100%', '整理把缩放复位到 100%')

    /* ---- 折叠子树：节点与连线一起收起，再点一下回来 ---- */
    ok(qa('[data-testid="map-fold"]').length === 1, `只有有子会话的卡片带折叠按钮（实际 ${qa('[data-testid="map-fold"]').length}）`)
    click(q('[data-testid="map-fold"]'))
    await sleep(300)
    ok(qa('[data-testid="map-node"]').length === 2, `折叠后只渲染 2 个节点（实际 ${qa('[data-testid="map-node"]').length}）`)
    ok(qa('.wb-edge').length === 0, '折叠后连线也一起收起来')
    ok(q('[data-testid="map-folded-count"]') !== null, '折叠的卡片上显示藏了多少条')
    click(q('[data-testid="map-fold"]'))
    await sleep(300)
    ok(qa('[data-testid="map-node"]').length === 3, '再点一次展开回来')

    /* ---- 拖动卡片：换位置，且不误触发打开会话 ---- */
    const dragNode = qa('[data-testid="map-node"]').find((n) => n.dataset.path === 'C:/yan-probe/s1.jsonl')
    ok(!!dragNode, '找到要拖动的卡片')
    if (dragNode) {
      const before = dragNode.getBoundingClientRect()
      const fire = (type, x, y) =>
        dragNode.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true })
        )
      fire('pointerdown', before.left + 20, before.top + 10)
      fire('pointermove', before.left + 90, before.top + 46)
      fire('pointerup', before.left + 90, before.top + 46)
      await sleep(300)
      const after = dragNode.getBoundingClientRect()
      ok(Math.abs(after.left - before.left) > 30, `拖动改变了卡片位置（${Math.round(before.left)} → ${Math.round(after.left)}）`)
      ok(q('.wb-map') !== null, '拖动不会误触发打开会话')
      click(q('[data-testid="map-tidy"]'))
      await sleep(250)
      const restored = dragNode.getBoundingClientRect()
      ok(Math.abs(restored.left - before.left) < 3, `整理后卡片回到自动布局（${Math.round(restored.left)} ≈ ${Math.round(before.left)}）`)
    }

    /* ---- 预览抽屉：点卡片看内容，不离开地图 ---- */
    const previewTarget = qa('[data-testid="map-node"]').find((n) => n.dataset.path === 'C:/yan-probe/s3.jsonl')
    ok(!!previewTarget, '找到要预览的卡片')
    if (previewTarget) {
      click(previewTarget)
      for (let i = 0; i < 25; i++) {
        if (q('[data-testid="map-preview"]')) break
        await sleep(200)
      }
      ok(q('[data-testid="map-preview"]') !== null, '点击卡片打开预览')
      ok(q('.wb-map') !== null, '预览不离开地图')
      ok(q('[data-testid="map-preview-stat"]') !== null, '预览有统计行')
      ok(q('[data-testid="map-preview-fork"]') === null, '非当前会话不给分叉入口')

      /* Esc 先关预览，不退出地图 */
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(300)
      ok(q('[data-testid="map-preview"]') === null, 'Esc 关掉预览')
      ok(q('.wb-map') !== null, 'Esc 关预览时地图还在')

      /* 关闭按钮 */
      click(previewTarget)
      await sleep(300)
      click(q('[data-testid="map-preview-close"]'))
      await sleep(300)
      ok(q('[data-testid="map-preview"]') === null, '关闭按钮关掉预览')
    }

    /* ---- 搜索弱化而非删除 ---- */
    const search = q('[data-testid="map-search"]')
    if (search) {
      setInput(search, '根')
      await sleep(300)
      ok(qa('[data-testid="map-node"]').length === 3, '搜索不会删除节点（弱化而非过滤）')
      ok(qa('.wb-node.dim').length >= 1, '不匹配的节点被弱化')
      setInput(search, '')
      await sleep(200)
    } else {
      ok(false, '地图有搜索框')
    }

    /* ---- 键盘：移动 + 打开 ---- */
    const root = qa('[data-testid="map-node"]').find((n) => n.dataset.path === 'C:/yan-probe/s1.jsonl')
    ok(!!root, '找到根会话节点')
    if (root) {
      root.focus()
      await sleep(150)
      ok(document.activeElement === root, '节点可获得键盘焦点')
      key(root, 'ArrowDown')
      await sleep(250)
      ok(
        document.activeElement?.dataset?.path === 'C:/yan-probe/s2.jsonl',
        '方向键在同泳道内移动焦点（实际 ' + (document.activeElement?.dataset?.path ?? '') + '）'
      )
      key(document.activeElement, 'Enter')
      for (let i = 0; i < 25; i++) {
        if (!q('.wb-map')) break
        await sleep(200)
      }
      ok(q('.wb-map') === null, 'Enter 打开会话后回到对话视图')
    }

    /* ---- 关闭按钮 ---- */
    await openMap()
    ok(q('.wb-map') !== null, '可以再次打开地图')
    click(q('[data-testid="view-chat"]'))
    await sleep(400)
    ok(q('.wb-map') === null, '切换器切回对话后退出地图')

    /* ---- Esc 退出 ---- */
    await openMap()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(400)
    ok(q('.wb-map') === null, 'Esc 退出地图')

    /* ---- 编码模式：入口与首页都不出现 ---- */
    await store.getState().setWorkspaceMode('coding')
    await sleep(700)
    ok(q('[data-testid="view-switch"]') === null, '编码模式：没有视图切换')
    ok(q('[data-testid="workbench-home"]') === null, '编码模式：不渲染工作台首页')

    /* 开关状态由设置真源决定（S0 的迁移结果） */
    ok(
      store.getState().settings?.workspaceMode === 'coding',
      '工作区模式写入 AppSettings 真源',
      String(store.getState().settings?.workspaceMode)
    )
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
