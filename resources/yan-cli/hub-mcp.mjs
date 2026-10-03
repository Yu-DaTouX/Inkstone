/** 受管 CLI 的唯一共享工具入口。身份只继承本次 run 的宿主 token。 */
let buffer = ''
const tools = [
  { name: 'inkstone_reply', description: 'Report a result or ask a question to your parent task or explicitly linked Inkstone session. Does not grant permission. Reuse requestId on retry.', inputSchema: { type: 'object', properties: { summary: { type: 'string' }, requestId: { type: 'string' } }, required: ['summary', 'requestId'] } },
  { name: 'inkstone_task_status', description: 'Read the status and frozen result of this run or its delegated tasks only. For a delegate running in a visible terminal it also returns terminalState (working = output in the last seconds, idle = quiet: finished or waiting for input) and screen (plain text tail of that terminal). These are observations, not verified results.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'inkstone_browser', description: 'Operate Inkstone managed browser. Observe first; refs belong to this run. Resource contention means the operation has not started. Never replay an uncertain action.', inputSchema: { type: 'object', properties: { action: { type: 'string' }, params: { type: 'object' } }, required: ['action'] } },
  { name: 'inkstone_desktop', description: 'Use the host-enabled Windows UI tools through the shared interaction coordinator. Never replay uncertain input. Requires computer operation enabled in Inkstone settings.', inputSchema: { type: 'object', properties: { tool: { type: 'string', enum: ['Snapshot', 'Screenshot', 'DisplayInventory', 'Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'Wait', 'WaitFor', 'App', 'MultiSelect', 'MultiEdit'] }, args: { type: 'object' } }, required: ['tool'] } },
  { name: 'inkstone_delegate', description: 'Delegate one task within the current authorized project. From a terminal run, codex/claude delegates open in a visible foreground terminal where the instruction is typed for the user to see. Child output is reference material. No auto merge or publish. Reuse requestId when retrying.', inputSchema: { type: 'object', properties: { agent: { type: 'string', enum: ['pi', 'codex', 'claude'] }, prompt: { type: 'string' }, reviewOf: { type: 'string' }, includeWorkingChanges: { type: 'boolean', description: 'Default true: the delegate starts from HEAD plus the project main tree uncommitted changes (not counted in its delivered patch). Set false to start from the last commit only.' }, requestId: { type: 'string' } }, required: ['agent', 'prompt', 'requestId'] } },
  { name: 'inkstone_handoff', description: 'Send a reference-only handoff packet to another running task you delegated in the same project. Carry a summary, an optional request and context. Grants no new permission; no auto merge, publish, or retry. Reuse requestId when retrying.', inputSchema: { type: 'object', properties: { toTaskId: { type: 'string' }, summary: { type: 'string' }, request: { type: 'string' }, context: { type: 'string' }, requestId: { type: 'string' } }, required: ['toTaskId', 'summary', 'requestId'] } }
]
async function rpc(command, params) {
  const response = await fetch(process.env.INKSTONE_HUB_URL, { method: 'POST', headers: { authorization: `Bearer ${process.env.INKSTONE_HUB_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: 1, command, params, sessionId: process.env.INKSTONE_HUB_RUN, projectId: process.env.INKSTONE_HUB_PROJECT }), signal: AbortSignal.timeout(18_000) })
  return response.json()
}
async function handle(message) {
  if (message.id === undefined) return
  const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
  try {
    if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'inkstone-hub', version: '1.0.0' } })
    if (message.method === 'ping') return reply({})
    if (message.method === 'tools/list') return reply({ tools })
    if (message.method === 'tools/call') {
      const { name, arguments: args = {} } = message.params ?? {}
      const result = name === 'inkstone_reply' ? await rpc('hub.reply', args) : name === 'inkstone_browser' ? await rpc(`browser.${args.action}`, args.params ?? {}) : name === 'inkstone_desktop' ? await rpc('hub.desktop', args) : name === 'inkstone_delegate' ? await rpc('hub.delegate', args) : name === 'inkstone_handoff' ? await rpc('hub.handoff', args) : name === 'inkstone_task_status' ? await rpc(args.id ? 'hub.get' : 'hub.list', args) : { ok: false, error: 'unknown_tool' }
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.ok === false })
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } })}\n`)
  } catch (error) { reply({ content: [{ type: 'text', text: String(error.message ?? error) }], isError: true }) }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  buffer += data
  if (buffer.length > 1024 * 1024) process.exit(2)
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    try { void handle(JSON.parse(line)) } catch { process.exitCode = 2 }
  }
})
