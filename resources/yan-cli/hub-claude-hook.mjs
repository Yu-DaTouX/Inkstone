/** 会话级 PreToolUse：宿主不答复或请求失败时明确拒绝，不修改个人全局 hooks。 */
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
  if (input.length > 1024 * 1024) { process.stderr.write('Inkstone hook input too large'); process.exit(2) }
}
let decision = 'deny'
try {
  const event = JSON.parse(input)
  const response = await fetch(process.env.INKSTONE_HUB_URL, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.INKSTONE_HUB_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, command: 'hub.approve', sessionId: process.env.INKSTONE_HUB_RUN, projectId: process.env.INKSTONE_HUB_PROJECT, params: { tool: event.tool_name, input: event.tool_input, toolUseId: event.tool_use_id } }),
    signal: AbortSignal.timeout(125_000)
  })
  const result = await response.json()
  if (response.ok && result.ok && result.summary?.allowed === true) decision = 'allow'
} catch { /* 默认拒绝 */ }
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: decision === 'allow' ? 'Inkstone 用户已批准本次调用' : 'Inkstone 未获得本次调用的有效批准' } }))
