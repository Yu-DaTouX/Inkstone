import './lib/test-isolate.mjs'
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

await runSuite(import.meta.url, async (ok, compile) => {
  const mod = await compile(undefined, {
    stdin: {
      contents: [
        "export * from './src/main/mcp/connection-manager';",
        "export * from './src/main/mcp/app-host';",
        "export * from './src/main/mcp/app-proxy-service';",
        "export { listMcpServiceSettings } from './src/main/mcp/service-settings';"
      ].join(''),
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', 'electron']
  })
  const root = await mkdtemp(join(tmpdir(), 'yan-mcp-tools-changed-'))
  const fixture = resolve('scripts/fixtures/mcp-list-changed-server.mjs')
  const waitFor = async (condition, label) => {
    for (let index = 0; index < 100 && !condition(); index++) await delay(50)
    ok(condition(), label)
  }

  const stdioConfig = (id, extra = {}) => ({ id, transport: 'stdio', command: process.execPath, args: [fixture], ...extra })

  {
    const manager = new mod.McpConnectionManager([stdioConfig('fx')])
    try {
      const seen = []
      const off = manager.onToolsListChanged((serverId) => seen.push(serverId))
      const first = await manager.listToolsCached('fx')
      ok(first.map((entry) => entry.name).join() === 'note,grow', '连接管理器：初始工具表是 note,grow')
      ok(manager.toolCountOf('fx') === 2, '连接管理器：连接对象记着当前工具数')
      await manager.callTool('fx', 'grow', {})
      await waitFor(() => seen.length === 1, '连接管理器：收到服务发来的 tools/list_changed 并通知订阅者')
      ok(seen[0] === 'fx', '连接管理器：通知里带服务 id')
      ok(manager.toolCountOf('fx') === null, '连接管理器：收到变化后丢掉旧的工具数')
      const second = await manager.listToolsCached('fx')
      ok(second.length === 3 && second.some((entry) => entry.name === 'late1'), '连接管理器：工具缓存随通知失效，下次读到新工具表')
      off()
      await manager.callTool('fx', 'grow', {})
      await delay(300)
      ok(seen.length === 1, '连接管理器：取消订阅后不再通知')
      ok((await manager.listToolsCached('fx')).length === 4, '连接管理器：没有订阅者时缓存照样失效')

      const survivor = []
      manager.onToolsListChanged(() => { throw new Error('listener boom') })
      manager.onToolsListChanged((serverId) => survivor.push(serverId))
      await manager.callTool('fx', 'grow', {})
      await waitFor(() => survivor.length === 1, '连接管理器：某个订阅者抛错不影响其他订阅者')
    } finally {
      await manager.close()
    }
  }

  {
    const manager = new mod.McpConnectionManager([
      stdioConfig('pagination', { args: [fixture, '--changes-during-pagination'] }),
      stdioConfig('cursor', { args: [fixture, '--invalidated-cursor'] }),
      stdioConfig('storm', { args: [fixture, '--changes-on-every-list'] })
    ])
    try {
      const notifications = []
      manager.onToolsListChanged((id) => notifications.push(id))
      const tools = await manager.listToolsCached('pagination')
      ok(tools.map((tool) => tool.name).join() === 'new-head,new-tail', '分页中收到变更时丢弃旧页，从第一页读取新清单')
      ok((await manager.listToolsCached('pagination')) === tools && manager.toolCountOf('pagination') === 2, '只缓存完整的新版本清单和工具数')
      const retried = await manager.listToolsRaw('cursor')
      ok(retried.map((tool) => tool.name).join() === 'new-head,new-tail', '服务拒绝已失效游标时也会从第一页重读')
      const stable = await manager.listToolsRaw('storm').then(() => true, () => false)
      ok(!stable && notifications.filter((id) => id === 'storm').length === 3 && manager.toolCountOf('storm') === null, '持续变化最多读取三次，不返回也不缓存旧清单')
    } finally {
      await manager.close()
    }
  }

  {
    const configFile = join(root, 'servers.json')
    await mkdir(root, { recursive: true })
    await writeFile(configFile, JSON.stringify({ servers: [stdioConfig('fx', { ownedBy: 'inkstone', appHost: { at: 'fixture', natives: [] } })] }))
    class Permissive extends mod.McpAppOwnershipGuard {
      async check() { return { ok: true } }
    }
    const env = { YAN_MCP_SERVERS_FILE: configFile }
    const host = new mod.McpAppHost({ env, ownership: new Permissive({}), timeoutMs: 20_000 })
    const proxy = new mod.McpAppProxyService({ env, host, dir: join(root, 'proxy') })
    try {
      const hostSeen = []
      host.onToolsChanged((serverId) => hostSeen.push(serverId))
      const first = await proxy.ensureFresh({})
      ok(first.refreshed && proxy.registrableTools().map((tool) => tool.toolName).join() === 'note,grow', '托管快照：首次按需刷新写出工具')
      ok(!proxy.needsRefreshFor() && !proxy.snapshotStatus().needsRefresh && proxy.toolsChangedServers().length === 0, '托管快照：刚刷新完不过期')

      await host.callToolWithMeta('fx', 'grow', {})
      await waitFor(() => hostSeen.length === 1, '托管快照：宿主收到托管服务的 tools/list_changed')
      ok(proxy.toolsChangedServers().join() === 'fx', '托管快照：变化的服务被标出来')
      ok(proxy.needsRefreshFor(), '托管快照：收到变化后判定过期，ensureFresh 能识别')
      const status = proxy.snapshotStatus()
      ok(status.needsRefresh && !status.stale, '托管快照：设置页的「需要刷新」成立，但不会让现有快照路径被撤掉')
      ok(proxy.registrableTools().length === 2, '托管快照：标记过期不改动现有快照，运行中的会话不受打断')

      const settings = await mod.listMcpServiceSettings({
        agentDir: join(root, 'agent'), hostFile: configFile, context: 'c', project: null, projectTrusted: false, projects: [], busy: false, nativeConfigChanged: null,
        managedToolsChanged: () => proxy.toolsChangedServers().concat('ghost')
      })
      ok(settings.managedToolsChanged?.join() === 'fx', '设置页快照：列出有变化的托管服务，不认识的名字被滤掉')
      const quiet = await mod.listMcpServiceSettings({
        agentDir: join(root, 'agent'), hostFile: configFile, context: 'c', project: null, projectTrusted: false, projects: [], busy: false, nativeConfigChanged: null,
        managedToolsChanged: () => []
      })
      ok(!('managedToolsChanged' in quiet), '设置页快照：没有变化时不带这个字段')

      const refreshed = await proxy.ensureFresh({})
      ok(refreshed.refreshed && proxy.registrableTools().map((tool) => tool.toolName).includes('late1'), '托管快照：下一个 runner 启动前的 ensureFresh 刷新出新工具')
      ok(!proxy.needsRefreshFor() && proxy.toolsChangedServers().length === 0 && !proxy.snapshotStatus().needsRefresh, '托管快照：刷新成功后清掉变化标记')

      const { default: extension } = await import('../resources/pi-extensions/mcp-app-proxy.js')
      const registered = new Map()
      const hooks = new Map()
      const regName = (toolName) => `mcp__fx__${toolName}`
      let active = [regName('note'), 'read']
      const savedFile = process.env.YAN_MCP_APP_TOOLS
      process.env.YAN_MCP_APP_TOOLS = join(root, 'proxy', 'not-yet-created.json')
      extension({
        registerTool: (definition) => registered.set(definition.name, definition),
        on: (name, handler) => hooks.set(name, handler)
      })
      ok(registered.size === 0, '热更新：快照还未写入时扩展仍能启动')
      const delayedFile = process.env.YAN_MCP_APP_TOOLS
      const stopDelayed = hooks.get('session_shutdown')
      try {
        await writeFile(delayedFile, JSON.stringify(proxy.readSnapshot()))
        await waitFor(() => registered.has(regName('late1')), '热更新：启动后首次出现快照也会注册工具')
      } finally {
        stopDelayed()
      }

      process.env.YAN_MCP_APP_TOOLS = proxy.snapshotPath()
      extension({
        registerTool: (definition) => registered.set(definition.name, definition),
        on: (name, handler) => hooks.set(name, handler),
        getActiveTools: () => active,
        setActiveTools: (names) => { active = names }
      })
      const off = host.onToolsChanged((serverId, projectId) => { void proxy.refreshChanged(serverId, projectId) })
      try {
        await host.callToolWithMeta('fx', 'grow', {})
        await waitFor(() => registered.has(regName('late2')), '热更新：同一已启动会话不重连、不发新消息，自动注册新增工具')
        await host.callToolWithMeta('fx', 'grow', {})
        await waitFor(() => registered.get(regName('note'))?.exposure === 'hidden' && registered.has(regName('late3')), '热更新：自动隐藏删除的工具并注册新增工具')
        ok(active.join() === 'read', '热更新：撤下已激活的旧工具，不影响其他工具')
        ok(registered.get(regName('grow'))?.parameters.properties.updated?.type === 'boolean', '热更新：已注册工具的 schema 随快照替换')
        ok((await registered.get(regName('note')).execute()).isError, '热更新：移除后的工具不可调用')
        ok((await host.callToolWithMeta('fx', 'late3', {})).text === 'note', '热更新：新增工具使用原连接可调用')
        const path = proxy.snapshotPath()
        const saved = await readFile(path, 'utf8')
        active = [regName('late3'), 'read']
        await rename(path, `${path}.previous`)
        await waitFor(() => registered.get(regName('late3'))?.exposure === 'hidden' && active.join() === 'read', '热更新：文件监听发现快照消失后撤下原工具和激活项')
        await writeFile(path, saved)
        hooks.get('tool_call')({ toolName: 'tool_search' })
        ok(registered.get(regName('late3'))?.exposure === 'deferred', '热更新：字节完全相同的快照重建后也会恢复工具')
      } finally {
        off()
        hooks.get('session_shutdown')()
        if (savedFile === undefined) delete process.env.YAN_MCP_APP_TOOLS
        else process.env.YAN_MCP_APP_TOOLS = savedFile
      }

      await writeFile(configFile, JSON.stringify({ servers: [] }))
      await host.callToolWithMeta('fx', 'grow', {}).catch(() => undefined)
      await host.reconcile('fx')
      ok(host.toolsChangedVersions().size === 0, '托管宿主：服务不再托管后丢掉变化标记')
    } finally {
      await host.close()
      await proxy.close()
    }
  }

  {
    const server = new Server({ name: 'list-changed-http', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
    let initializations = 0
    let listings = 0
    let toolName = 'before'
    let events
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `fixture-${++initializations}`,
      enableJsonResponse: true
    })
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      listings++
      return { tools: [{ name: toolName, inputSchema: { type: 'object' } }] }
    })
    await server.connect(transport)
    const http = createServer((req, res) => {
      if (req.method === 'GET') events = res
      void transport.handleRequest(req, res).catch((error) => res.destroy(error))
    })
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const configFile = join(root, 'http-servers.json')
    const config = { id: 'http', transport: 'http', url: `http://127.0.0.1:${http.address().port}/mcp`, ownedBy: 'inkstone', appHost: { at: 'fixture', natives: [] } }
    const env = { YAN_MCP_SERVERS_FILE: configFile }
    await writeFile(configFile, JSON.stringify({ servers: [config] }))
    const host = new mod.McpAppHost({ env, ownership: { agentDir: root, holdersFor: async () => [] } })
    const proxy = new mod.McpAppProxyService({ env, host, dir: join(root, 'http-proxy') })
    const off = host.onToolsChanged((serverId, projectId) => { void proxy.refreshChanged(serverId, projectId) })
    try {
      const first = await proxy.refresh()
      ok(first.ok && first.tools[0]?.toolName === 'before', 'HTTP 托管服务可通过原连接读取初始清单')
      await waitFor(() => events?.headersSent && events.statusCode === 200, 'HTTP 客户端建立了接收服务主动通知的 SSE 流')
      toolName = 'after'
      await server.sendToolListChanged()
      await waitFor(() => proxy.registrableTools().some((tool) => tool.toolName === 'after'), 'HTTP 服务可主动通知空闲客户端刷新工具清单')
      ok(initializations === 1 && listings === 2 && proxy.registrableTools().length === 1, 'HTTP 刷新只重列一次，复用既有会话，并移除旧工具')
    } finally {
      off()
      await host.close()
      await proxy.close()
      await server.close()
      http.closeAllConnections()
      await new Promise((resolve) => http.close(resolve))
    }
  }

  {
    const versions = new Map()
    let version = 0
    let listings = 0
    const acknowledged = []
    const fakeHost = {
      listManagedServers: () => [{ id: 'alpha', transport: 'stdio', command: 'x', enabled: true, ownedBy: 'inkstone', appHost: {} }],
      listToolsWithMeta: async () => {
        listings++
        versions.set('alpha', ++version)
        return [{ name: 'tool', modelVisible: true, appVisible: false, visibility: ['model'], resourceUri: null }]
      },
      callToolWithMeta: async () => { throw new Error('unused') },
      statusOf: () => ({ status: 'ready' }),
      toolsChangedVersions: () => versions,
      acknowledgeToolsChanged: (serverId, seen) => { acknowledged.push([serverId, seen]); if (versions.get(serverId) === seen) versions.delete(serverId) }
    }
    const proxy = new mod.McpAppProxyService({ env: {}, host: fakeHost, dir: join(root, 'race') })
    versions.set('alpha', ++version)
    await proxy.refresh({ allowEmpty: true })
    ok(versions.has('alpha') && acknowledged[0][1] < version, '托管快照：刷新期间又收到变化时标记保留，下次仍会刷新')
    ok(proxy.needsRefreshFor(), '托管快照：保留的标记让下一次判定仍为过期')
    let next = true
    fakeHost.listToolsWithMeta = async () => {
      listings++
      if (next) versions.set('alpha', ++version)
      next = false
      return []
    }
    const pending = proxy.refreshChanged('alpha')
    ok(proxy.refreshChanged('alpha') === pending, '托管快照：同一服务的重复通知合并')
    await pending
    ok(listings === 3 && !versions.has('alpha'), '托管快照：刷新中收到新通知会再读一次，写出空列表并清除标记')
    fakeHost.listToolsWithMeta = async () => {
      listings++
      if (listings < 6) versions.set('alpha', ++version)
      throw new Error('unstable listing')
    }
    versions.set('alpha', ++version)
    const failed = await proxy.refreshChanged('alpha').then(() => '', (error) => error.message)
    ok(failed === 'unstable listing' && listings === 4 && versions.has('alpha'), '托管快照：读取失败保留待刷新标记，但不追着同一轮的变更无限重试')
  }

  {
    const configFile = join(root, 'project-overrides.json')
    const only = stdioConfig('only', { ownedBy: 'inkstone', appHost: { at: 'fixture', natives: [] }, enabled: false, projectEnabled: { a: true } })
    const global = stdioConfig('global', { ownedBy: 'inkstone', appHost: { at: 'fixture', natives: [] } })
    await writeFile(configFile, JSON.stringify({ servers: [only, global] }))
    const env = { YAN_MCP_SERVERS_FILE: configFile }
    const versions = new Map()
    let release
    let reached
    const gate = new Promise((resolve) => { release = resolve })
    const started = new Promise((resolve) => { reached = resolve })
    let onlyLists = 0
    let globalLists = 0
    const fakeHost = {
      listManagedServers: (projectId) => [...(projectId === 'a' ? [{ ...only, enabled: true }] : []), ...(projectId === 'a' && global.projectEnabled?.a === false ? [] : [global])],
      listToolsWithMeta: async (id) => {
        const count = id === 'only' ? ++onlyLists : ++globalLists
        if (id === 'only' && count === 2) {
          reached()
          await gate
        }
        return [{ name: `${id}-${count}`, modelVisible: true }]
      },
      statusOf: () => ({ status: 'ready' }),
      toolsChangedVersions: () => versions,
      acknowledgeToolsChanged: (id, seen) => { if (versions.get(id) === seen) versions.delete(id) }
    }
    const proxy = new mod.McpAppProxyService({ env, host: fakeHost, dir: join(root, 'overrides') })
    await proxy.refresh({ callerProjectId: 'a' })
    const older = proxy.refresh({ callerProjectId: 'a' })
    await started
    versions.set('only', 1)
    await proxy.refreshChanged('only', 'a')
    ok(proxy.registrableTools().some((tool) => tool.toolName === 'global-1') && globalLists === 1, '目标刷新：保留其他服务工具且不重查其他连接')
    release()
    await older
    ok(proxy.registrableTools().some((tool) => tool.toolName === 'only-3' && tool.enabled === false && tool.projectEnabled?.a === true), '目标刷新：旧请求不能覆盖较新的工具列表，也不能放宽启用范围')
    global.projectEnabled = { a: false }
    await writeFile(configFile, JSON.stringify({ servers: [only, global] }))
    await proxy.refresh({ callerProjectId: 'a' })
    ok(proxy.registrableTools().some((tool) => tool.serverId === 'global' && tool.projectEnabled?.a === false), '全量刷新：保留其他项目在用的工具，并同步更新项目开关')
  }
})
