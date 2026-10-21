import type { Capability } from '../../shared/capabilities'
import { dedupeCapabilities } from '../../shared/capabilities'
import { mcpToolCapabilityId } from '../../shared/mcp'
import { skillsFromCommands, type RawSkillCommand, type SkillRecord } from './skill-service'

function builtin(
  id: string,
  title: string,
  description: string,
  effect: Capability['effect'],
  location: string
): Capability {
  return {
    id: `builtin:${id}`,
    kind: 'builtin',
    title,
    description,
    source: { owner: 'yan', location },
    availability: 'ready',
    effect
  }
}

export const BUILTIN_CAPABILITIES: readonly Capability[] = [
  builtin(
    'tasks.apply',
    '任务计划',
    '登记 / 更新本会话的待办清单，把多步工作变成用户可见的进度（六种操作：set/add/complete/uncomplete/remove/clear）；会话里有 todos 工具时优先用工具，这个命令是兼容入口。',
    'write',
    'yan tasks apply --request-file <file>'
  ),
  builtin(
    'subagent.start',
    '委派子代理',
    '指定模型执行独立子任务并返回结果；默认当前文件夹，代码任务可显式选择 worktree 隔离。',
    'external-action',
    'yan subagent start --task <text> --model <provider/model>'
  ),
  builtin(
    'subagent.list',
    '子代理列表',
    '列出当前所有子代理及其状态与耗时。',
    'read',
    'yan subagent list'
  ),
  builtin(
    'subagent.get',
    '子代理转录',
    '读取某个子代理的转录与活动，用于审阅它做了什么。',
    'read',
    'yan subagent get --id <id>'
  ),
  builtin(
    'subagent.send',
    '向子代理追加信息',
    '向本会话派出的子代理发信息：运行中用于补充或纠偏（默认当前工具结束后送达，follow-up 等它做完原任务）；已结束的按原会话续接，记得之前的工作。',
    'external-action',
    'yan subagent send --id <id> --message <text> [--mode steer|follow-up]'
  ),
  builtin(
    'subagent.stop',
    '停止子代理',
    '停止一个正在运行的子代理（其工作树改动保留，由用户决定合并或放弃）。',
    'external-action',
    'yan subagent stop --id <id>'
  ),
  builtin(
    'browser',
    '内置浏览器自动化',
    '在内置浏览器里导航 / 观察页面 / 点击 / 输入 / 截图等（含标签页、下载与接入本机 Chrome）；\n' +
      '        用 `yan browser --help` 或 `yan browser <动作> --help` 查参数。注意文件与网络边界由宿主执行，不是任意脚本。',
    'external-action',
    'yan browser --help'
  ),
  builtin(
    'operations.status',
    '操作状态查询',
    '按操作 ID 取回之前一次命令的完整结果文件（stdout 只有摘要，细节在这里）。',
    'read',
    'yan operations status --id <id>'
  )
]

export interface CatalogBuildResult {
  capabilities: Capability[]
  skills: SkillRecord[]
  conflicts: string[]
}

export function buildCatalog(
  commands: readonly RawSkillCommand[],
  mcpTools: readonly McpCatalogEntry[] = []
): CatalogBuildResult {
  const skills = skillsFromCommands(commands)
  const merged = [
    ...BUILTIN_CAPABILITIES,
    ...skills.map((record) => record.capability),
    ...mcpTools.map(mcpToolCapability)
  ]
  const { capabilities, conflicts } = dedupeCapabilities(merged)
  return { capabilities, skills, conflicts }
}

export type McpCatalogEntry = {
  serverId: string
  toolName: string
  description?: string
  schemaRevision?: string
  effect?: Capability['effect']
  availability?: Capability['availability']
  owner?: Capability['source']['owner']
  projectScope?: string
}

export function mcpToolCapability(entry: McpCatalogEntry): Capability {
  const described = entry.description?.trim() ?? ''
  const origin = `MCP 服务 ${entry.serverId} 的工具 ${entry.toolName}`
  return {
    id: mcpToolCapabilityId(entry.serverId, entry.toolName),
    kind: 'mcp-tool',
    title: `${entry.serverId} · ${entry.toolName}`,
    description:
      described.length > 0
        ? `${described}（${origin}）`
        : `${origin}（服务未给描述；用 yan mcp describe 看参数）`,
    ...(entry.schemaRevision ? { schemaRevision: entry.schemaRevision } : {}),
    source: {
      owner: entry.owner ?? 'user',
      location: `yan mcp describe --server ${entry.serverId} --tool ${entry.toolName}`
    },
    availability: entry.availability ?? 'ready',
    effect: entry.effect ?? 'unknown',
    ...(entry.projectScope ? { projectScope: entry.projectScope } : {})
  }
}
