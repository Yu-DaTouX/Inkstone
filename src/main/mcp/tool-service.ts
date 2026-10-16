import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkToolArguments,
  classifyMcpResult,
  mcpToolCapabilityId,
  schemaRevisionOf,
  type McpToolDescriptor
} from '../../shared/mcp'
import type { McpConnectionManager } from './connection-manager'

export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'McpToolError'
  }
}

export interface McpToolDescription {
  id: string
  serverId: string
  toolName: string
  description?: string
  inputSchema: unknown
  schemaRevision: string
  selfReportedReadOnly: boolean
}

export interface McpCallOutcome {
  id: string
  serverId: string
  toolName: string
  toolError: boolean
  text: string
  bytes: number
  resultFile?: string
}

const DEFAULT_MAX_INLINE_BYTES = 32 * 1024

export function safeResultSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'tool'
}

export async function describeMcpTool(
  manager: McpConnectionManager,
  serverId: string,
  toolName: string
): Promise<McpToolDescription> {
  const tools = await manager.listTools(serverId)
  const tool = tools.find((t) => t.name === toolName)
  if (!tool) {
    throw new McpToolError('tool_not_found', `MCP 服务 ${serverId} 上没有这个工具：${toolName}`, {
      available: tools.map((t: McpToolDescriptor) => t.name)
    })
  }
  return {
    id: mcpToolCapabilityId(serverId, toolName),
    serverId,
    toolName,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema ?? null,
    schemaRevision: schemaRevisionOf(tool.inputSchema),
    selfReportedReadOnly: Boolean(tool.annotations?.readOnlyHint)
  }
}

export interface McpCallOptions {
  resultsDir: string
  maxInlineBytes?: number
  expectedRevision?: string
}

async function pruneResultFiles(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [])
  const files = await Promise.all(names.map(async (name) => {
    const path = join(dir, name)
    try { const info = await stat(path); return info.isFile() ? { path, mtime: info.mtimeMs } : null }
    catch { return null }
  }))
  const sorted = files.filter((file): file is { path: string; mtime: number } => file !== null).sort((a, b) => b.mtime - a.mtime)
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
  await Promise.all(sorted.filter((file, index) => index >= 200 || file.mtime < cutoff).map((file) => unlink(file.path).catch(() => undefined)))
}

export async function callMcpTool(
  manager: McpConnectionManager,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  options: McpCallOptions
): Promise<McpCallOutcome> {
  const described = await describeMcpTool(manager, serverId, toolName)

  if (options.expectedRevision && options.expectedRevision !== described.schemaRevision) {
    throw new McpToolError(
      'schema-changed',
      `工具 ${serverId}/${toolName} 的参数定义已变化（当前 ${described.schemaRevision}，你给的是 ${options.expectedRevision}）—— 请按新的 inputSchema 重新构造参数再试`,
      { inputSchema: described.inputSchema, schemaRevision: described.schemaRevision }
    )
  }

  const check = checkToolArguments(described.inputSchema, args)
  if (!check.ok) {
    throw new McpToolError(
      'invalid_arguments',
      `参数不符合 ${serverId}/${toolName} 的 inputSchema：` +
        [...check.missing.map((k) => `缺少必填 ${k}`), ...check.typeErrors].join('；'),
      { missing: check.missing, typeErrors: check.typeErrors, schemaRevision: described.schemaRevision }
    )
  }

  const raw = await manager.callTool(serverId, toolName, args)
  const { toolError, text } = classifyMcpResult(raw)
  const bytes = Buffer.byteLength(text, 'utf8')

  const limit = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES
  if (bytes <= limit) {
    return { id: described.id, serverId, toolName, toolError, text, bytes }
  }

  try {
    await mkdir(options.resultsDir, { recursive: true })
    await pruneResultFiles(options.resultsDir)
    const name = `${safeResultSlug(serverId)}-${safeResultSlug(toolName)}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    const file = join(options.resultsDir, name)
    await writeFile(file, text, 'utf8')
    return {
      id: described.id,
      serverId,
      toolName,
      toolError,
      text: `（结果过大：${bytes} 字节，已落盘，请按需读取）`,
      bytes,
      resultFile: file
    }
  } catch (error) {
    const preview = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8')
    return {
      id: described.id,
      serverId,
      toolName,
      toolError,
      text: `（结果共 ${bytes} 字节；落盘失败，以下为前 ${Buffer.byteLength(preview, 'utf8')} 字节截断内容：${error instanceof Error ? error.message : String(error)}）\n${preview}`,
      bytes
    }
  }
}
