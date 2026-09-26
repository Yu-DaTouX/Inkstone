/**
 * 会话地图纯逻辑（`src/shared/session-map.ts`，实施-18 S1）的单测。
 *
 * 为什么值得单测：地图的规模护栏、孤儿 / 环防御、跨项目泳道与折叠
 * 都直接在数据层决定「画得出画不出」。渲染层没法替它兜底 ——
 * 一个死循环或丢节点在界面上看不出来，只会表现成「地图打不开」。
 */

export function runSessionMapTests(ok, mod) {
  const { buildSessionMap, buildBranchIndex, SESSION_MAP_MAX_NODES } = mod

  const mk = (over = {}) => ({
    id: over.path ?? 'id',
    path: over.path ?? 'p',
    cwd: over.cwd ?? 'C:/proj',
    title: over.title ?? over.path ?? 't',
    named: false,
    createdAt: 1000,
    updatedAt: 1000,
    messageCount: 1,
    ...over
  })

  /* ---- 0 个会话 ---- */
  {
    const r = buildSessionMap({ sessions: [] })
    ok(
      r.nodes.length === 0 && r.lanes.length === 0 && r.edges.length === 0 && r.stats.total === 0,
      '空会话：无节点、无泳道、无错误'
    )
  }

  /* ---- 单根 ---- */
  {
    const r = buildSessionMap({ sessions: [mk({ path: 'a' })] })
    ok(
      r.nodes.length === 1 && r.nodes[0].depth === 0 && r.nodes[0].laneKey === 'global',
      '单会话：根节点、全局泳道、深度 0'
    )
  }

  /* ---- 一父两子：深度、边、分支编号、子计数 ---- */
  {
    const sessions = [
      mk({ path: 'root', createdAt: 1 }),
      mk({ path: 'c1', parentSession: 'root', createdAt: 10 }),
      mk({ path: 'c2', parentSession: 'root', createdAt: 20 })
    ]
    const r = buildSessionMap({ sessions })
    const root = r.nodes.find((n) => n.path === 'root')
    const c1 = r.nodes.find((n) => n.path === 'c1')
    const c2 = r.nodes.find((n) => n.path === 'c2')
    ok(c1 && c1.depth === 1 && c1.parentPath === 'root', '子节点深度为 1 且挂到父')
    ok(c1.branchIndex === 1 && c2.branchIndex === 2, '分支编号按 createdAt 升序', `${c1.branchIndex}/${c2.branchIndex}`)
    ok(root.childCount === 2, '父节点记录全部直接子会话数', String(root.childCount))
    ok(r.edges.length === 2 && r.edges.every((e) => e.from === 'root'), '边只连接可见父子', String(r.edges.length))
  }

  /* ---- 跨项目泳道 + 当前项目优先 ---- */
  {
    const sessions = [
      mk({ path: 'a', projectId: 'A', lastActivityAt: 5 }),
      mk({ path: 'b', projectId: 'B', lastActivityAt: 9000 }),
      mk({ path: 'x', lastActivityAt: 5000 })
    ]
    const r = buildSessionMap({ sessions, currentProjectId: 'A' })
    ok(r.lanes[0].key === 'project:A', '当前项目泳道排在最前', r.lanes.map((l) => l.key).join(','))
    ok(r.lanes.some((l) => l.key === 'project:B') && r.lanes.some((l) => l.key === 'global'), '项目与未归类各成泳道')
    ok(r.stats.laneCount === 3, '泳道数正确', String(r.stats.laneCount))

    const r2 = buildSessionMap({ sessions, currentProjectId: 'B' })
    ok(r2.lanes[0].key === 'project:B', '换当前项目后排序随之改变', r2.lanes.map((l) => l.key).join(','))
  }

  /* ---- 缺父：提升为根并标记 orphan ---- */
  {
    const r = buildSessionMap({ sessions: [mk({ path: 'x', parentSession: 'missing' })] })
    const x = r.nodes[0]
    ok(x.orphan === true && x.depth === 0 && x.parentPath === undefined, '父会话缺失时提升为根并标记 orphan')
  }

  /* ---- 环 / 自引用：不递归死循环 ---- */
  {
    const r = buildSessionMap({
      sessions: [
        mk({ path: 'a', parentSession: 'b' }),
        mk({ path: 'b', parentSession: 'a' })
      ]
    })
    ok(r.nodes.length === 2, '互相引用的两个会话都保留（不丢节点）')
    ok(r.nodes.every((n) => n.depth === 0 && n.truncated === true), '环被识别为截断，深度归 0')

    const self = buildSessionMap({ sessions: [mk({ path: 's', parentSession: 's' })] })
    ok(self.nodes.length === 1 && self.nodes[0].truncated === true, '自引用按截断防御，不死循环')
  }

  /* ---- 超阈值折叠 + 每泳道至少保留一个 ---- */
  {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      mk({ path: `n${i}`, projectId: i % 2 === 0 ? 'A' : 'B', lastActivityAt: i * 100 })
    )
    const r = buildSessionMap({ sessions, maxNodes: 2 })
    ok(r.stats.shown <= 2, '超阈值时限量直出', `shown=${r.stats.shown}`)
    ok(r.stats.folded === sessions.length - r.stats.shown, '折叠数 = 总数 - 可见数')
    ok(
      r.clusters.reduce((n, c) => n + c.count, 0) === r.stats.folded,
      '折叠簇计数之和等于被折叠节点数'
    )
    ok(r.lanes.length === 2, '两个泳道各留了至少一个节点（泳道不因折叠消失）', String(r.lanes.length))
    ok(r.stats.total === 10, 'total 始终是输入总量', String(r.stats.total))
  }

  /* ---- 折叠后子节点提升：可见父没了也不能丢 ---- */
  {
    const r = buildSessionMap({
      sessions: [
        mk({ path: 'parent', lastActivityAt: 1, createdAt: 1 }),
        mk({ path: 'child', parentSession: 'parent', lastActivityAt: 100, createdAt: 2 })
      ],
      maxNodes: 1
    })
    const child = r.nodes.find((n) => n.path === 'child')
    ok(child && child.parentPath === undefined && child.truncated === true, '可见父被折叠时子节点提升为顶层并标记截断')
    ok(r.edges.length === 0, '两端不都可见时不留悬空边')
  }

  /* ---- 时间缺失回退到 createdAt ---- */
  {
    const r = buildSessionMap({
      sessions: [mk({ path: 'old', createdAt: 100 }), mk({ path: 'new', createdAt: 900 })]
    })
    ok(r.lanes[0].nodes[0].path === 'new', '没有 lastActivityAt 时按 createdAt 排序', r.lanes[0].nodes.map((n) => n.path).join(','))
  }

  /* ---- 分支编号下沉函数 ---- */
  {
    const idx = buildBranchIndex([
      mk({ path: 'root', createdAt: 1 }),
      mk({ path: 'b', parentSession: 'root', createdAt: 30 }),
      mk({ path: 'a', parentSession: 'root', createdAt: 10 })
    ])
    ok(idx.branchIndex.get('a') === 1 && idx.branchIndex.get('b') === 2, 'buildBranchIndex 按 createdAt 编号')
    ok(idx.branchCount.get('root') === 2, 'buildBranchIndex 统计子数')
    ok(idx.branchesOf.get('root').length === 2, 'buildBranchIndex 保留子列表')
  }

  /* ---- 阈值常量本身 ---- */
  ok(SESSION_MAP_MAX_NODES === 300, '规模护栏常量是 300', String(SESSION_MAP_MAX_NODES))
}
