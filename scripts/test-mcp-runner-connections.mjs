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
        syncServers: (next) => {
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
  })
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
