/**
 * MCP 工具服务（实施-04 §4 / §5）：`describe` 与 `call` 两件事。
 *
 * 这里的职责不是「转发一次调用」，而是把 MCP 那套**弱类型约定**收敛成
 * 模型能安全使用的东西：
 *   · 调用前按 `inputSchema` 校验参数（漏必填 / 类型错要当场说清）；
 *   · 参数定义变了要能**认出来**（`schemaRevision` 不等 → 可重试的 `schema-changed`，
 *     而不是拿旧参数硬调 —— §4 明文要求）；
 *   · 结果太大就落盘，stdout 只回摘要（否则一次 `big` 就是几百 KB 进上下文）；
 *   · **工具级错误**与协议错误分开（§5）。
 *
 * ⚠️ 它**不**决定权限：`annotations.readOnlyHint` 是服务自己的说法，
 * 只原样展示，不参与任何判定（§4）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
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
  /** 服务**自报**的只读提示。仅展示用 —— 不是权限。 */
  selfReportedReadOnly: boolean
}

export interface McpCallOutcome {
  id: string
  serverId: string
  toolName: string
  /** `true` 表示工具自己失败（`isError`），不是协议错误。 */
  toolError: boolean
  text: string
  bytes: number
  /** 超过内联上限时，完整文本落在这里。 */
  resultFile?: string
}

/** 默认内联上限：超过就落盘。32KB 足够容纳正常工具输出，又不至于吃穿上下文。 */
const DEFAULT_MAX_INLINE_BYTES = 32 * 1024

/** 文件名安全化：serverId / toolName 可能含 `/`，直接拼会走出目录。 */
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
  /** 结果落盘目录（`YAN_DIR` 下）。 */
  resultsDir: string
  maxInlineBytes?: number
  /**
   * 调用方上次看到的 `schemaRevision`。给了就必须相等 ——
   * 不等时抛 `schema-changed`，让模型按**新** schema 重新构造参数再试。
   */
  expectedRevision?: string
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

  /* 大结果落盘：stdout 只回摘要，模型按需去读文件（与 yan 其它命令同一约定）。 */
  await mkdir(options.resultsDir, { recursive: true })
  const name = `${safeResultSlug(serverId)}-${safeResultSlug(toolName)}-${Date.now()}.txt`
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
}
