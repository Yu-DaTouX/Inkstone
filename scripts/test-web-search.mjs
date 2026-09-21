/**
 * 「兼容搜索能力」判定（`src/shared/web-search.ts`，实施-07 S4）的单测。
 *
 * 为什么值得单测：这一片的出口是**有则出现、无则隐藏**。判松了入口会在没有
 * 搜索服务的机器上出现（用户点下去只能得到一个空头承诺），判紧了这个功能
 * 永远不可达。两条都不需要真实 MCP 服务就能钉住 —— 判定是纯函数。
 *
 * 最要紧的一条边界：**内置的 `knowledge.search` 不算**。它是项目知识检索，
 * 一旦被算进来，入口会在每台装了砚的机器上都出现。
 */

export function runWebSearchTests(ok, mod) {
  const { isWebSearchCapability, pickWebSearchCapability, webSearchAvailability } = mod

  const capability = (over = {}) => ({
    id: over.id ?? 'mcp:fixture:echo',
    kind: over.kind ?? 'mcp-tool',
    title: over.title ?? 'fixture · echo',
    description: over.description ?? '把 text 原样回显。',
    source: { owner: over.owner ?? 'user', location: over.location ?? 'yan mcp describe --server fixture --tool echo' },
    availability: over.availability ?? 'ready',
    effect: over.effect ?? 'read',
    ...(over.projectScope ? { projectScope: over.projectScope } : {})
  })

  /* ---- 1. 名字里带搜索语义的外部能力 ---- */
  ok(
    isWebSearchCapability(capability({ id: 'mcp:web:web_search', title: 'web · web_search' })),
    'MCP 工具 `web_search` 命中'
  )
  ok(
    isWebSearchCapability(
      capability({
        id: 'mcp:brave:search',
        title: 'brave · search',
        description: 'Search the web with Brave.'
      })
    ),
    '服务名 + search（brave · search）命中'
  )
  ok(
    isWebSearchCapability(
      capability({ id: 'skill:web-search', kind: 'skill', title: 'web-search', description: '联网搜索一个主题。' })
    ),
    '技能名 `web-search` 命中'
  )
  ok(
    isWebSearchCapability(capability({ id: 'mcp:tavily:tavily_search', title: 'tavily · tavily_search' })),
    '`tavily_search` 命中'
  )

  /* ---- 2. 不能误报 ---- */
  ok(
    !isWebSearchCapability(
      capability({ id: 'builtin:knowledge.search', kind: 'builtin', title: '项目知识检索', description: '在本项目已确认的知识里检索' })
    ),
    '**内置的 knowledge.search 不算**（它是项目知识检索，不是搜网页）'
  )
  ok(
    !isWebSearchCapability(capability({ id: 'mcp:fixture:compute', title: 'fixture · compute', description: '精确计算两个整数的和或积。' })),
    '无关工具不命中'
  )
  ok(
    !isWebSearchCapability(
      capability({ id: 'mcp:local:index', title: 'local · index', description: 'Search the local symbol index. No network.' })
    ),
    '描述里只提到 search（没有网页/联网语义）不算'
  )
  ok(
    !isWebSearchCapability(capability({ id: 'mcp:x:google_maps', title: 'x · google_maps', description: '查地点。' })),
    '只有服务名（google）没有 search 不算'
  )

  /* ---- 3. 描述同时提搜索与网页 = 弱证据成立 ---- */
  ok(
    isWebSearchCapability(
      capability({
        id: 'mcp:custom:lookup',
        title: 'custom · lookup',
        description: '在网页上检索一个关键词并返回网页结果。'
      })
    ),
    '描述里同时有「检索 + 网页」时命中'
  )

  /* ---- 4. 挑选优先级：ready 优先、MCP 工具优先 ---- */
  const picked = pickWebSearchCapability([
    capability({ id: 'skill:web-search', kind: 'skill', title: 'web-search', availability: 'disconnected' }),
    capability({ id: 'mcp:web:web_search', title: 'web · web_search', availability: 'ready' })
  ])
  ok(picked?.id === 'mcp:web:web_search', '优先挑 ready 的 MCP 工具', String(picked?.id))

  ok(pickWebSearchCapability([]) === undefined, '空目录返回 undefined（入口隐藏）')
  ok(
    pickWebSearchCapability([
      capability({ id: 'builtin:knowledge.search', kind: 'builtin', title: '项目知识检索' }),
      capability({ id: 'mcp:fixture:echo', title: 'fixture · echo' })
    ]) === undefined,
    '只有内置/无关能力时也没有可挑的（入口隐藏）'
  )

  /* ---- 5. 给界面的快照 ---- */
  const snapshot = webSearchAvailability([capability({ id: 'mcp:web:web_search', title: 'web · web_search' })])
  ok(snapshot.available === true, '命中时 available=true')
  ok(snapshot.title === 'web · web_search', '带上标题（界面要显示「用 X 搜索」）', String(snapshot.title))
  ok(snapshot.location?.includes('mcp describe'), '带上可执行的调用形状', String(snapshot.location))
  ok(snapshot.owner === 'mcp', '来源标为 mcp', String(snapshot.owner))

  const empty = webSearchAvailability([])
  ok(empty.available === false && empty.title === undefined, '未命中时只有 available=false')
}
