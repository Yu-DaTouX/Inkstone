/**
 * 能力目录组装（实施-04 §3 / §4）。
 *
 * 目录 = **内置能力清单**（砚随包提供的 `yan` 命令族）+ **pi 实际加载的 Skill**。
 *
 * 为什么内置能力要写成静态清单，而不是从 `KNOWN_COMMANDS` 反射出来：
 * 命令名（`tasks.apply`）对模型没有可读性，而目录存在的意义就是让模型
 * 「按目标挑能力」。清单里每条都要有**适用目标**，否则 `isUsableCapability`
 * 会把它挡在候选外 —— 这是刻意的：没有描述的能力等于不可发现。
 *
 * 这里**不**碰磁盘、不碰 RPC，输入就是 pi 的命令列表 —— 便于单测直接构造。
 */
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

/**
 * 砚随包能力。`location` 写的是模型要敲的那条 `yan` 命令形状 ——
 * 目录给出的建议要能**直接执行**，不然模型还得再猜一次语法。
 */
export const BUILTIN_CAPABILITIES: readonly Capability[] = [
  builtin(
    'tasks.apply',
    '任务计划',
    '登记 / 更新本会话的任务清单，把多步工作变成用户可见的进度（六种操作：set/add/complete/uncomplete/remove/clear）。',
    'write',
    'yan tasks apply --request-file <file>'
  ),
  builtin(
    'goal.ready',
    '目标就绪',
    '澄清已足够时提交目标就绪报告，触发从澄清档切到标准档开始执行（需要五栏齐全）。',
    'write',
    'yan goal ready --request-file <file>'
  ),
  builtin(
    'goal.report',
    '目标进度报告',
    '报告目标的执行进度（completed / blocked / stopped 三类结果，completed 必须带证据）。',
    'write',
    'yan goal report --request-file <file>'
  ),
  builtin(
    'goal.status',
    '目标状态查询',
    '只读查询当前会话的目标阶段与待办，用于判断是否该继续还是先澄清。',
    'read',
    'yan goal status'
  ),
  builtin(
    'knowledge.search',
    '项目知识检索',
    '在本项目已确认的知识里检索（中文关键词可用），得到带来源的条目。',
    'read',
    'yan knowledge search --query-file <file>'
  ),
  builtin(
    'knowledge.read',
    '项目知识读取',
    '按 id 读取一条项目知识的完整正文与来源，用于核对细节。',
    'read',
    'yan knowledge read --id <id>'
  ),
  builtin(
    'knowledge.propose',
    '项目知识提议',
    '把本次得到的新事实提议为**待确认**条目（不会直接生效，要用户确认）。',
    'write',
    'yan knowledge propose --request-file <file>'
  ),
  builtin(
    'subagent.start',
    '委派子代理',
    '把一段独立任务交给子代理在隔离工作树里做，返回子代理 ID；适合互不冲突的并行工作。',
    'external-action',
    'yan subagent start --task <text>'
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
    'subagent.stop',
    '停止子代理',
    '停止一个正在运行的子代理（其工作树改动保留，由用户决定合并或放弃）。',
    'external-action',
    'yan subagent stop --id <id>'
  ),
  builtin(
    'browser',
    '内置浏览器自动化',
    '在内置浏览器里导航 / 观察页面 / 点击 / 输入 / 截图等（19 个动作，含标签页与下载）；\n' +
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
  /** 同名但来源不同的能力 ID（实施-04 §6：冲突要提示，不能静默合并）。 */
  conflicts: string[]
}

/** 组装目录：内置清单 + pi 已加载技能，并按 ID 去重。 */
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

/**
 * MCP 工具进目录的输入。
 *
 * 为什么不让目录自己去连服务：目录是**纯函数**（不碰磁盘、不碰 RPC），
 * 单测才能直接构造输入。连服务那一步在宿主（`collectMcpCatalog`）做完再传进来。
 */
export type McpCatalogEntry = {
  serverId: string
  toolName: string
  description?: string
  schemaRevision?: string
  /** 服务自报的 readOnlyHint **不是**安全边界（§4），所以默认 `unknown`。 */
  effect?: Capability['effect']
  availability?: Capability['availability']
  owner?: Capability['source']['owner']
  projectScope?: string
}

/**
 * 把一条 MCP 工具投影成能力。
 *
 * 描述里**总是**补上「哪个服务的哪个工具」：服务给的描述可能很短
 * （`isUsableCapability` 只要求 ≥ 4 字符），而模型判断相关性靠的就是这段文字。
 * 服务没给描述时也不能留空 —— 留空等于这条能力不可发现。
 */
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
      /* location 写成**能直接执行**的命令形状（与内置能力一致）。 */
      location: `yan mcp describe --server ${entry.serverId} --tool ${entry.toolName}`
    },
    availability: entry.availability ?? 'ready',
    effect: entry.effect ?? 'unknown',
    ...(entry.projectScope ? { projectScope: entry.projectScope } : {})
  }
}
