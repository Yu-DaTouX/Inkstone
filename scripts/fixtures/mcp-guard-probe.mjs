import { appendFileSync } from 'node:fs'

export default function mcpGuardProbe(pi) {
  const file = process.env.MCP_GUARD_PROBE_LOG
  if (!file) return

  const snapshot = () => {
    try {
      const tools = pi.getAllTools?.()
      if (!Array.isArray(tools)) return { error: 'getAllTools did not return an array' }
      return tools.map((tool) => ({ name: tool?.name ?? null, annotations: tool?.annotations ?? null }))
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }

  const lookup = (toolName) => {
    const tools = snapshot()
    if (!Array.isArray(tools)) return null
    return tools.find((tool) => tool.name === toolName) ?? null
  }

  const record = (kind, event) => {
    try {
      appendFileSync(
        file,
        `${JSON.stringify({
          kind,
          toolName: typeof event?.toolName === 'string' ? event.toolName : null,
          toolCallId: typeof event?.toolCallId === 'string' ? event.toolCallId : null,
          parentToolCallId: typeof event?.parentToolCallId === 'string' ? event.parentToolCallId : null,
          isError: typeof event?.isError === 'boolean' ? event.isError : undefined,
          resultText: typeof event?.resultText === 'string' ? event.resultText : undefined,
          tool: lookup(event?.toolName),
          tools: kind === 'session_start' ? snapshot() : undefined
        })}\n`
      )
    } catch {
    }
  }

  pi.on('session_start', (event) => record('session_start', event))
  pi.on('tool_call', (event) => record('tool_call', event))
  pi.on('tool_execution_start', (event) => record('tool_execution_start', event))
  pi.on('tool_execution_end', (event) => record('tool_execution_end', { ...event, input: undefined, resultText: textOf(event?.result) }))
}

function textOf(result) {
  try {
    const content = result?.content
    if (!Array.isArray(content)) return null
    const joined = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    return joined.length > 300 ? `${joined.slice(0, 300)}…` : joined || null
  } catch {
    return null
  }
}
