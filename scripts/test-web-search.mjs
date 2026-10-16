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

  const snapshot = webSearchAvailability([capability({ id: 'mcp:web:web_search', title: 'web · web_search' })])
  ok(snapshot.available === true, '命中时 available=true')
  ok(snapshot.title === 'web · web_search', '带上标题（界面要显示「用 X 搜索」）', String(snapshot.title))
  ok(snapshot.location?.includes('mcp describe'), '带上可执行的调用形状', String(snapshot.location))
  ok(snapshot.owner === 'mcp', '来源标为 mcp', String(snapshot.owner))

  const empty = webSearchAvailability([])
  ok(empty.available === false && empty.title === undefined, '未命中时只有 available=false')
}
