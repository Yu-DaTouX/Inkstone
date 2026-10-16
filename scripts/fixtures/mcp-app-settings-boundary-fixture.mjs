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

export function createAccess({ servers = [], managers = [], host, log = [] }) {
  return {
    loadServers: () => ({ servers }),
    legacyManagers: () => managers,
    host: () => host,
    log
  }
}

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

export function piConfig(id, extra = {}) {
  return {
    id,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    ...extra
  }
}
