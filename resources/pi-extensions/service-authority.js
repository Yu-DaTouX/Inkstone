/** Dedicated to the independent host. Desktop permissions remain unchanged. */
async function host(action, event) {
  const url = process.env.INKSTONE_AUTHORITY_URL
  const token = process.env.INKSTONE_AUTHORITY_TOKEN
  if (!url || !token) throw new Error('运行授权通道不可用')
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, taskId: process.env.INKSTONE_TASK_ID, generation: Number(process.env.INKSTONE_GENERATION), toolCallId: event.toolCallId, tool: event.toolName, input: event.input, isError: event.isError }),
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new Error(`运行授权失败 (${response.status})`)
  return response.json()
}
export default function serviceAuthority(pi) {
  pi.on('session_start', () => { pi.setActiveTools(['read', 'write', 'edit']) })
  // Model budgets are enforced by the host provider proxy, before network dispatch.
  pi.on('tool_call', async event => {
    try {
      const result = await host('tool', event)
      if (!result.allowed) return { block: true, reason: result.reason ?? '任务授权拒绝' }
    } catch (error) { return { block: true, reason: String(error) } }
  })
  pi.on('tool_result', async event => {
    // A missing result receipt must fail the turn rather than mask an unknown side effect.
    await host('receipt', event)
  })
}
