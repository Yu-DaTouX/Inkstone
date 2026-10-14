/**
 * 只读探针（合集 05 原生核对）。
 *
 * 现场加载在 `danger-guard.js` **旁边**，用来记录随包 pi 1.2.0 实际提供的东西，
 * 而不是抄测试里的假数组：
 *
 *   · `session_start` / `tool_call` / `tool_execution_start` 时的 `pi.getAllTools()`
 *     里每个工具的真实 `name` 与 `annotations`；
 *   · 真实内部事件的 `toolCallId` / `parentToolCallId` —— 用来证明
 *     codemode 里的 `tools.mcp__...` 走的是原生嵌套调用，而不是测试伪造的 id。
 *
 * 只追加 JSONL 到 `MCP_GUARD_PROBE_LOG`，从不改参数、结果或其他扩展（含 danger-guard）。
 * 为绕开「danger-guard 先返回 block 会短路后续 tool_call 处理器」，
 * 本文件被复制为扩展目录里排序最靠前的名字；同时 `tool_execution_start`
 * 在 block 之前发出，作为第二路证据。
 */
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
      /* 探针绝不能影响会话 */
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
