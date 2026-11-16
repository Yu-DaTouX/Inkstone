import { join } from 'node:path'
import { pick } from '../../shared/ui-lang'
import { CapabilityCommandError } from '../capability-server'
import { paramString } from '../command-params'
import { YAN_DIR } from '../paths'
import type { McpConnectionManager } from '../mcp/connection-manager'
import { callMcpTool, describeMcpTool, McpToolError } from '../mcp/tool-service'
import { assertLegacyMcpAccessBlocked } from '../mcp/app-proxy-service'
import { mcpApprovalNeeded, mcpCallDanger, mcpCallsAskInMode } from '../../shared/mcp-approval'
import { APPROVAL_DETAIL_MAX, type ApprovalDecision, type ApprovalOwner } from '../../shared/approval'
import type { DangerConfirmPrompt } from '../agent'
import { COMPUTER_USE_SERVER_ID } from '../computer-use'

const COMPUTER_USE_BLOCKED_ARGUMENTS = ['save_path']

export function assertComputerUseArguments(serverId: string, toolName: string, args: Record<string, unknown>): void {
  if (serverId !== COMPUTER_USE_SERVER_ID) return
  const blocked = COMPUTER_USE_BLOCKED_ARGUMENTS.filter((key) => Object.hasOwn(args, key) && args[key] !== null && args[key] !== undefined)
  if (blocked.length === 0) return
  throw new CapabilityCommandError(
    'mcp_argument_blocked',
    pick(`${serverId}/${toolName} 的 ${blocked.join('、')} 会把截图写到任意路径，绕过项目外写入守卫，砚不开放这个参数。去掉它重试：结果里的图片砚已自动保存成文件，路径写在结果文本里；需要放到别处时再用命令复制那个文件。`,
      `${blocked.join(', ')} of ${serverId}/${toolName} writes the screenshot to any path and bypasses the outside-project write guard, so Inkstone does not allow it. Retry without it: Inkstone already saves result images to files and the result text gives their paths; copy that file with a command if you need it elsewhere.`
    )
  )
}

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
  const usable = manager.list().filter((server) => server.enabled !== false)
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

export const COMPUTER_TOOL_TARGETS: Record<string, string> = {
  computer_snapshot: 'Snapshot',
  computer_screenshot: 'Screenshot',
  computer_displays: 'DisplayInventory',
  computer_click: 'Click',
  computer_type: 'Type',
  computer_scroll: 'Scroll',
  computer_move: 'Move',
  computer_shortcut: 'Shortcut',
  computer_wait: 'Wait',
  computer_wait_for: 'WaitFor',
  computer_app: 'App',
  computer_multi_select: 'MultiSelect',
  computer_multi_edit: 'MultiEdit',
  computer_control: 'ControlStatus'
}

function mcpCallLabel(serverId: string, toolName: string, params: Record<string, unknown>): string {
  const call = params.toolCall
  const fromTool = !!call && typeof call === 'object' && typeof (call as { id?: unknown }).id === 'string'
  const via = typeof params.via === 'string' ? params.via : ''
  const matches = serverId === COMPUTER_USE_SERVER_ID && Object.hasOwn(COMPUTER_TOOL_TARGETS, via) && COMPUTER_TOOL_TARGETS[via] === toolName
  return fromTool && matches ? via : 'yan mcp call'
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
  if (!mcpCallsAskInMode(mode)) return
  const described = await describeMcpTool(manager, serverId, toolName, signal)
  if (!mcpApprovalNeeded(described.annotations)) return
  const detail = `${serverId} / ${toolName}\n${JSON.stringify(params.arguments ?? params.args ?? {})}`
  if (detail.length > APPROVAL_DETAIL_MAX) throw new CapabilityCommandError('mcp_call_too_long', `MCP 调用参数有 ${detail.length} 字，超过 ${APPROVAL_DETAIL_MAX} 字，无法完整展示给用户确认。请缩短参数后重试`)
  const answer = await host.confirmDanger({
    tool: mcpCallLabel(serverId, toolName, params),
    detail,
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

    const rawArgs = params.arguments ?? params.args
    const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
    assertComputerUseArguments(serverId, toolName, args)
    if (action === 'call') await confirmMcpCall(host, manager, serverId, toolName, params, signal)

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
