export async function runTileTreeTests(ok, tree, zones) {
  const {
    TILE_GAP,
    TILE_MIN_PX,
    tileLeaf,
    tileStack,
    nextStackId,
    nodeKey,
    normalizeLayout,
    columnLayout,
    orderedTileIds,
    hasTile,
    findStack,
    parentOfTile,
    tilePath,
    layoutKey,
    layoutsEqual,
    appendTile,
    removeTile,
    moveTile,
    insertTile,
    withStackFlexes,
    adjustFlexes,
    sanitizeLayout
  } = tree

  const { box, createDropSnapshot, hitTestDrop, EDGE_STRIP_PX, DEAD_RADIUS_PX } = zones

  ok(TILE_GAP === 8 && TILE_MIN_PX === 120, '常量与面板默认间距、最小宽度一致')

  const lonelyStack = tileStack('row', [])
  ok(nodeKey(tileLeaf('x')) === 'x' && nodeKey(lonelyStack) === lonelyStack.id, 'nodeKey 取卡片 id 或栈 id')
  ok(nextStackId() !== nextStackId(), 'nextStackId 每次给出新 id')

  const withoutEmpty = normalizeLayout({ root: tileStack('column', [tileLeaf('a'), tileStack('row', []), tileLeaf('b')]) })
  ok(orderedTileIds(withoutEmpty).join() === 'a,b' && withoutEmpty.root.children.length === 2, '规范化删除空栈')

  const merged = normalizeLayout({
    root: tileStack('column', [tileLeaf('a'), tileStack('column', [tileLeaf('b'), tileLeaf('c')])])
  })
  ok(
    merged.root.children.length === 3 && orderedTileIds(merged).join() === 'a,b,c' && merged.root.children.every((child) => child.kind === 'tile'),
    '同向子栈并入父栈'
  )

  const sole = normalizeLayout({ root: tileStack('column', [tileLeaf('a')], 5) })
  ok(sole.root.children.length === 1 && sole.root.children[0].flex === 5, '单子栈把 flex 交给子节点并消失')

  const column = columnLayout(['a', 'b', 'c'])
  ok(column.root.direction === 'column' && orderedTileIds(column).join() === 'a,b,c', 'columnLayout 竖排一列')
  ok(column.root.children.every((child) => child.flex === 1), 'columnLayout 每张卡 flex 均等')
  ok(columnLayout([]).root.direction === 'column' && columnLayout([]).root.children.length === 0, '空数组得到空根列')
  ok(orderedTileIds(columnLayout(['a'])).join() === 'a' && columnLayout(['a']).root.children.length === 1, '单卡仍保留根列')

  const base = columnLayout(['a', 'b', 'c'])
  const rootId = base.root.id
  ok(hasTile(base, 'b') && !hasTile(base, 'zz'), 'hasTile 判断卡片是否在树里')
  ok(findStack(base, rootId) !== null && findStack(base, 'nope') === null, 'findStack 按栈 id 查找')
  ok(parentOfTile(base, 'b') !== null && parentOfTile(base, 'b').id === rootId, 'parentOfTile 给出所在栈')
  ok(tilePath(base, 'c').join() === '2' && tilePath(base, 'zz') === null, 'tilePath 给出索引路径或 null')

  ok(orderedTileIds(moveTile(base, 'a', { kind: 'insert', stackId: rootId, index: 2 })).join() === 'b,c,a', '同栈重排按去掉自身后的位置')
  ok(orderedTileIds(moveTile(base, 'b', { kind: 'insert', stackId: rootId, index: 1 })).join() === 'a,b,c', '同栈重排到原位置不变')

  const nested = normalizeLayout({
    root: tileStack('column', [tileStack('row', [tileLeaf('a'), tileLeaf('b')]), tileLeaf('c')])
  })
  const rowId = nested.root.children[0].id
  ok(nested.root.children[0].kind === 'stack' && parentOfTile(nested, 'a').id === rowId, '构造出嵌套的行栈')
  ok(tilePath(nested, 'b').join() === '0,1', '嵌套里的卡片给出完整索引路径')
  ok(orderedTileIds(moveTile(nested, 'a', { kind: 'insert', stackId: nested.root.id, index: 1 })).join() === 'b,a,c', '跨栈 insert 插到目标位置')

  ok(
    orderedTileIds(moveTile(base, 'a', { kind: 'split', stackId: rootId, direction: 'column', index: 2 })).join() === 'b,a,c',
    'split 同向等于 insert 并扣掉源位置'
  )
  const pairBase = columnLayout(['a', 'b'])
  const splitAcross = moveTile(pairBase, 'a', { kind: 'split', stackId: pairBase.root.id, direction: 'row', index: 1 })
  ok(orderedTileIds(splitAcross).join() === 'b,a' && splitAcross.root.direction === 'row', 'split 异向把整栈与新卡包成新栈')
  const splitFront = moveTile(pairBase, 'a', { kind: 'split', stackId: pairBase.root.id, direction: 'row', index: 0 })
  ok(orderedTileIds(splitFront).join() === 'a,b' && splitFront.root.direction === 'row', 'split 异向 index 0 把新卡放在前面')

  const wrapBase = normalizeLayout({
    root: tileStack('column', [tileStack('row', [tileLeaf('a'), tileLeaf('b')]), tileLeaf('c')])
  })
  const wrapped = moveTile(wrapBase, 'c', { kind: 'wrap', tileId: 'a', direction: 'column', index: 1 })
  ok(orderedTileIds(wrapped).join() === 'a,c,b', 'wrap 把目标卡与新卡包成新栈')
  ok(wrapped.root.children[0].kind === 'stack' && wrapped.root.children[0].direction === 'column', 'wrap 结果里目标卡与新卡组成列')

  const removed = removeTile(columnLayout(['a', 'b']), 'a')
  ok(orderedTileIds(removed).join() === 'b' && removed.root.children.length === 1, 'remove 后规范化到单卡')
  ok(orderedTileIds(removeTile(columnLayout(['a']), 'a')).length === 0, 'remove 最后一张卡得到空根')
  ok(removeTile(base, 'zz') === base, 'remove 目标不存在时返回原 layout')

  ok(orderedTileIds(appendTile(columnLayout(['a']), 'b')).join() === 'a,b', 'append 追加到根列')
  const appendedRow = appendTile(normalizeLayout({ root: tileStack('row', [tileLeaf('a'), tileLeaf('b')]) }), 'c')
  ok(appendedRow.root.direction === 'column' && orderedTileIds(appendedRow).join() === 'a,b,c', '根是行时先包成列再追加')
  ok(orderedTileIds(appendTile(columnLayout([]), 'a')).join() === 'a', '空根列追加第一张卡')

  const insertBase = columnLayout(['a'])
  ok(orderedTileIds(insertTile(insertBase, 'b', { kind: 'insert', stackId: insertBase.root.id, index: 0 })).join() === 'b,a', 'insertTile 插到指定位置')
  ok(insertTile(insertBase, 'a', { kind: 'insert', stackId: insertBase.root.id, index: 0 }) === insertBase, '已在树里的卡片不再 insert')
  ok(moveTile(base, 'a', { kind: 'insert', stackId: 'missing-stack', index: 1 }) === base, '目标栈不存在时返回原 layout')

  const flexed = withStackFlexes(base, rootId, [3, 1, 1])
  ok(flexed.root.children.map((child) => child.flex).join() === '3,1,1', 'withStackFlexes 按子节点顺序改比例')
  ok(withStackFlexes(base, 'missing-stack', [9]).root.children.map((child) => child.flex).join() === '1,1,1', '栈不存在时比例不变')

  ok(adjustFlexes([1, 1], 0, 100, 100, 120).join() === '1,1', 'adjustFlexes 触到最小值时不动')
  const stretched = adjustFlexes([2, 2], 0, 100, 100, 120)
  ok(Math.abs(stretched[0] - 2.8) < 1e-9 && Math.abs(stretched[1] - 1.2) < 1e-9, 'adjustFlexes 按像素换算并守住最小值')
  ok(adjustFlexes([2, 2], 1, 50, 100, 120).join() === '2,2', 'adjustFlexes 没有下一个邻居时不动')
  ok(adjustFlexes([1, 1], 0, 100, 0, 120).join() === '1,1', 'adjustFlexes 除数为零时不动')

  const persisted = {
    root: {
      kind: 'stack',
      id: 's1',
      direction: 'column',
      flex: 3,
      children: [
        { kind: 'tile', tileId: 'a', flex: 2 },
        { kind: 'tile', tileId: 'a', flex: 1 },
        { kind: 'tile', tileId: 'blocked', flex: 1 },
        { kind: 'tile', tileId: 'b', flex: 'x' },
        { kind: 'stack', direction: 'row', flex: 0, children: [{ kind: 'tile', tileId: 'c' }] }
      ]
    }
  }
  const cleaned = sanitizeLayout(persisted, new Set(['a', 'b', 'c']))
  ok(cleaned !== null && orderedTileIds(cleaned).join() === 'a,b,c', 'sanitize 去重并过滤不允许的 id')
  ok(cleaned.root.children.find((child) => child.kind === 'tile' && child.tileId === 'b').flex === 1, 'sanitize 把非法 flex 变为 1')
  ok(sanitizeLayout({ root: { kind: 'stack', direction: 'row', children: [] } }) === null, '没有卡片时 sanitize 返回 null')
  ok(sanitizeLayout(null) === null && sanitizeLayout({ root: { kind: 'tile', tileId: 3 } }) === null, '非法输入返回 null')
  ok(sanitizeLayout({ root: { kind: 'stack', direction: 'diagonal', children: [tileLeaf('a')] } }) === null, '方向非法时返回 null')

  const rebuilt = { root: tileStack('column', [tileLeaf('a', 4), tileLeaf('b', 7)], 3, 'other-id') }
  ok(rebuilt.root.id !== column.root.id && layoutKey(rebuilt) === layoutKey(columnLayout(['a', 'b'])), 'layoutKey 与栈 id、flex 无关')
  ok(layoutsEqual(columnLayout(['a', 'b']), rebuilt) === false, 'layoutsEqual 默认比较 flex')
  ok(layoutsEqual(columnLayout(['a', 'b']), rebuilt, false) === true, 'layoutsEqual 可忽略 flex')

  ok(EDGE_STRIP_PX === 24 && DEAD_RADIUS_PX === 16, '拖放常量与约定一致')
  ok(box(10, 20, 30, 40).right === 40 && box(10, 20, 30, 40).bottom === 60, 'box 由左上宽高算出右、下边')

  const container = box(100, 50, 400, 600)
  const at = (left, top, width, height) => box(left + container.left, top + container.top, width, height)

  const twoCards = columnLayout(['a', 'b'])
  const twoRootId = twoCards.root.id
  const measureTwo = (key) => {
    if (key === twoRootId) return at(0, 0, 400, 600)
    if (key === 'a') return at(0, 0, 400, 296)
    if (key === 'b') return at(0, 304, 400, 296)
    return null
  }
  const twoSnapshot = createDropSnapshot({
    layout: twoCards,
    containerRect: container,
    measure: measureTwo,
    sourceTileId: 'a',
    startPointer: { x: 300, y: 150 },
    gap: TILE_GAP
  })
  ok(twoSnapshot !== null, '两卡竖排能建立快照')
  ok(twoSnapshot.startPointer.x === 200 && twoSnapshot.startPointer.y === 100, '起点坐标转成容器内坐标')
  ok(twoSnapshot.nodeRects.b.left === 0 && twoSnapshot.nodeRects.b.top === 304, '量到的矩形转成容器内坐标')
  ok(twoSnapshot.zones.some((zone) => zone.kind === 'rearrange' && zone.stackId === twoRootId), '源栈保留实时重排区')
  ok(
    twoSnapshot.zones.some(
      (zone) => zone.kind === 'target' && zone.target.kind === 'split' && zone.target.stackId === twoRootId && zone.target.index === 0
    ),
    '容器左侧给出根 split index 0'
  )
  ok(
    twoSnapshot.zones.some((zone) => zone.kind === 'target' && zone.ownStrip === true),
    '被拖卡片自身的边条标了 ownStrip'
  )
  ok(
    twoSnapshot.zones.every((zone) => zone.kind === 'rearrange' || (zone.target !== undefined && zone.target !== null)),
    '每个可放区域都带落点目标'
  )
  ok(
    createDropSnapshot({ layout: twoCards, containerRect: container, measure: () => null, sourceTileId: 'a', gap: TILE_GAP }) === null,
    '量不到源卡时快照为 null'
  )

  const deadHit = hitTestDrop(twoCards, twoSnapshot, 'a', { x: 300, y: 160 })
  ok(deadHit.liveLayout === null && deadHit.pendingLayout === null && deadHit.target === null, '死区内没有落点')
  const insideHit = hitTestDrop(twoCards, twoSnapshot, 'a', { x: 300, y: 250 })
  ok(insideHit.liveLayout === null && insideHit.pendingLayout === null, '未越过兄弟中点且仍在自身卡片内时为空')
  const downHit = hitTestDrop(twoCards, twoSnapshot, 'a', { x: 300, y: 550 })
  ok(downHit.liveLayout !== null && orderedTileIds(downHit.liveLayout).join() === 'b,a', '向下越过中点得到交换后的实时布局')
  ok(downHit.pendingLayout === null && downHit.target === null, '实时重排时不挂待定落点')

  const rightHit = hitTestDrop(twoCards, twoSnapshot, 'a', { x: 480, y: 450 })
  ok(rightHit.liveLayout === null && rightHit.pendingLayout !== null, '拖到另一卡右侧边条得到待定布局')
  ok(
    rightHit.target !== null && rightHit.target.kind === 'split' && rightHit.target.direction === 'row' && rightHit.target.index === 1,
    '两卡时边条变成对父栈的 split'
  )
  ok(rightHit.pendingLayout.root.direction === 'row' && orderedTileIds(rightHit.pendingLayout).join() === 'b,a', 'split 把整栈与新卡包成新行')

  const leftHit = hitTestDrop(twoCards, twoSnapshot, 'a', { x: 40, y: 300 })
  ok(
    leftHit.target !== null && leftHit.target.kind === 'split' && leftHit.target.stackId === twoRootId && leftHit.target.index === 0,
    '拖到容器左边外得到根 split index 0'
  )
  ok(leftHit.pendingLayout !== null && leftHit.pendingLayout.root.direction === 'row', '根 split 产生新的行根')
  ok(leftHit.liveLayout === null, '根边带不触发实时重排')

  const threeCards = columnLayout(['a', 'b', 'c'])
  const threeRootId = threeCards.root.id
  const measureThree = (key) => {
    if (key === threeRootId) return at(0, 0, 400, 600)
    if (key === 'a') return at(0, 0, 400, 192)
    if (key === 'b') return at(0, 200, 400, 192)
    if (key === 'c') return at(0, 400, 400, 192)
    return null
  }
  const threeSnapshot = createDropSnapshot({
    layout: threeCards,
    containerRect: container,
    measure: measureThree,
    sourceTileId: 'a',
    startPointer: { x: 300, y: 60 },
    gap: TILE_GAP
  })
  const wrapHit = hitTestDrop(threeCards, threeSnapshot, 'a', { x: 480, y: 350 })
  ok(
    wrapHit.target !== null && wrapHit.target.kind === 'wrap' && wrapHit.target.tileId === 'b' && wrapHit.target.index === 1,
    '三卡时边条变成对目标卡的 wrap'
  )
  ok(wrapHit.pendingLayout !== null && orderedTileIds(wrapHit.pendingLayout).join() === 'b,a,c', 'wrap 结果把源卡包进目标卡')

  const insertSnapshot = createDropSnapshot({
    layout: twoCards,
    containerRect: container,
    measure: measureTwo,
    sourceTileId: 'new',
    gap: TILE_GAP
  })
  ok(insertSnapshot !== null && insertSnapshot.startPointer === null, '树外卡片也能建立快照且没有起点')
  const insertHit = hitTestDrop(twoCards, insertSnapshot, 'new', { x: 480, y: 450 })
  ok(
    insertHit.target !== null && insertHit.target.kind === 'wrap' && insertHit.target.tileId === 'b' && insertHit.target.index === 1,
    '树外卡片落在边条上得到 wrap'
  )
  ok(insertHit.pendingLayout !== null && orderedTileIds(insertHit.pendingLayout).join() === 'a,b,new', 'wrap 把新卡包在目标卡之后')
}
