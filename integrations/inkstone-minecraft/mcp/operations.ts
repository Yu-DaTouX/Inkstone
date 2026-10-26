import { randomUUID } from 'node:crypto'
import { failure, text, type ToolDefinition, type ToolResult } from './protocol.ts'

interface Operation {
  id: string
  key: string
  name: string
  startedAt: number
  finishedAt?: number
  result?: ToolResult
  done: Promise<ToolResult>
}

function longOperation(name: string, args: Record<string, unknown>): boolean {
  return ['mc_build', 'mc_apply', 'mc_wait', 'mc_source', 'mc_script'].includes(name) || (name === 'mc_test' && args.action !== 'list') || (name === 'mc_options' && !!args.set) || (name === 'mc_run' && ['start', 'restart'].includes(String(args.action))) || (name === 'mc_tick' && args.action === 'step') || (name === 'mc_world' && args.action === 'snapshot')
}

const OPERATION_TOOLS = new Set(['mc_build', 'mc_apply', 'mc_run', 'mc_source', 'mc_tick', 'mc_wait', 'mc_world', 'mc_script', 'mc_options', 'mc_test'])

export function withOperations(tools: ToolDefinition[], projectKey: (args: Record<string, unknown>) => string, defaultWaitMs = 10_000): ToolDefinition[] {
  const operations = new Map<string, Operation>()
  const pending = (operation: Operation) => text(`后台操作进行中：${operation.name}，已运行 ${Math.round((Date.now() - operation.startedAt) / 1000)} 秒\noperation_id=${operation.id}\n用 mc_operation operation_id="${operation.id}" 查询最终结果；不要重复启动同一操作。操作记录仅在当前 MCP 进程内保存。`)
  const wait = async (operation: Operation, waitMs: number): Promise<ToolResult> => {
    if (operation.result) return operation.result
    if (waitMs === 0) return pending(operation)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation.done, new Promise<ToolResult>((resolve) => { timer = setTimeout(() => resolve(pending(operation)), waitMs) })])
    } finally {
      clearTimeout(timer)
    }
  }
  const waitMs = (args: Record<string, unknown>) => typeof args.wait_ms === 'number' && Number.isFinite(args.wait_ms) ? Math.max(0, Math.min(20_000, Math.round(args.wait_ms))) : defaultWaitMs
  const wrapped = tools.map((tool) => ({
    ...tool,
    description: `${tool.description}${OPERATION_TOOLS.has(tool.name) ? ' 长操作默认同步等待 10 秒，未完成返回 operation_id，用 mc_operation 查询；wait_ms=0 立即返回后台操作。' : ''}`,
    inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as Record<string, unknown>), ...(OPERATION_TOOLS.has(tool.name) ? { wait_ms: { type: 'number', minimum: 0, maximum: 20000, description: '同步等待毫秒数，默认 10000；0 立即返回后台操作，后续用 mc_operation 查询' } } : {}) } },
    run: async (args: Record<string, unknown>) => {
      if (!longOperation(tool.name, args)) return tool.run(args)
      for (const [id, operation] of operations) if (operation.finishedAt && Date.now() - operation.finishedAt > 30 * 60_000) operations.delete(id)
      const signature = JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'wait_ms').sort(([a], [b]) => a.localeCompare(b))))
      const key = `${projectKey(args)}:${tool.name}:${signature}`
      const running = [...operations.values()].find((operation) => operation.key === key && !operation.result)
      if (running) return wait(running, waitMs(args))
      if (operations.size >= 100) {
        const completed = [...operations.values()].find((operation) => operation.result)
        if (completed) operations.delete(completed.id)
        else return failure('后台操作已达 100 个，请先等待已有操作完成')
      }
      const operation: Operation = { id: randomUUID(), key, name: `${tool.name}${args.action ? ` ${String(args.action)}` : ''}`, startedAt: Date.now(), done: Promise.resolve(text('')) }
      operation.done = Promise.resolve().then(() => tool.run(args)).catch((error) => failure(error instanceof Error ? error.message : String(error))).then((result) => {
        operation.result = result
        operation.finishedAt = Date.now()
        return result
      })
      operations.set(operation.id, operation)
      return wait(operation, waitMs(args))
    }
  }))
  return [...wrapped, {
    name: 'mc_operation',
    title: '查询后台操作',
    description: '查询 mc_build、mc_run 等工具返回的 operation_id。完成后返回原工具的完整结果（包括失败和图片）；进行中返回状态。记录只存在于当前 MCP 进程，完成后保留最多 30 分钟、100 条。',
    inputSchema: { type: 'object', properties: { operation_id: { type: 'string' }, wait_ms: { type: 'number', minimum: 0, maximum: 20000, description: '最多等待毫秒数，默认 10000' } }, required: ['operation_id'] },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const operation = operations.get(String(args.operation_id))
      return operation ? wait(operation, waitMs(args)) : failure('找不到 operation_id：记录可能已过期或 MCP 进程已重启；先查询 mc_run action=status，确认状态后再决定是否重试')
    }
  }]
}
