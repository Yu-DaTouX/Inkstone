import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const VALID = /^[A-Za-z0-9_-]{1,64}$/

const CASES = [
  ['app-stdio', 'read_only_note'],
  ['docs', 'files.read'],
  ['my server', 'search/web'],
  ['中文服务', '查找文件'],
  ['very-long-server-name-for-testing', 'a_tool_name_that_goes_on_and_on_beyond_limits_one'],
  ['very-long-server-name-for-testing', 'a_tool_name_that_goes_on_and_on_beyond_limits_two']
]

await runSuite(import.meta.url, async (ok, compile) => {
  const root = await mkdtemp(join(tmpdir(), 'yan-mcp-tool-names-'))
  const savedTools = process.env.YAN_MCP_APP_TOOLS
  const savedProject = process.env.YAN_MCP_APP_PROJECT_ID
  try {
    const extension = await import('../resources/pi-extensions/mcp-app-proxy.js')
    const snapshot = join(root, 'tools.json')
    await writeFile(snapshot, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), source: 'x', tools: CASES.map(([serverId, toolName]) => ({ serverId, toolName })), servers: [], excluded: [] }), 'utf8')
    process.env.YAN_MCP_APP_TOOLS = snapshot
    delete process.env.YAN_MCP_APP_PROJECT_ID
    const registered = new Map()
    extension.default({ registerTool: (definition) => registered.set(definition.label, definition.name), on: () => {} })
    ok(registered.size === CASES.length, '扩展：含非法字符或超长的工具名也都注册', [...registered.values()].join(','))
    const extNames = CASES.map(([serverId, toolName]) => registered.get(`${serverId}/${toolName}`))
    const invalid = extNames.filter((name) => !VALID.test(name ?? ''))
    ok(invalid.length === 0, '扩展：注册名只含 [A-Za-z0-9_-] 且不超过 64 字符', invalid.join(' | '))
    ok(extNames.every((name) => name?.startsWith('mcp__')), '扩展：注册名保留 mcp__ 前缀，审批照常识别')
    ok(new Set(extNames).size === extNames.length, '扩展：截断后的长名仍互不相同', extNames.join(','))
    ok(extNames[0] === 'mcp__app_stdio__read_only_note', '扩展：合法短名不变', extNames[0])
    ok(extNames[1] === 'mcp__docs__files_read', '扩展：非法字符换成 _', extNames[1])

    const clashSnapshot = join(root, 'clash.json')
    await writeFile(clashSnapshot, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), source: 'x', tools: [
      { serverId: 's-1', toolName: 'x' }, { serverId: 's_1', toolName: 'x' }, { serverId: 'other', toolName: 'keep' }, { serverId: 's-1', toolName: 'only' }
    ], servers: [], excluded: [] }), 'utf8')
    process.env.YAN_MCP_APP_TOOLS = clashSnapshot
    const clashRegistered = []
    const reports = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk, ...rest) => { reports.push(String(chunk)); return true }
    try {
      extension.default({ registerTool: (definition) => clashRegistered.push(definition.label), on: () => {} })
    } finally {
      process.stderr.write = realWrite
    }
    ok(clashRegistered.sort().join() === ['other/keep', 's-1/only'].join(), '扩展：撞名时只跳过冲突的工具，其余照常注册', clashRegistered.join())
    ok(reports.some((line) => line.includes('mcp__s_1__x') && line.includes('s-1/x') && line.includes('s_1/x')), '扩展：撞名被报告并列出双方', reports.join(''))
    process.env.YAN_MCP_APP_TOOLS = snapshot

    const proxy = await compile(undefined, {
      stdin: { contents: "export * from './src/main/mcp/app-proxy-service';", resolveDir: process.cwd(), loader: 'ts' },
      external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', 'electron']
    })
    const servers = [...new Set(CASES.map(([serverId]) => serverId))]
    const host = {
      listManagedServers: () => servers.map((id) => ({ id, transport: 'stdio', command: 'x', enabled: true, ownedBy: 'inkstone' })),
      listToolsWithMeta: async (serverId) => CASES.filter(([id]) => id === serverId).map(([, name]) => ({ name, modelVisible: true, appVisible: false, visibility: ['model'], resourceUri: null })),
      callToolWithMeta: async () => { throw new Error('unused') },
      statusOf: () => ({ status: 'ready' })
    }
    const service = new proxy.McpAppProxyService({ env: { ...process.env, YAN_MCP_SERVERS_FILE: join(root, 'mcp-servers.json'), YAN_DATA_DIR: root }, dir: join(root, 'mcp-app'), host })
    const result = await service.refresh()
    ok(result.ok && result.collisions.length === 0, '宿主快照：刷新成功、无碰撞', JSON.stringify(result.collisions))
    const hostNames = CASES.map(([serverId, toolName]) => result.tools.find((tool) => tool.serverId === serverId && tool.toolName === toolName)?.name)
    ok(hostNames.every((name) => VALID.test(name ?? '')), '宿主快照：名字同样合法', hostNames.join(' | '))
    ok(hostNames.every((name, index) => name === extNames[index]), '宿主快照与扩展算出的名字一致', `${hostNames.join(',')} ≠ ${extNames.join(',')}`)
  } finally {
    if (savedTools === undefined) delete process.env.YAN_MCP_APP_TOOLS
    else process.env.YAN_MCP_APP_TOOLS = savedTools
    if (savedProject !== undefined) process.env.YAN_MCP_APP_PROJECT_ID = savedProject
    await rm(root, { recursive: true, force: true })
  }
})
