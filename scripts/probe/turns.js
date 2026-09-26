/**
 * 画布轮次层（实施-26 R3 / R4，cost 0）。
 *
 * 用**隔离目录里的真会话文件**（test:live 预置的 yan-family / yan-plain-fixture，
 * 父子分叉 + 20 条消息），走真实 `yan:peekSession`：
 * 验的是「点开才读 → 一轮一张卡 → 子会话首轮与父会话那一轮对齐 → 收起/键盘」。
 * 读不出来的分支（文件不存在）也在这里验。
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
  const text = (el) => (el?.textContent ?? '').trim()
  const rect = (el) => el.getBoundingClientRect()

  const nodeOf = (path) => qa('[data-testid="map-node"]').find((n) => n.dataset.path === path)
  const toggleOf = (path) => qa('[data-testid="map-turns-toggle"]').find((n) => n.dataset.path === path)
  const cardsOf = (path) => qa('[data-testid="map-turn-card"]').filter((n) => n.dataset.path === path)
  const stateOf = (path, kind) =>
    qa(`[data-testid="${kind}"]`).find((n) => n.dataset.path === path)

  const waitCards = async (path, min = 1) => {
    for (let i = 0; i < 120; i++) {
      if (cardsOf(path).length >= min) break
      await sleep(150)
    }
    return cardsOf(path)
  }

  try {
    for (let i = 0; i < 40; i++) {
      if (q('[data-testid="view-switch"]')) break
      await sleep(200)
    }
    const sessions = store.getState().sessions
    const parent = sessions.find((s) => s.path.includes('yan-family-parent'))
    const child = sessions.find((s) => s.path.includes('yan-family-child1'))
    const plain = sessions.find((s) => s.path.includes('yan-plain-fixture'))
    const bulk = sessions.find((s) => s.path.includes('yan-bulk-fixture'))
    ok(!!parent && !!child, '隔离目录里有父子分叉会话（fixture）')
    ok(!!plain, '隔离目录里有 20 条消息的普通会话（fixture）')
    ok(!!bulk, '隔离目录里有 400 条消息的规模会话（fixture）')
    if (!parent || !child || !plain || !bulk) return out.join('\n')

    ok(!!child.branchOrigin, `子会话带着「分叉自哪句话」（${child.branchOrigin ?? '空'}）`)

    click(q('[data-testid="view-map"]'))
    for (let i = 0; i < 30; i++) {
      if (q('.wb-map') && q('[data-testid="map-node"]')) break
      await sleep(200)
    }
    ok(!!nodeOf(parent.path) && !!nodeOf(child.path), '地图上有父会话与子会话')
    ok(!!nodeOf(plain.path), '地图上有普通会话')

    /* ---- 1. 默认不展开：轮次是点了才读的（渐进披露） ---- */
    ok(cardsOf(plain.path).length === 0, '默认不展开：地图上没有轮次卡')
    ok(!!toggleOf(plain.path), '会话节点上有「展开轮次」按钮')

    /* ---- 2. 多轮会话：一轮一张卡 ---- */
    click(toggleOf(plain.path))
    const plainCards = await waitCards(plain.path, 5)
    ok(plainCards.length >= 8, `20 条消息的会话展开出多张卡（实际 ${plainCards.length}）`)
    ok(text(plainCards[0].querySelector('[data-testid="map-turn-index"]')) === '1', '第一张卡序号是 1')
    const firstText = text(plainCards[0])
    ok(firstText.includes('问'), '卡上看得见问题标签')
    ok(/YAN-PLAIN|plain/i.test(firstText), '卡上看得见那条问题本身')

    /* ---- 3. 卡片不撑破、不重叠 ---- */
    const heights = plainCards.map((c) => rect(c).height)
    ok(
      heights.every((h) => h > 0 && h <= 60),
      '每张卡高度受控（长回答不撑破卡）'
    )
    const gaps = plainCards.slice(1).map((c, i) => rect(c).top - rect(plainCards[i]).bottom)
    ok(
      gaps.every((g) => g >= -1),
      '卡与卡不重叠'
    )
    const laneBoxes = qa('.wb-lane').map((l) => rect(l))
    ok(
      laneBoxes.every((b) => b.height > 0),
      '轮次层算进泳道高度（泳道都被撑开了）'
    )

    /* ---- 4. 对齐：子会话首轮落在父会话那一轮上 ---- */
    click(toggleOf(parent.path))
    const parentCards = await waitCards(parent.path, 1)
    click(toggleOf(child.path))
    const childCards = await waitCards(child.path, 2)
    ok(parentCards.length === 1, '父会话是一轮')
    /*
     * 分叉会话带着分叉前的历史（真实 pi 的分叉文件就是这样）：
     * 子会话自己是「分叉后的那一轮」，前面还有一轮继承来的源问题。
     */
    ok(childCards.length === 2, `分叉会话展开后含继承的那一轮（实际 ${childCards.length}）`)
    if (parentCards.length === 1 && childCards.length >= 1) {
      ok(childCards[0].dataset.aligned === '1', '子会话首轮标出「对齐到父会话这一轮」')
      const dy = Math.abs(rect(childCards[0]).top - rect(parentCards[0]).top)
      ok(dy <= 2, `子会话首轮与父会话那一轮同高（实测差 ${dy.toFixed(1)}px）`)
    }

    /* ---- 5. 收起 / 键盘：移动 → 展开 → 打开 ---- */
    click(toggleOf(child.path))
    await sleep(200)
    ok(cardsOf(child.path).length === 0, '点按钮能收起轮次层')
    key(nodeOf(child.path), 't')
    const again = await waitCards(child.path, 2)
    ok(again.length === 2, '节点上按 t 又能展开（键盘可达）')
    const second = plainCards[1]
    plainCards[0].focus()
    key(plainCards[0], 'ArrowDown')
    await sleep(80)
    ok(
      document.activeElement?.dataset?.turnId === second?.dataset.turnId,
      '卡上 ↓ 走到下一轮'
    )
    key(document.activeElement, 'ArrowUp')
    await sleep(80)
    ok(document.activeElement?.dataset?.turnId === plainCards[0].dataset.turnId, '卡上 ↑ 走回上一轮')
    key(document.activeElement, 'ArrowUp')
    await sleep(80)
    ok(
      document.activeElement?.dataset?.path === plain.path && !document.activeElement?.dataset?.turnId,
      '首张卡 ↑ 回到会话节点（移动闭环）'
    )

    /* ---- 6. 从这一轮分叉（R5）：锚点来自消息自带的 entryId ---- */
    const forks = qa('[data-testid="map-turn-fork"]').filter(
      (b) => b.closest('[data-testid="map-turn-card"]')?.dataset.path === plain.path
    )
    ok(forks.length > 0, '轮次卡上有「从这一轮分叉」入口')
    ok(
      forks.every((b) => (b.dataset.entry ?? '').length > 0),
      '分叉入口带着消息的 entryId（不从 DOM 猜）'
    )
    const forkEntries = new Set(forks.map((b) => b.dataset.entry))
    ok(forkEntries.size === forks.length, '每一轮的分叉锚点各不相同（各自指向自己的那条消息）')

    /* ---- 8. 同时展开的上限（R7 的阈值重算） ---- */
    const expanded = new Set(qa('[data-testid="map-turn-card"]').map((c) => c.dataset.path))
    ok(expanded.size <= 3, `同时展开的会话不超过 3 个（当前 ${expanded.size}）`)
    const before = expanded.size
    click(toggleOf(bulk.path))
    await sleep(250)
    const afterReject = new Set(qa('[data-testid="map-turn-card"]').map((c) => c.dataset.path))
    if (before >= 3) {
      ok(afterReject.size === before, '碰上限时不再展开（不会越点越多）')
      ok(!!q('[data-testid="map-turns-limit"]'), '碰上限时给出明确提示')
      /* 收一个腾位置，规模用例才有地方展开 */
      click(toggleOf(plain.path))
      await sleep(200)
    } else {
      ok(true, '（未到上限，跳过拒绝路径）')
    }

    /* ---- 7. 规模（R7）：一个会话几百轮展开不塌 ---- */
    const t0 = performance.now()
    click(toggleOf(bulk.path))
    const bulkCards = await waitCards(bulk.path, 100)
    const elapsed = performance.now() - t0
    ok(bulkCards.length >= 100, `400 条消息的会话能展开出上百张卡（实际 ${bulkCards.length}）`)
    ok(elapsed < 20000, `展开耗时受控（实测 ${Math.round(elapsed)}ms）`)
    const bulkRect = bulkCards[bulkCards.length - 1].getBoundingClientRect()
    ok(bulkRect.height > 0 && bulkRect.height <= 60, '长链上的卡依然不撑破')

    /* ---- 9. 读不出来要说清楚：不假装「这个会话没有轮次」 ---- */
    /* 先收一个腾位置（展开上限是 3） */
    click(toggleOf(bulk.path))
    await sleep(200)
    const ghost = {
      id: 'yan-ghost-turns',
      path: 'C:/yan-probe/不存在的会话.jsonl',
      cwd: parent.cwd,
      title: '读不出来的会话',
      named: true,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 3,
      lastActivityAt: 1
    }
    store.setState({ sessions: [...store.getState().sessions, ghost] })
    await sleep(200)
    const ghostToggle = toggleOf(ghost.path)
    ok(!!ghostToggle, '读不出来的会话也有展开按钮')
    click(ghostToggle)
    for (let i = 0; i < 30; i++) {
      if (stateOf(ghost.path, 'map-turns-error')) break
      await sleep(150)
    }
    ok(!!stateOf(ghost.path, 'map-turns-error'), '文件读不出来时显示「轮次读不出来」')
    ok(cardsOf(ghost.path).length === 0, '失败态下不伪造轮次卡')

    /* 收尾：把注入的假会话撤掉，别留给后面的步骤 */
    store.setState({ sessions: store.getState().sessions.filter((s) => s.id !== ghost.id) })
    await sleep(150)
    ok(!nodeOf(ghost.path), '撤掉假会话后地图不再显示它')
  } catch (e) {
    out.push('  ✗ 探针抛异常：' + (e && e.message ? e.message : String(e)))
  }

  return out.join('\n')
})()
