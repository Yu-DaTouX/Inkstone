import { appendFileSync } from 'node:fs'

export default function mcpAppProxyProbe(pi) {
  const file = process.env.MCP_APP_PROXY_PROBE_LOG
  if (!file) return

  const snapshot = () => {
    try {
      const tools = pi.getAllTools?.()
      if (!Array.isArray(tools)) return { error: 'getAllTools did not return an array' }
      return tools
        .filter((tool) => typeof tool?.name === 'string' && tool.name.startsWith('mcp__'))
        .map((tool) => ({
          name: tool.name,
          annotations: tool.annotations ?? null,
          parameters: tool.parameters ?? null,
          description: tool.description ?? null,
          exposure: tool.exposure ?? null
        }))
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }

  pi.on('session_start', () => {
    try {
      appendFileSync(file, `${JSON.stringify({ kind: 'session_start', tools: snapshot() })}\n`)
    } catch {
    }
  })
}
