import { writeFileSync } from 'node:fs'

export default function pb2DiagExtension(pi) {
  pi.registerTool({
    name: 'diag_danger',
    label: 'diag_danger',
    description: 'PB2 diagnostic tool with destructive annotation.',
    parameters: { type: 'object', properties: { note: { type: 'string' } }, required: [] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    execute: async (_toolCallId, params) => ({
      content: [{ type: 'text', text: `diag_danger executed note=${params?.note ?? ''}` }],
      details: { note: params?.note ?? '' }
    })
  })

  pi.on('session_start', async () => {
    try {
      const tools = (pi.getAllTools ? pi.getAllTools() : []).map((t) => ({
        name: t.name,
        exposure: t.exposure,
        annotations: t.annotations
      }))
      const active = pi.getActiveTools ? pi.getActiveTools() : undefined
      if (process.env.DIAG_TOOLS_OUT) writeFileSync(process.env.DIAG_TOOLS_OUT, JSON.stringify({ tools, active }, null, 2))
    } catch (error) {
      if (process.env.DIAG_TOOLS_OUT) writeFileSync(process.env.DIAG_TOOLS_OUT, JSON.stringify({ error: String(error) }))
    }
  })
}
