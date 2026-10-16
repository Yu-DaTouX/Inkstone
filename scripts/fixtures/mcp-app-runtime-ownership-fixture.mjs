export function createFakeManagerFactory() {
  const records = []
  const events = []
  return {
    records,
    events,
    forServer(serverId) {
      return records.filter((record) => record.serverId === serverId)
    },
    createManager(config) {
      const record = {
        id: records.length + 1,
        serverId: config.id,
        connects: 0,
        closes: 0,
        connected: false,
        gate: null
      }
      events.push(`create:${record.id}:${config.id}`)
      record.manager = {
        statusOf: () => ({ status: record.connected ? 'ready' : 'disconnected' }),
        listToolsRaw: async () => {
          record.connects++
          record.connected = true
          if (record.gate) await record.gate
          return [{ name: 'tool', description: 'fixture 工具' }]
        },
        callTool: async () => {
          record.connects++
          record.connected = true
          if (record.gate) await record.gate
          return { content: [{ type: 'text', text: 'ok' }] }
        },
        readResource: async (serverId, uri) => {
          record.connects++
          record.connected = true
          if (record.gate) await record.gate
          return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><html></html>' }] }
        },
        close: async () => {
          record.closes++
          record.connected = false
          events.push(`close:${record.id}:${config.id}`)
        }
      }
      records.push(record)
      return record.manager
    }
  }
}

export function createFakeAgent({ cwd, generation = 1, sessionSeq = { value: 0 } }) {
  const index = ++sessionSeq.value
  const state = {
    sessionId: `sess-${index}`,
    sessionFile: `/tmp/sess-${index}.jsonl`,
    cwd,
    isAgentRunning: false,
    isStreaming: false,
    isCompacting: false
  }
  let live = true
  let connection = 'ready'
  let projectId = null
  let witness = null
  let legacyMcpServices = []
  const calls = { start: 0, stop: 0, switchSession: 0, newSession: 0, reloadMcpServers: 0 }
  return {
    getState: () => state,
    getConn: () => ({ state: connection, detail: '' }),
    get running() {
      return live
    },
    get capabilityProjectId() {
      return projectId
    },
    setRunnerGeneration(next) {
      if (Number.isSafeInteger(next) && next > 0) generation = next
    },
    nativeBootWitness: () => (witness ? { ...witness, generation } : null),
    setWitness(next) {
      witness = next
    },
    getLegacyMcpHolderSnapshot: () => ({ services: legacyMcpServices.map((service) => ({ ...service })) }),
    setLegacyMcpServices(next) {
      legacyMcpServices = Array.isArray(next) ? next : []
    },
    hasRunningBash: () => false,
    getPendingUiCount: () => 0,
    hasWrittenThisRun: () => false,
    queueSnapshot: () => ({ steering: [], followUp: [] }),
    async start() {
      calls.start++
      live = true
      connection = 'ready'
      return { ok: true }
    },
    async stop() {
      calls.stop++
      live = false
      connection = 'exited'
      return undefined
    },
    async switchSession() {
      calls.switchSession++
      return { ok: true }
    },
    async newSession() {
      calls.newSession++
      return { ok: true }
    },
    async reloadMcpServers() {
      calls.reloadMcpServers++
      return undefined
    },
    calls,
    setRuntime(nextLive, nextConn) {
      live = nextLive
      connection = nextConn
    },
    setProjectId(next) {
      projectId = next
    }
  }
}
