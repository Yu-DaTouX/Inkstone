import { join } from 'node:path'
import { CapabilityCommandError } from '../capability-server'
import { paramString } from '../command-params'
import { YAN_DIR } from '../paths'
import type { McpConnectionManager } from '../mcp/connection-manager'
import { callMcpTool, describeMcpTool, McpToolError } from '../mcp/tool-service'
import { assertLegacyMcpAccessBlocked } from '../mcp/app-proxy-service'
import { mcpApprovalNeeded, mcpCallDanger } from '../../shared/mcp-approval'
import { migratedMcpCommandNotice } from '../../shared/mcp-native-import'
import type { ApprovalDecision, ApprovalOwner } from '../../shared/approval'
import type { DangerConfirmPrompt } from '../agent'

export interface McpCommandHost {
  cwd(): string
  mcpConnectionManager(): McpConnectionManager
  mcpConfigError(): string | undefined
  permissionMode(): Promise<'danger' | 'all' | undefined>
  confirmDanger(request: DangerConfirmPrompt): Promise<ApprovalDecision | null>
  approvalOwner(): ApprovalOwner
}

async function runMcpList(host: McpCommandHost, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const manager = host.mcpConnectionManager()
  const usable = manager.list().filter((server) => server.enabled !== false && !server.migratedToNative)
  const servers = await Promise.all(
    usable.map(async (server) => {
      try {
        const tools = await manager.listToolsCached(server.id, { signal })
        return {
          serverId: server.id,
          title: server.title ?? server.id,
          effect: server.effect ?? 'unknown',
          status: manager.statusOf(server.id).status,
          tools: tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description.replace(/\s+/g, ' ').slice(0, 200) } : {})
          }))
        }
      } catch (error) {
        return {
          serverId: server.id,
          title: server.title ?? server.id,
          effect: server.effect ?? 'unknown',
          status: manager.statusOf(server.id).status,
          tools: [],
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })
  )
  signal?.throwIfAborted()
  const configError = host.mcpConfigError()
  return {
    data: { servers },
    summary: {
      kind: 'mcp',
      action: 'list',
      servers: servers.map((server) => ({
        serverId: server.serverId,
        status: server.status,
        tools: server.tools.map((tool) => tool.name),
        ...('error' in server ? { error: server.error } : {})
      })),
      ...(configError ? { configWarning: configError } : {})
    }
  }
}

export async function confirmMcpCall(
  host: McpCommandHost,
  manager: McpConnectionManager,
  serverId: string,
  toolName: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const mode = await host.permissionMode()
  signal?.throwIfAborted()
  if (mode === 'all') return
  const described = await describeMcpTool(manager, serverId, toolName, signal)
  if (!mcpApprovalNeeded(described.annotations)) return
  const detail = JSON.stringify(params.arguments ?? params.args ?? {})
  const answer = await host.confirmDanger({
    tool: 'yan mcp call',
    detail: `${serverId} / ${toolName}\n${detail.slice(0, 2000)}`,
    reasons: mcpCallDanger(`mcp__${serverId}__${toolName}`, described.annotations),
    cwd: host.cwd(),
    owner: host.approvalOwner(),
    signal
  })
  signal?.throwIfAborted()
  if (answer?.decision !== 'allow') {
    throw new CapabilityCommandError(
      'mcp_call_denied',
      answer?.feedback ? `用户拒绝了这次 MCP 调用：${answer.feedback}` : '没有得到用户确认，已拒绝这次 MCP 调用'
    )
  }
}

export async function runMcpCommand(host: McpCommandHost, action: string, params: Record<string, unknown>, signal?: AbortSignal) {
  if (signal?.aborted) throw new CapabilityCommandError('mcp_cancelled', 'MCP 请求已取消')
  if (action === 'list') return runMcpList(host, signal)
  if (action !== 'describe' && action !== 'call') {
    throw new CapabilityCommandError('not_implemented', `命令已接通但尚未实现：mcp.${action}`)
  }
  const serverId = paramString(params, ['serverId', 'server', 'server-id'])
  const toolName = paramString(params, ['toolName', 'tool', 'name', 'tool-name'])
  if (!serverId) {
    const configError = host.mcpConfigError()
    throw new CapabilityCommandError(
      'mcp_server_required',
      configError
        ? `需要 --server <服务ID>；另外 MCP 配置有问题：${configError}`
        : '需要 --server <服务ID>（服务在 YAN_DIR/mcp-servers.json 里登记）'
    )
  }
  if (!toolName) {
    throw new CapabilityCommandError('mcp_tool_required', '需要 --tool <工具名>（先用 yan mcp describe 拿 schema）')
  }

  assertLegacyMcpAccessBlocked({ serverId, toolName, action })
  const manager = host.mcpConnectionManager()
  const migratedToNative = manager.list().find((entry) => entry.id === serverId)?.migratedToNative
  if (migratedToNative) {
    throw new CapabilityCommandError('mcp_migrated_to_native', migratedMcpCommandNotice(serverId, migratedToNative))
  }
  try {
    if (action === 'describe') {
      const described = await describeMcpTool(manager, serverId, toolName, signal)
      const configError = host.mcpConfigError()
      return {
        data: described,
        summary: {
          kind: 'mcp',
          action: 'describe',
          serverId,
          toolName,
          schemaRevision: described.schemaRevision,
          selfReportedReadOnly: described.selfReportedReadOnly,
          ...(configError ? { configWarning: configError } : {})
        }
      }
    }

    if (action === 'call') await confirmMcpCall(host, manager, serverId, toolName, params, signal)

    const rawArgs = params.arguments ?? params.args
    const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
    const expectedRevision = paramString(params, [
      'schemaRevision',
      'schema-revision',
      'expectedRevision',
      'expected-revision'
    ])
    const outcome = await callMcpTool(manager, serverId, toolName, args, {
      resultsDir: join(YAN_DIR, 'mcp-results'),
      signal,
      ...(expectedRevision ? { expectedRevision } : {})
    })
    const configError = host.mcpConfigError()
    return {
      data: outcome,
      summary: {
        kind: 'mcp',
        action: 'call',
        serverId,
        toolName,
        toolError: outcome.toolError,
        bytes: outcome.bytes,
        ...(outcome.resultFile ? { resultFile: outcome.resultFile } : {}),
        ...(outcome.images ? { imageFiles: outcome.images } : {}),
        ...(configError ? { configWarning: configError } : {})
      }
    }
  } catch (error) {
    if (signal?.aborted) throw new CapabilityCommandError('mcp_cancelled', 'MCP 请求已取消')
    if (error instanceof CapabilityCommandError) throw error
    if (error instanceof McpToolError) {
      throw new CapabilityCommandError(error.code, error.message, error.data)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new CapabilityCommandError('mcp_unavailable', `MCP 调用失败：${message}`)
  }
}
