import { appendFileSync } from 'node:fs'

export default function (pi) {
  const file = process.env.VM_FIXTURE_HOOK_LOG
  if (!file) return
  const record = (kind, event) => {
    try {
      appendFileSync(
        file,
        `${JSON.stringify({
          kind,
          toolCallId: typeof event?.toolCallId === 'string' ? event.toolCallId : null,
          parentToolCallId: typeof event?.parentToolCallId === 'string' ? event.parentToolCallId : null,
          toolName: typeof event?.toolName === 'string' ? event.toolName : null,
          ...(typeof event?.isError === 'boolean' ? { isError: event.isError } : {})
        })}\n`
      )
    } catch {
    }
  }
  pi.on('tool_call', (event) => record('tool_call', event))
  pi.on('tool_result', (event) => record('tool_result', event))
  pi.on('tool_execution_start', (event) => record('tool_execution_start', event))
  pi.on('tool_execution_end', (event) => record('tool_execution_end', event))
}
