import './lib/test-isolate.mjs'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const root = await mkdtemp(join(tmpdir(), 'yan-mcp-fresh-'))
  try {
    const proxy = await compile(undefined, {
      stdin: { contents: "export * from './src/main/mcp/app-proxy-service';", resolveDir: process.cwd(), loader: 'ts' },
      external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', 'electron']
    })
    const server = (id, projectScope) => ({ id, transport: 'stdio', command: 'x', enabled: true, ownedBy: 'inkstone', appHost: {}, ...(projectScope ? { projectScope } : {}) })
    const tool = (name) => ({ name, modelVisible: true, appVisible: false, visibility: ['model'], resourceUri: null })
    let managed = []
    let listCalls = 0
    let listBehavior = async (serverId) => [tool(`${serverId}-tool`)]
    const host = {
      listManagedServers: (projectId) => managed.filter((entry) => !entry.projectScope || entry.projectScope === projectId),
      listToolsWithMeta: async (serverId) => { listCalls++; return listBehavior(serverId) },
      callToolWithMeta: async () => { throw new Error('unused') },
      statusOf: () => ({ status: 'ready' })
    }
    const make = (name, options = {}) => new proxy.McpAppProxyService({ env: {}, dir: join(root, name), host, ...options })

    {
      const service = make('none')
      const result = await service.ensureFresh({ callerProjectId: 'p1' })
      ok(result.refreshed === false && listCalls === 0, '没有托管服务也没有快照：不刷新，不拉起任何服务')
    }

    {
      managed = [server('alpha')]
      listCalls = 0
      const service = make('missing')
      const [first, second] = await Promise.all([service.ensureFresh({ callerProjectId: 'p1' }), service.ensureFresh({ callerProjectId: 'p1' })])
      ok(first.refreshed && second.refreshed && listCalls === 1, '快照缺失：先刷新；并发的两个 runner 共用同一次刷新', String(listCalls))
      const snapshot = JSON.parse(await readFile(service.snapshotPath(), 'utf8'))
      ok(snapshot.tools.length === 1 && snapshot.tools[0].serverId === 'alpha', '快照缺失：刷新后写出了托管工具')
      const again = await service.ensureFresh({ callerProjectId: 'p1' })
      ok(again.refreshed === false && listCalls === 1, '快照新鲜：不重复刷新')

      managed = [server('alpha'), server('beta')]
      const added = await service.ensureFresh({ callerProjectId: 'p1' })
      ok(added.refreshed && listCalls === 3 && service.readSnapshot().tools.length === 2, '新增托管服务后快照过期：下一个 runner 启动前先刷新')

      managed = [server('beta')]
      const removed = await service.ensureFresh({ callerProjectId: 'p1' })
      ok(removed.refreshed && service.readSnapshot().tools.map((entry) => entry.serverId).join() === 'beta', '托管服务被删除后快照过期：刷新并去掉残留工具')

      managed = [server('beta'), server('scoped', 'other-project')]
      listCalls = 0
      const foreign = await service.ensureFresh({ callerProjectId: 'p1' })
      ok(foreign.refreshed === false && listCalls === 0, '其他项目的托管服务不触发本项目的刷新')
    }

    {
      managed = [server('alpha')]
      const service = make('aged', { snapshotMaxAgeMs: 30 })
      await service.ensureFresh({ callerProjectId: 'p1' })
      listCalls = 0
      await new Promise((resolve) => setTimeout(resolve, 80))
      const aged = await service.ensureFresh({ callerProjectId: 'p1' })
      ok(aged.refreshed && listCalls === 1, '快照超过最大年龄：刷新')
    }

    {
      managed = [server('alpha')]
      listCalls = 0
      listBehavior = async () => { throw new Error('connect failed') }
      const service = make('failing')
      const failed = await service.ensureFresh({ callerProjectId: 'p1' })
      ok(failed.error && /connect failed/.test(failed.error), '刷新失败：返回错误但不抛出，runner 照常启动', failed.error)
      const throttled = await service.ensureFresh({ callerProjectId: 'p1' })
      ok(throttled.refreshed === false && throttled.error === 'recent-failure' && listCalls === 1, '刚失败过：一分钟内不再重复拉起服务')
      const retried = await service.ensureFresh({ callerProjectId: 'p1', retryAfterFailureMs: 0 })
      ok(listCalls === 2 && retried.error !== 'recent-failure', '超过重试间隔后再次尝试')
    }

    {
      managed = [server('alpha')]
      let release
      listBehavior = () => new Promise((resolve) => { release = () => resolve([tool('late')]) })
      const service = make('slow')
      const started = Date.now()
      const result = await service.ensureFresh({ callerProjectId: 'p1', waitMs: 60 })
      ok(result.error === 'timeout' && Date.now() - started < 10_000, '刷新太慢：最多等待上限就放行 runner，刷新继续在后台')
      release()
      for (const end = Date.now() + 15_000; Date.now() < end && service.readSnapshot()?.tools.some((entry) => entry.toolName === 'late') !== true;) await new Promise((resolve) => setTimeout(resolve, 5))
      ok(service.readSnapshot()?.tools.some((entry) => entry.toolName === 'late') === true, '后台刷新完成后快照照常写出')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
