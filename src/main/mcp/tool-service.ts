import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkToolArguments,
  classifyMcpResult,
  mcpImageParts,
  mcpToolCapabilityId,
  schemaRevisionOf,
  type McpResultTextOptions,
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
  annotations?: unknown
}

export interface McpCallOutcome {
  id: string
  serverId: string
  toolName: string
  toolError: boolean
  text: string
  bytes: number
  resultFile?: string
  images?: string[]
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
  const tools = await manager.listToolsCached(serverId)
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
    selfReportedReadOnly: Boolean(tool.annotations?.readOnlyHint),
    ...(tool.annotations ? { annotations: tool.annotations } : {})
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

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

export function imageExtensionOf(mimeType: string): string {
  return IMAGE_EXTENSIONS[mimeType.trim().toLowerCase().split(';')[0]] ?? 'bin'
}

function imageSavedText(mimeType: string, file: string): string {
  return `[图片 ${mimeType || '未知类型'}，已保存：${file}。支持图片的模型可用 read 工具打开；只收文字的模型看不到图片，请改用 Snapshot（use_vision=false）读取界面树。]`
}

function imageFailedText(mimeType: string, reason: string): string {
  return `[图片 ${mimeType || '未知类型'}，未能保存：${reason}]`
}

async function saveResultImages(
  raw: unknown,
  serverId: string,
  toolName: string,
  resultsDir: string
): Promise<{ options?: McpResultTextOptions; files: string[] }> {
  const parts = mcpImageParts(raw)
  if (parts.length === 0) return { files: [] }
  const replacements = new Map<number, string>()
  const files: string[] = []
  let prepared: string | null = null
  try {
    await mkdir(resultsDir, { recursive: true })
    await pruneResultFiles(resultsDir)
  } catch (error) {
    prepared = error instanceof Error ? error.message : String(error)
  }
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  for (const part of parts) {
    if (prepared !== null) {
      replacements.set(part.index, imageFailedText(part.mimeType, prepared))
      continue
    }
    try {
      const buffer = Buffer.from(part.data, 'base64')
      if (buffer.byteLength === 0) throw new Error('图片数据为空')
      const name = `${safeResultSlug(serverId)}-${safeResultSlug(toolName)}-${stamp}-${part.index}.${imageExtensionOf(part.mimeType)}`
      const file = join(resultsDir, name)
      await writeFile(file, buffer)
      files.push(file)
      replacements.set(part.index, imageSavedText(part.mimeType, file))
    } catch (error) {
      replacements.set(part.index, imageFailedText(part.mimeType, error instanceof Error ? error.message : String(error)))
    }
  }
  return {
    files,
    options: { image: (part) => replacements.get(part.index) ?? imageFailedText(part.mimeType, '未处理') }
  }
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
  const saved = await saveResultImages(raw, serverId, toolName, options.resultsDir)
  const { toolError, text } = classifyMcpResult(raw, saved.options)
  const bytes = Buffer.byteLength(text, 'utf8')
  const images = saved.files.length > 0 ? { images: saved.files } : {}

  const limit = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES
  if (bytes <= limit) {
    return { id: described.id, serverId, toolName, toolError, text, bytes, ...images }
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
      resultFile: file,
      ...images
    }
  } catch (error) {
    const preview = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8')
    return {
      id: described.id,
      serverId,
      toolName,
      toolError,
      text: `（结果共 ${bytes} 字节；落盘失败，以下为前 ${Buffer.byteLength(preview, 'utf8')} 字节截断内容：${error instanceof Error ? error.message : String(error)}）\n${preview}`,
      bytes,
      ...images
    }
  }
}
