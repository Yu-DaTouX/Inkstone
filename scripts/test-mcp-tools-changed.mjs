import './lib/test-isolate.mjs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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
    const versions = new Map()
    let version = 0
    const acknowledged = []
    const fakeHost = {
      listManagedServers: () => [{ id: 'alpha', transport: 'stdio', command: 'x', enabled: true, ownedBy: 'inkstone', appHost: {} }],
      listToolsWithMeta: async () => {
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
  }
})
