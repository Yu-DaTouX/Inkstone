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
      const versions = new Map()
      const service = make('changed-during-failure', {
        host: {
          ...host,
          toolsChangedVersions: () => versions,
          acknowledgeToolsChanged: (id, version) => { if (versions.get(id) === version) versions.delete(id) }
        }
      })
      let enter
      const entered = new Promise((resolve) => { enter = resolve })
      let failOld
      listBehavior = () => new Promise((_, reject) => { failOld = reject; enter() })
      versions.set('alpha', 1)
      const first = service.refreshChanged('alpha', 'p1')
      await entered
      versions.set('alpha', 2)
      const second = service.refreshChanged('alpha', 'p1')
      ok(first === second, '刷新中收到新通知时共用同一个任务')
      listBehavior = async () => [tool('new-version')]
      failOld(new Error('old connection closed'))
      const error = await first.then(() => null, (reason) => reason.message)
      ok(error === null && service.readSnapshot()?.tools[0]?.toolName === 'new-version' && versions.size === 0, '旧刷新失败后仍应用刷新途中抵达的新版本', error)

      versions.set('alpha', 3)
      let failures = 0
      listBehavior = async () => {
        failures++
        versions.set('alpha', versions.get('alpha') + 1)
        void service.refreshChanged('alpha', 'p1')
        throw new Error('still failing')
      }
      const failed = await service.refreshChanged('alpha', 'p1').then(() => null, (reason) => reason.message)
      ok(failed === 'still failing' && failures === 2 && versions.has('alpha'), '持续失败只为更新的通知补试一次，仍保留待刷新标记', failures)
      ok(service.readSnapshot()?.tools[0]?.toolName === 'new-version', '补试也失败时保留上一份有效快照')
    }

    {
      managed = [server('alpha'), server('beta')]
      listBehavior = async (id) => [tool(`${id}-original`)]
      const service = make('cancelled')
      await service.refresh()
      const before = await readFile(service.snapshotPath(), 'utf8')
      const abort = new AbortController()
      listCalls = 0
      listBehavior = async () => { abort.abort(); throw abort.signal.reason }
      const cancelled = await service.refresh({ signal: abort.signal }).then(() => null, (error) => error)
      ok(cancelled === abort.signal.reason && listCalls === 1, '取消刷新时结束请求，不继续查询下一个服务')
      ok(await readFile(service.snapshotPath(), 'utf8') === before, '取消刷新不改动已发布的快照')
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
