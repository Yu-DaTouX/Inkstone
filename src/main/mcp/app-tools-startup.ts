import { existsSync } from 'node:fs'

export const MCP_APP_TOOLS_COLD_WAIT_MS = 2000

export type McpAppToolsStartWait = 'none' | 'snapshot' | 'refreshed' | 'timeout'

export async function awaitMcpAppToolsForStart(input: {
  snapshotPath?: string
  refresh?: Promise<unknown>
  coldWaitMs?: number
  exists?: (path: string) => boolean
}): Promise<McpAppToolsStartWait> {
  if (!input.refresh) return 'none'
  const exists = input.exists ?? existsSync
  if (input.snapshotPath && exists(input.snapshotPath)) {
    input.refresh.catch(() => undefined)
    return 'snapshot'
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, input.coldWaitMs ?? MCP_APP_TOOLS_COLD_WAIT_MS))
  })
  try {
    return await Promise.race([input.refresh.then(() => 'refreshed' as const, () => 'refreshed' as const), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
