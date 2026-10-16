/**
 * `test-mcp-app-runtime-ownership.mjs` 的合成夹具。
 *
 * 只提供两样东西：
 *   · 可观测的 fake 连接管理器（记录创建 / 关闭次数、可加 gate 模拟迟到）；
 *   · 轻量 fake AgentController（满足 RunnerRegistry 必需方法，并暴露
 *     `nativeBootWitness()` 供 A7 事实源读取启动见证）。
 *
 * 不启动 Electron / pi / 真实模型 / 真实 MCP 服务，不读写真实用户配置。
 */
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

/**
 * 轻量 fake AgentController。`generation` 由 RunnerRegistry 在创建时注入；
 * `setWitness` 用来模拟「spawn 前采集 + ready 后签发」的结果（测试直接给最终见证）。
 */
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
    /* A7：宿主启动见证；generation 随 runner 代次重盖，bootId/cwd 仍是进程启动时的。 */
    nativeBootWitness: () => (witness ? { ...witness, generation } : null),
    setWitness(next) {
      witness = next
    },
    /* HI3：AgentController 侧 legacy 连接事实；空数组 = 已确认无 legacy 持有。 */
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
