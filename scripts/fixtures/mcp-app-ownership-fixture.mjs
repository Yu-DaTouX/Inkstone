/**
 * `test-mcp-app-ownership.mjs` 的合成夹具：可观测的 fake 连接管理器。
 *
 * 归属守卫的验收点是「该不该连、旧连接有没有先关」——不需要真实 MCP 服务，
 * 只需要一个能记录**创建 / 关闭 / 连接次数**的 manager，让「真实连接数量与关闭
 * 次数」可断言。真实连接已由 `test-mcp-app-host.mjs` 用合成服务器覆盖，本夹具
 * 不重复，也不声称替代真实服务/规范的验证。
 */
export function createFakeManagerFactory() {
  const records = []
  const events = []
  return {
    records,
    events,
    /** 过滤某个服务的 manager 记录（按创建顺序）。 */
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
