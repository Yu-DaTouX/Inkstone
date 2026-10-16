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
