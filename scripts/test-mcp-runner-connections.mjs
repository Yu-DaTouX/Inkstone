#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const dataDir = await mkdtemp(join(tmpdir(), 'inkstone-mcp-runner-connections-'))
process.env.YAN_DATA_DIR = dataDir

try {
  await runSuite(import.meta.url, async (ok, compile) => {
    const { RunnerMcpConnections } = await compile('src/main/mcp/runner-connections.ts', { packages: 'external' })

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    const gate = () => {
      let open
      const promise = new Promise((resolve) => { open = resolve })
      return { promise, open }
    }
    const fakeManager = (configs) => {
      const manager = {
        configs: [...configs],
        releases: new Map(),
        closed: 0,
        disconnected: [],
        list: () => manager.configs,
        listServerIds: () => manager.configs.map((config) => config.id),
        statusOf: (id) => ({ status: manager.configs.some((config) => config.id === id) ? 'ready' : 'error' }),
        toolCountOf: (id) => (id === 'legacy' ? 2 : null),
        listToolsCached: async () => [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
        disconnect: async (id) => { manager.disconnected.push(id); manager.configs = manager.configs.filter((config) => config.id !== id); return true },
        syncOptions: [],
        idleWaiters: [],
        clearIdleWaiters: () => { manager.idleWaiters = [] },
        syncServers: (next, options) => {
          manager.syncOptions.push(options)
          const wanted = new Set(next.map((config) => config.id))
          const released = manager.configs.filter((config) => !wanted.has(config.id))
          manager.configs = [...next]
          return released.map((config) => ({ serverId: config.id, release: manager.releases.get(config.id)?.promise ?? Promise.resolve({ confirmed: true, unknown: 0 }) }))
        },
        close: async () => { manager.closed += 1 },
        closeConfirmed: async () => ({ confirmed: true, unknown: 0 })
      }
      return manager
    }
    const managedConfig = (id, extra = {}) => ({ id, transport: 'http', url: 'https://managed.example/mcp', ownedBy: 'inkstone', appHost: { at: '2026-11-01T00:00:00.000Z', natives: [] }, ...extra })
    const harness = (options = {}) => {
      const env = {
        servers: options.servers ?? [{ id: 'legacy', transport: 'stdio', command: 'node' }],
        error: options.error,
        projectId: options.projectId,
        created: [],
        hostCalls: []
      }
      const host = {
        statusOf: (id) => ({ status: id === 'managed' ? 'ready' : 'disconnected' }),
        toolCountOf: () => 4,
        reconcile: async (id) => { env.hostCalls.push(['reconcile', id]) },
        listToolsWithMeta: async (id) => { env.hostCalls.push(['list', id]); return [{ name: 'one' }] },
        disconnect: async (id) => { env.hostCalls.push(['disconnect', id]); return true }
      }
      const connections = new RunnerMcpConnections({
        projectId: () => env.projectId,
        loadServers: () => ({ servers: env.servers, ...(env.error ? { error: env.error } : {}) }),
        createManager: (configs) => {
          const manager = fakeManager(configs)
          env.created.push(manager)
          return manager
        },
        host: () => host
      })
      return { connections, env }
    }

    {
      const { connections, env } = harness({
        servers: [
          { id: 'legacy', transport: 'stdio', command: 'node' },
          { id: 'other-project', transport: 'stdio', command: 'node', projectScope: 'p2' },
          managedConfig('managed')
        ],
        error: 'broken entry',
        projectId: 'p1'
      })
      ok(connections.current() === undefined && connections.configError() === undefined, '未取用前不创建连接管理器')
      const manager = connections.connectionManager()
      ok(env.created.length === 1 && JSON.stringify(manager.listServerIds()) === JSON.stringify(['legacy']), '只把本项目可见、非砚托管的服务交给旧连接管理器')
      ok(connections.configError() === 'broken entry', '记录最近一次读配置的错误')
      env.error = undefined
      ok(connections.connectionManager() === manager && env.created.length === 1, '再次取用时复用同一个管理器')
      ok(connections.configError() === undefined, '配置恢复后清掉错误')
    }

    {
      const { connections, env } = harness({ servers: [{ id: 'legacy', transport: 'stdio', command: 'node' }, { id: 'gone', transport: 'stdio', command: 'node' }] })
      const manager = connections.connectionManager()
      const release = gate()
      manager.releases.set('gone', release)
      env.servers = [{ id: 'legacy', transport: 'stdio', command: 'node' }]
      connections.connectionManager()
      const snapshot = connections.holderSnapshot().services
      ok(snapshot.some((service) => service.serverId === 'gone' && service.status === 'connecting'), '移除的服务在关闭确认前仍算旧持有者')
      release.open({ confirmed: true, unknown: 0 })
      await settle()
      ok(!connections.holderSnapshot().services.some((service) => service.serverId === 'gone'), '关闭确认后不再算旧持有者')
    }

    {
      const { connections, env } = harness({ servers: [{ id: 'managed', transport: 'stdio', command: 'node' }] })
      const manager = connections.connectionManager()
      const release = gate()
      manager.releases.set('managed', release)
      env.servers = [managedConfig('managed')]
      connections.connectionManager()
      release.open({ confirmed: false, unknown: 1 })
      let failure
      try {
        await connections.verify('managed')
      } catch (error) {
        failure = error
      }
      ok(failure?.code === 'legacy-holder-unresolved', '旧连接关闭未确认时拒绝交给砚宿主', String(failure?.code))
      ok(env.hostCalls.length === 0, '未确认释放前不触碰砚宿主')
    }

    {
      const { connections, env } = harness({ servers: [managedConfig('managed')] })
      const verified = await connections.verify('managed')
      ok(verified.status === 'ready' && verified.toolCount === 1, '托管服务走砚宿主检查')
      ok(env.hostCalls.some(([call, id]) => call === 'reconcile' && id === 'managed'), '托管检查先让宿主对齐配置')
      ok(await connections.disconnect('managed') === true && env.hostCalls.at(-1)?.[0] === 'disconnect', '托管服务断开交给砚宿主')
    }

    {
      const { connections } = harness()
      const verified = await connections.verify('legacy')
      ok(verified.status === 'ready' && verified.toolCount === 3, '旧服务检查刷新工具清单')
      let failure
      try {
        await connections.verify('missing')
      } catch (error) {
        failure = error
      }
      ok(failure instanceof Error && !failure.code, '当前 runner 没有的服务直接报错')
      ok(await connections.disconnect('legacy') === true && connections.current().disconnected.includes('legacy'), '旧服务断开交给旧连接管理器')
    }

    {
      const { connections } = harness({
        servers: [
          { id: 'legacy', title: 'Legacy', transport: 'http', url: 'https://legacy.example:8443/mcp', effect: 'read' },
          managedConfig('managed', { title: 'Managed', projectScope: 'p1' })
        ],
        projectId: 'p1'
      })
      const servers = await connections.settingsServers()
      const legacy = servers.find((server) => server.id === 'legacy')
      const managed = servers.find((server) => server.id === 'managed')
      ok(legacy?.ownedBy === 'pi' && legacy.endpointOrigin === 'https://legacy.example:8443' && legacy.toolCount === 2 && legacy.effect === 'read', '设置页列出旧服务并只给出端点来源')
      ok(managed?.ownedBy === 'inkstone' && managed.status === 'ready' && managed.toolCount === 4 && managed.projectScoped === true, '设置页列出托管服务的宿主事实')
    }

    {
      const { connections } = harness()
      const manager = connections.connectionManager()
      const closing = gate()
      manager.close = () => closing.promise
      const closed = connections.close()
      ok(connections.current() === undefined, 'close 立即放下当前管理器')
      let settled = false
      void closed.then(() => { settled = true })
      await settle()
      ok(!settled, 'close 等待旧管理器关闭')
      closing.open()
      await closed
      ok(settled, '旧管理器关闭后 close 完成')
      const next = connections.connectionManager()
      ok(next !== manager, '关闭后再取用会新建管理器')
      await connections.closeCurrent()
      ok(connections.current() === undefined && next.closed === 1, 'closeCurrent 关闭并放下当前管理器')
    }

    {
      const { connections, env } = harness({ servers: [{ id: 'legacy', transport: 'stdio', command: 'node' }, { id: 'windows-mcp', transport: 'stdio', command: 'uvx', args: ['a'] }] })
      ok((await connections.syncChanged()) === 'none', '没有管理器时同步什么也不做')
      const manager = connections.connectionManager()
      manager.busy = false
      manager.idleWaiters = []
      manager.isBusy = () => manager.busy
      manager.onceIdle = (callback) => { if (!manager.busy) callback(); else manager.idleWaiters.push(callback) }
      const syncs = []
      const baseSync = manager.syncServers
      manager.syncServers = (next) => { syncs.push(next.map((config) => config.id)); return baseSync(next) }
      env.servers = [{ id: 'legacy', transport: 'stdio', command: 'node' }]
      ok((await connections.syncChanged()) === 'synced' && syncs.length === 1 && manager.closed === 0 && env.created.length === 1, '空闲时只做差量同步，不关闭整个管理器也不新建')
      ok(manager.configs.map((config) => config.id).join() === 'legacy', '同步后管理器只剩配置里的服务')

      env.servers = [{ id: 'legacy', transport: 'stdio', command: 'node' }, { id: 'windows-mcp', transport: 'stdio', command: 'uvx' }]
      manager.busy = true
      const before = syncs.length
      ok((await connections.syncChanged()) === 'deferred' && syncs.length === before, '有进行中的 MCP 调用时延后，不动现有连接')
      ok((await connections.syncChanged()) === 'deferred' && manager.idleWaiters.length === 1, '重复触发只登记一次等待')
      manager.busy = false
      for (const waiter of manager.idleWaiters.splice(0)) waiter()
      await settle()
      await settle()
      ok(syncs.length === before + 1 && manager.configs.map((config) => config.id).join() === 'legacy,windows-mcp', '空闲后补做同步')
      ok(manager.closed === 0, '延后同步也不关闭整个管理器')
    }

    const makeBusy = (manager) => {
      manager.busy = true
      manager.isBusy = () => manager.busy
      manager.onceIdle = (callback) => { if (!manager.busy) callback(); else manager.idleWaiters.push(callback) }
    }

    {
      const { connections, env } = harness({ servers: [{ id: 'legacy', transport: 'stdio', command: 'node' }, { id: 'windows-mcp', transport: 'stdio', command: 'uvx', args: ['approval'] }] })
      const manager = connections.connectionManager()
      makeBusy(manager)
      manager.syncOptions.length = 0
      env.servers = [{ id: 'legacy', transport: 'stdio', command: 'node' }]
      ok((await connections.syncChanged({ immediate: true, cancelInFlight: '电脑操作已被关闭' })) === 'synced', '关闭电脑操作或调低权限：正忙也立即同步，不延后')
      ok(manager.configs.map((config) => config.id).join() === 'legacy', '立即同步后 windows-mcp 已从管理器移除')
      ok(manager.syncOptions.length === 1 && manager.syncOptions[0].cancelInFlight === '电脑操作已被关闭', '立即同步把中止进行中调用的提示交给管理器')
      ok(manager.idleWaiters.length === 0, '立即同步不再登记等待')

      env.servers = [{ id: 'legacy', transport: 'stdio', command: 'node' }, { id: 'windows-mcp', transport: 'stdio', command: 'uvx', args: ['auto'] }]
      manager.syncOptions.length = 0
      ok((await connections.syncChanged()) === 'deferred' && manager.syncOptions.length === 0, '放宽或无关变更：正忙时仍延后，不中止进行中的调用')
      ok((await connections.syncChanged({ immediate: false })) === 'deferred' && manager.idleWaiters.length === 1, '放宽变更重复触发只登记一次等待')
    }

    {
      const { connections, env } = harness()
      const first = connections.connectionManager()
      makeBusy(first)
      ok((await connections.syncChanged()) === 'deferred' && first.idleWaiters.length === 1, '延后登记等待回调')
      await connections.close()
      ok(first.idleWaiters.length === 0, '关闭管理器时清空等待回调')
      const second = connections.connectionManager()
      ok(second !== first, '关闭后换了新管理器')
      makeBusy(second)
      ok((await connections.syncChanged()) === 'deferred' && second.idleWaiters.length === 1, '关闭后新管理器正忙时重新登记等待，不会永远卡在「已延后」')
      second.busy = false
      for (const waiter of second.idleWaiters.splice(0)) waiter()
      await settle()
      ok(env.created.length === 2, '空闲后正常补做同步')
      ok((await connections.syncChanged()) === 'synced', '补做之后同步恢复正常')

      const third = connections.current()
      makeBusy(third)
      ok((await connections.syncChanged()) === 'deferred', '再次延后')
      await connections.closeCurrent()
      ok(third.idleWaiters.length === 0, 'closeCurrent 同样清空等待回调')
      const fourth = connections.connectionManager()
      makeBusy(fourth)
      ok((await connections.syncChanged()) === 'deferred' && fourth.idleWaiters.length === 1, '替换管理器后延后状态按新管理器重新计')
    }
  })
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
