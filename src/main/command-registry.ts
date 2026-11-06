import type { CommandDescriptor } from '../shared/ipc'
import { pick } from '../shared/ui-lang'

type RuntimeCommand = {
  name?: unknown
  description?: unknown
  source?: unknown
  location?: unknown
  module?: unknown
  usage?: unknown
  executable?: unknown
  availability?: unknown
}

const localCommands = (): readonly CommandDescriptor[] => [
  {
    name: 'login',
    description: pick('打开模型设置', 'Open model settings'),
    source: 'yan',
    executable: true,
    usage: '/login'
  },
  {
    name: 'new',
    description: pick('创建一个全局新会话', 'Create a new global session'),
    source: 'yan',
    executable: true,
    usage: '/new'
  },
  {
    name: 'compact',
    description: pick('压缩当前会话上下文', 'Compact the session context'),
    source: 'yan',
    executable: true,
    usage: '/compact'
  },
  {
    name: 'model',
    description: pick('打开模型选择与能力状态', 'Open model picker and capability status'),
    source: 'yan',
    executable: true,
    usage: '/model [provider/model]'
  },
  {
    name: 'browser',
    description: pick('打开内置浏览器，可选带 URL', 'Open the built-in browser, optionally with a URL'),
    source: 'yan',
    executable: true,
    usage: '/browser [url]'
  },
  { name: 'settings', description: pick('打开设置', 'Open settings'), source: 'yan', executable: true, usage: '/settings' },
  { name: 'ultracode', description: pick('本条消息用 Ultracode：分阶段并行派子 Agent 并复核（耗额度、耗时）', 'Use Ultracode for this message: phased parallel subagents with review (uses quota and time)'), source: 'yan', executable: true, usage: pick('/ultracode <任务>', '/ultracode <task>') },
  {
    name: 'thinking',
    description: pick('查看或设置思考档位', 'View or set the thinking level'),
    source: 'yan',
    executable: true,
    usage: pick('/thinking [档位]', '/thinking [level]')
  },
  {
    name: 'export',
    description: pick('导出当前会话（.jsonl 路由 JSONL，其余为 HTML）', 'Export the session (.jsonl as JSONL, otherwise HTML)'),
    source: 'yan',
    executable: true,
    usage: pick('/export [路径]', '/export [path]')
  },
  { name: 'tree', description: pick('浏览并切换当前会话的分支树', 'Browse and switch the session branch tree'), source: 'yan', executable: true, usage: '/tree' },
  { name: 'import', description: pick('导入并继续一个 JSONL 会话', 'Import and continue a JSONL session'), source: 'yan', executable: true, usage: pick('/import <路径>', '/import <path>') },
  { name: 'reload', description: pick('重新加载键位、扩展、技能、模板、主题与上下文文件', 'Reload keybindings, extensions, skills, templates, themes and context files'), source: 'yan', executable: true, usage: '/reload' },
  { name: 'scoped-models', description: pick('配置交互式切换所用的模型范围', 'Configure the model scope for interactive switching'), source: 'yan', executable: true, usage: '/scoped-models' },
  { name: 'trust', description: pick('保存当前项目的信任决定', 'Save the trust decision for this project'), source: 'yan', executable: true, usage: '/trust' },
  { name: 'share', description: pick('上传当前会话并取得查看链接', 'Upload the session and get a view link'), source: 'yan', executable: true, usage: '/share' },
  { name: 'copy', description: pick('复制最近一条回复', 'Copy the latest reply'), source: 'yan', executable: true, usage: '/copy' },
  { name: 'name', description: pick('重命名当前会话', 'Rename the session'), source: 'yan', executable: true, usage: pick('/name <名称>', '/name <name>') },
  { name: 'session', description: pick('查看当前会话信息', 'View session info'), source: 'yan', executable: true, usage: '/session' },
  { name: 'clone', description: pick('复制当前会话到新会话', 'Clone the session into a new one'), source: 'yan', executable: true, usage: '/clone' },
  ...(
    [
      ['fork', pick('在要分叉的那条消息上点「分叉」。', 'Click "Fork" on the message to fork from.')],
      ['resume', pick('在左栏选择要继续的会话。', 'Pick the session to continue in the sidebar.')],
      ['logout', pick('在设置的登录页管理各模型服务的登录状态。', 'Manage model service sign-ins on the sign-in page in Settings.')],
      ['hotkeys', pick('在设置 → 快捷键查看和修改键位；也可打开快捷键表。', 'View and edit keybindings in Settings > Shortcuts; the shortcut list also opens.')],
      ['changelog', pick('桌面端没有更新日志入口；版本信息在设置的关于页。', 'No changelog entry on desktop; version info is on the About page in Settings.')],
      ['bug', pick('请到设置的关于页打开项目主页反馈问题。', 'Report issues from the project page linked on the About page in Settings.')],
      ['quit', pick('直接关闭窗口即可。', 'Just close the window.')]
    ] as const
  ).map(
    ([name, availability]): CommandDescriptor => ({
      name,
      description: pick(`pi 终端命令（桌面端另有入口）`, `pi terminal command (desktop has its own entry)`),
      source: 'compatibility',
      executable: false,
      hiddenInMenu: true,
      usage: `/${name}`,
      availability
    })
  ),
  {
    name: 'subagent',
    description: pick('子 Agent由模型按任务需要自主调用', 'Subagents are called by the model as the task needs'),
    source: 'compatibility',
    executable: false,
    hiddenInMenu: true,
    usage: pick('/subagent <任务>', '/subagent <task>'),
    availability: pick('请直接描述任务；模型会在需要时调用子 Agent。', 'Just describe the task; the model calls subagents when needed.')
  },
  {
    name: 'panel',
    description: pick('终端面板命令（桌面端不适用）', 'Terminal panel command (not applicable on desktop)'),
    source: 'compatibility',
    executable: false,
    usage: '/panel',
    hiddenInMenu: true,
    availability: pick('仅终端界面有效；任务由砚内置任务计划维护，桌面端不会伪造无效果按钮', 'Terminal UI only; tasks are kept in the built-in task plan')
  },
  {
    name: 'footer',
    description: pick('终端底栏命令（桌面端仅兼容显示）', 'Terminal footer command (shown on desktop for compatibility only)'),
    source: 'compatibility',
    executable: false,
    usage: '/footer',
    availability: pick('仅终端界面有效；桌面端不会伪造无效果按钮', 'Terminal UI only')
  }
]

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function commandName(value: unknown): string | undefined {
  const name = text(value)?.replace(/^\/+/, '').trim()
  return name || undefined
}

function classifySource(raw: RuntimeCommand, name: string): CommandDescriptor['source'] {
  const source = text(raw.source)?.toLowerCase() ?? ''
  if (source.includes('compat')) return 'compatibility'
  if (source.includes('skill') || name.toLowerCase().startsWith('skill:')) return 'skill'
  if (source.includes('prompt') || source.includes('template')) return 'prompt'
  if (source.includes('extension') || source.includes('plugin')) return 'extension'
  if (source === 'yan' || source.includes('desktop')) return 'yan'
  return 'pi'
}

function normalizeRuntimeCommand(raw: RuntimeCommand): CommandDescriptor | null {
  const name = commandName(raw.name)
  if (!name || name.startsWith('__inkstone_native')) return null
  const source = classifySource(raw, name)
  const location = text(raw.location)
  const module = text(raw.module) ?? location
  const description = text(raw.description)
  const usage = text(raw.usage)
  const availability = text(raw.availability)
  return {
    name,
    ...(description ? { description } : {}),
    source,
    ...(location ? { location } : {}),
    ...(module ? { module } : {}),
    executable: raw.executable !== false && source !== 'compatibility',
    ...(usage ? { usage } : {}),
    ...(availability ? { availability } : {})
  }
}

export function localCommandDescriptors(): CommandDescriptor[] {
  return localCommands().map((command) => ({ ...command }))
}

export function mergeCommandDescriptors(runtime: unknown[] | undefined): CommandDescriptor[] {
  const result = localCommandDescriptors()
  const seen = new Set(result.map((command) => `${command.name}\0${command.source}\0${command.module ?? ''}`))
  for (const item of runtime ?? []) {
    const command = normalizeRuntimeCommand((item ?? {}) as RuntimeCommand)
    if (!command) continue
    const key = `${command.name}\0${command.source}\0${command.module ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(command)
  }
  return result
}
