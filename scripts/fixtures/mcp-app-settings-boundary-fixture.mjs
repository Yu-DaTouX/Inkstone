/**
 * `test-mcp-app-settings-boundary.mjs` 用的 fake legacy manager / fake 宿主。
 *
 * 只记录「谁被调用」，不实现真实 MCP 协议：这些 fake 用来断言设置页的检查 /
 * 状态 / 断开 / 登记 probe 是否**只走单一归属路径**，不代表真实服务兼容。
 */

/** fake legacy `McpConnectionManager`：记录 disconnect / listToolsCached，绝不真连。 */
export function createFakeLegacyManager(ids, log) {
  const present = new Set(ids)
  const calls = []
  return {
    log,
    listServerIds: () => [...present],
    list: () => [...present].map((id) => ({ id, transport: 'stdio' })),
    statusOf: (id) => ({ status: present.has(id) ? 'ready' : 'error' }),
    toolCountOf: (id) => (present.has(id) ? 3 : null),
    async disconnect(id) {
      calls.push(`legacy.disconnect:${id}`)
      log.push(`legacy.disconnect:${id}`)
      return present.has(id)
    },
    async listToolsCached(id) {
      calls.push(`legacy.listToolsCached:${id}`)
      log.push(`legacy.listToolsCached:${id}`)
      return []
    },
    async close() {
      calls.push('legacy.close')
      log.push('legacy.close')
    },
    calls
  }
}

/**
 * fake `McpAppHost`：只记录 reconcile / listToolsWithMeta / disconnect / statusOf，
 * 便于断言「检查前先 reconcile」「断开只断该 server」「读状态不连接」。
 */
export function createFakeAppHost(log, options = {}) {
  const connected = []
  return {
    log,
    connected,
    statusOf: (id) => ({ status: 'disconnected', id }),
    toolCountOf: () => null,
    async reconcile(id) {
      log.push(`host.reconcile:${id}`)
      return { serverId: id, managed: true, eligible: true, closed: false }
    },
    async listToolsWithMeta(id, opts = {}) {
      log.push(`host.listToolsWithMeta:${id}:${opts.projectId ?? '-'}`)
      connected.push(id)
      return [{ name: 'toolA' }, { name: 'toolB' }]
    },
    async disconnect(id) {
      log.push(`host.disconnect:${id}`)
      return true
    },
    async close() {
      log.push('host.close')
    },
    ...options
  }
}

/** 组装 `SettingsSafeAccess`。`host` 可换成抛错实现，验证「读状态不连接」。 */
export function createAccess({ servers = [], managers = [], host, log = [] }) {
  return {
    loadServers: () => ({ servers }),
    legacyManagers: () => managers,
    host: () => host,
    log
  }
}

/** 一条砚托管配置（`ownedBy:'inkstone'` + `appHost`）。 */
export function managedConfig(id, extra = {}) {
  return {
    id,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    ownedBy: 'inkstone',
    appHost: { at: '2026-10-16T00:00:00.000Z', natives: [] },
    ...extra
  }
}

/** 一条 pi 原生配置。 */
export function piConfig(id, extra = {}) {
  return {
    id,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    ...extra
  }
}
