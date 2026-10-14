/**
 * Tool-hook recorder for `scripts/test-virtual-model-native.mjs`.
 *
 * Answers one question: does a nested call made from inside the native `codemode`
 * script (for example `tools.bash(...)`) reach the same `tool_call` /
 * `tool_result` handlers as a model-issued call, with real parent/child ids?
 *
 * The test copies this file to `<PI_CODING_AGENT_DIR>/extensions/virtual-model-hook.js`.
 * It only appends JSONL to `process.env.VM_FIXTURE_HOOK_LOG`; it does not change
 * arguments, results, or any product extension (including danger-guard).
 */
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
      /* fixture logging must never affect the session */
    }
  }
  pi.on('tool_call', (event) => record('tool_call', event))
  pi.on('tool_result', (event) => record('tool_result', event))
  pi.on('tool_execution_start', (event) => record('tool_execution_start', event))
  pi.on('tool_execution_end', (event) => record('tool_execution_end', event))
}
