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
    'yan subagent start --task <text> --model <provider/model> [--thinking low|medium|high]'
  ),
  builtin(
    'subagent.list',
    '子代理列表',
    '列出本会话派出的子代理及其状态与耗时（不含其他会话派出的）。',
    'read',
    'yan subagent list'
  ),
  builtin(
    'subagent.get',
    '子代理结果',
    '读取某个子代理当前的状态、最终消息与改动文件；默认不含完整转录，要完整过程加 --transcript。',
    'read',
    'yan subagent get --id <id> [--final]'
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
    '停止一个正在运行的子代理；用 worktree 隔离时改动保留在工作树里，由用户决定合并或放弃，其他隔离方式直接停止、不额外保留改动。',
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
    '传 --id 查某一次操作的完整结果（stdout 只有摘要，细节在这里），找不到会报错；不传 id 则列出最近若干次操作。',
    'read',
    'yan operations status --id <id>'
  ),
  builtin(
    'capabilities',
    '能力目录检索与接入',
    '在可用能力目录里检索（search / discover），为候选生成接入计划（prepare），再按用户批准接入（acquire）。',
    'external-action',
    'yan capabilities search --query-file query.json'
  ),
  builtin(
    'skill',
    '技能读取与保存',
    '读取当前已加载技能的正文（read）；把整理好的做法保存成「我的技能」（save）。',
    'write',
    'yan skill read --id <技能ID>'
  ),
  builtin(
    'mcp',
    'MCP 服务',
    '列出已登记的 MCP 服务、查看某个工具的参数（describe），或调用工具（call）。',
    'unknown',
    'yan mcp list'
  ),
  builtin(
    'search',
    '联网搜索与读页',
    '联网搜索（可限定近期 / 站点）、读网页正文、查开发文档库；搜索后端是否可用用 `yan search doctor` 诊断。',
    'external-action',
    'yan search --help'
  ),
  builtin(
    'schedule',
    '定时任务',
    '新建、列出、暂停或删除定时任务；新建后要用户在「定时任务」页确认过才会运行。',
    'external-action',
    'yan schedule list'
  ),
  builtin(
    'consent',
    '征求用户同意',
    '需要用户明确同意的操作先问一次，说清能力、操作、资源与用途。',
    'external-action',
    'yan consent request --capability <能力> --action <操作>'
  ),
  builtin(
    'session',
    '移动会话到别的文件夹',
    '任务属于另一个文件夹时，请用户批准把这个会话移过去。',
    'write',
    'yan session move --dir <文件夹>'
  ),
  builtin(
    'artifact',
    '附加产物到会话',
    '把项目内的文件作为产物附到会话里，让用户直接看到结果文件。',
    'write',
    'yan artifact attach --path <项目内文件>'
  ),
  builtin(
    'image',
    '生成图片',
    '用设置里配置的图片服务商生成图片，也可启动 / 停止 / 查询本地 ComfyUI。',
    'external-action',
    'yan image generate --request-file image.json'
  ),
  builtin(
    'office',
    '读取 Office 与 PDF',
    '读取 .docx / .xlsx / .pptx / .pdf 里的文字内容。',
    'read',
    'yan office read --path <文件>'
  ),
  builtin(
    'file',
    '删除到回收站',
    '删除文件或目录改为移到系统回收站，用户可以从回收站恢复。',
    'write',
    'yan file trash --path <文件或目录>'
  ),
  builtin(
    'question',
    '向用户提问',
    '向用户提一个或几个问题并等回答；会话里有 question 工具时优先用工具，这个命令是兼容入口。',
    'external-action',
    'yan question ask --request-file question.json'
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
