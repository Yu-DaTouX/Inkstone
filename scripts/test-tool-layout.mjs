/** 可移动工具磁贴布局契约（实施-12 U-0）的纯函数测试。 */
export async function runToolLayoutTests(ok) {
  const {
    avoidFloatObstacle,
    clampFloatPixels,
    clampRectToBounds,
    commitTileLayout,
    defaultToolLayout,
    isStaleLayoutWrite,
    isTileFloatable,
    migrateToolLayout,
    moveTile,
    moveTileToIndex,
    normalizeToolLayout,
    pxRectToNormalized,
    setTileCollapsed,
    setTilePlacement,
    snapFloatRect,
    SNAP_THRESHOLD
  } = await import('../out/test/tool-layout.mjs')

  console.log('\n--- U-0 工具磁贴布局契约 ---')
  const IDS = ['todo', 'context', 'files', 'quota', 'queue', 'ext', 'log', 'actions']

  const base = defaultToolLayout(IDS)
  ok(base.version === 2 && base.tiles.length === IDS.length, '默认布局含全部已知分区')
  ok(base.tiles.every((t) => t.placement === 'docked'), '默认全部停靠')

  /* 旧字段迁移：顺序保留、隐藏项迁到停靠（工具库已撤下）、未知丢弃、重复归一 */
  const migrated = migrateToolLayout(['quota', 'context', 'quota', 'ghost'], ['log', 'nope'], IDS)
  ok(migrated.tiles.find((t) => t.id === 'quota')?.order === 0, '旧顺序原样保留')
  ok(migrated.tiles.filter((t) => t.id === 'quota').length === 1, '重复 id 只留一份')
  ok(!migrated.tiles.some((t) => t.id === 'ghost'), '未知 id 丢弃')
  ok(migrated.tiles.find((t) => t.id === 'log')?.placement === 'docked', '隐藏项迁到停靠（实施-20 U5）')
  ok(migrated.tiles.every((t) => t.placement === 'docked'), '迁移后不再产生库位')

  /* 版本未知 → 默认；归一化去重/过滤 */
  const future = normalizeToolLayout({ version: 99, tiles: [{ id: 'todo', placement: 'floating' }] }, IDS)
  ok(future.tiles.length === IDS.length && future.tiles.every((t) => t.placement === 'docked'), '未知版本回默认布局')
  const dup = normalizeToolLayout(
    { version: 2, tiles: [{ id: 'todo' }, { id: 'todo' }, { id: 'ghost' }, { id: 'context', placement: 'library' }] },
    IDS
  )
  ok(dup.tiles.filter((t) => t.id === 'todo').length === 1, '归一化去重')
  ok(!dup.tiles.some((t) => t.id === 'ghost'), '归一化丢未知')
  ok(dup.tiles.find((t) => t.id === 'context')?.placement === 'docked', '旧库位读盘时迁到停靠（实施-20 U5）')

  /* 浮动的无效坐标不进入布局，退成停靠（恢复可见，不丢到屏外） */
  const badFloat = normalizeToolLayout({ version: 2, tiles: [{ id: 'queue', placement: 'floating', rect: { x: 5, y: -2, w: 0, h: 0.3 } }] }, IDS)
  ok(badFloat.tiles.find((t) => t.id === 'queue')?.placement === 'docked', '无效浮动坐标退成停靠')

  const floated = setTilePlacement(base, 'queue', 'floating', { x: 0.8, y: 0.8, w: 0.3, h: 0.3 })
  const q = floated.tiles.find((t) => t.id === 'queue')
  ok(q?.placement === 'floating' && q.rect && q.rect.x <= 0.7 && q.rect.y <= 0.7, '浮动 rect 夹到可用区内')
  ok(floated.revision === base.revision + 1, '改动自增 revision')
  ok(setTilePlacement(base, 'queue', 'floating').tiles.find((t) => t.id === 'queue')?.placement === 'docked', '浮动缺 rect 退停靠')

  const moved = moveTile(base, 'queue', 'todo', false)
  ok(moved.tiles.find((t) => t.id === 'queue')?.order === 0, '移到 target 之前')
  const movedAfter = moveTile(base, 'todo', 'context', true)
  ok(movedAfter.tiles.find((t) => t.id === 'todo')?.order === 1, '移到 target 之后')
  ok(moveTile(base, 'todo', 'ghost', false) === base, 'target 不存在时不动')

  const clamped = clampRectToBounds({ x: 0.95, y: 0.95, w: 0.4, h: 0.4 })
  ok(clamped.x === 0.6 && clamped.y === 0.6, '越界 rect 夹回（缩窗不丢磁贴）')

  ok(isStaleLayoutWrite(1, 2) && !isStaleLayoutWrite(2, 2) && !isStaleLayoutWrite(3, 2), '慢请求的迟到写入被判定过时')

  /* ── U-4 / U-5：浮动磁贴的放置、折叠、写入仲裁与像素几何 ── */
  console.log('--- U-4/U-5 磁贴放置与几何 ---')
  /* NON_FLOATING_TILE_IDS 现为空：每个磁贴都能拖成浮窗。
     保留 isTileFloatable 这层，是为了将来要收紧时只改一份名单。 */
  ok(isTileFloatable('queue') && isTileFloatable('todo') && isTileFloatable('files'), '所有磁贴都可浮动')
  const forced = setTilePlacement(base, 'todo', 'floating', { x: 0.1, y: 0.1, w: 0.3, h: 0.3 })
  ok(forced.tiles.find((t) => t.id === 'todo')?.placement === 'floating', '要求浮动时真的浮动')
  const forcedNorm = normalizeToolLayout({ version: 2, tiles: [{ id: 'files', placement: 'floating', rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } }] }, IDS)
  ok(forcedNorm.tiles.find((t) => t.id === 'files')?.placement === 'floating', '存量布局里的 floating 保持浮动')

  const folded = setTileCollapsed(floated, 'queue', true)
  ok(folded.tiles.find((t) => t.id === 'queue')?.collapsed === true, '折叠偏好进布局')
  ok(setTileCollapsed(folded, 'queue', false).tiles.find((t) => t.id === 'queue')?.collapsed !== true, '展开会清掉折叠标记')

  const reindexed = moveTileToIndex(base, 'actions', 0)
  ok(reindexed.tiles.find((t) => t.id === 'actions')?.order === 0, '按停靠位次放置到首位')
  ok(moveTileToIndex(base, 'ghost', 0) === base, '未知 id 的位次放置不动')

  const older = { ...base, revision: 3 }
  ok(commitTileLayout(older, { ...base, revision: 4 }).applied, '更大的 revision 才落地')
  ok(!commitTileLayout(older, { ...base, revision: 3 }).applied, '相同 revision 幂等丢弃')
  ok(!commitTileLayout(older, { ...base, revision: 1 }).applied, '迟到的旧 revision 被丢弃')

  const area = { left: 100, top: 50, width: 800, height: 600 }
  const clampPx = clampFloatPixels({ left: 950, top: 700, width: 300, height: 240 }, area)
  ok(clampPx.left === 600 && clampPx.top === 410, '像素夹取：缩窗后磁贴完整留在可用区')
  const obstacle = { left: 620, top: 50, width: 280, height: 600 }
  const avoided = avoidFloatObstacle({ left: 640, top: 200, width: 300, height: 240 }, area, obstacle)
  ok(!!avoided && avoided.left + avoided.width <= obstacle.left, '与网页矩形相交时吸附到其左侧可用区')
  ok(avoidFloatObstacle({ left: 620, top: 50, width: 900, height: 600 }, area, obstacle) === null, '无处可放时返回 null（调用方退回工具页）')
  const roundtrip = pxRectToNormalized({ left: 180, top: 110, width: 320, height: 240 }, area)
  ok(
    Math.abs(roundtrip.x - 0.1) < 1e-6 && Math.abs(roundtrip.w - 0.4) < 1e-6,
    '像素 → 归一化往返一致（保存后可复原）'
  )

  /*
   * 吸附对齐（用户 2026-09-25：「工具拖入到消息窗口后 也应该有吸附对齐功能
   * 这样好整理 并且对于后续开发可以预留标准」）。
   * area 沿用上面那一个：left 100 / top 50 / 800×600 → 右缘 900、下缘 650。
   */
  const mk = (left, top, width = 300, height = 240) => ({ left, top, width, height })

  /* ① 容器边：左/上都在阈值内就吸上去 */
  const nearLeft = snapFloatRect(mk(106, 56), area)
  ok(nearLeft.rect.left === 100 && nearLeft.rect.top === 50, '靠近容器左上角 → 吸到 (100,50)')
  ok(nearLeft.guides.length === 2, '两个轴各自给一条参考线')
  ok(nearLeft.guides.every((g) => g.kind === 'area'), '参考线标出吸的是容器边')

  /* ② 阈值外不动 —— 吸附不能变成「到处乱吸」 */
  const farLeft = snapFloatRect(mk(100 + SNAP_THRESHOLD + 2, 50 + SNAP_THRESHOLD + 2), area)
  ok(farLeft.rect.left === 100 + SNAP_THRESHOLD + 2 && farLeft.guides.length === 0, '超出阈值不吸')

  /* ③ 容器右/下边：用矩形的右/下边去贴（不是左边） */
  const nearRight = snapFloatRect(mk(900 - 300 - 4, 650 - 240 - 4), area)
  ok(nearRight.rect.left === 600 && nearRight.rect.top === 410, '靠近容器右下角 → 右/下边贴边')

  /* ④ 中线：矩形中心对容器中心 */
  const centered = snapFloatRect(mk(area.left + 400 - 150 + 3, area.top + 300 - 120 + 3), area)
  ok(centered.rect.left === 350, '靠近水平中线 → 中心对齐（left 350）')
  ok(centered.guides.some((g) => g.kind === 'center'), '参考线标出吸的是中线')

  /* ⑤ 其他磁贴：四条边 × 自己两条边都算目标 */
  const other = mk(500, 200)
  const besideTile = snapFloatRect(mk(500 + 300 + 5, 900), area, [other])
  ok(besideTile.rect.left === 800, '我的左缘贴到其他磁贴右缘（相接摆放）')
  ok(besideTile.guides.some((g) => g.kind === 'tile'), '参考线标出吸的是另一个磁贴')
  ok(snapFloatRect(mk(500 + 4, 900), area, [other]).rect.left === 500, '左对左（笔直对齐）')
  ok(
    snapFloatRect(mk(200 + 5, 900), area, [other]).rect.left === 200,
    '我的右缘贴到其他磁贴左缘（反向相接）'
  )
  const sameTop = snapFloatRect(mk(60, 200 + 6), area, [other])
  ok(sameTop.rect.top === 200, '上边对齐其他磁贴的上边')

  /* ⑥ 只吸最近的一条，不做连锁 */
  const twoCands = snapFloatRect(mk(100 + 6, 50 + 6), area, [mk(109 + 0, 0, 300, 240)])
  ok(twoCands.rect.left === 109, '两个候选都近时选更近的那条（109 而不是 100）')

  /* ⑦ 吸附是移动，不是缩放 */
  const sizeKept = snapFloatRect(mk(103, 53, 123, 45), area)
  ok(sizeKept.rect.width === 123 && sizeKept.rect.height === 45, '吸附只改 left/top，尺寸不变')
}
