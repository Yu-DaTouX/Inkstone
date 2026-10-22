import type { CommandDescriptor } from '../shared/ipc'

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

const LOCAL_COMMANDS: readonly CommandDescriptor[] = [
  {
    name: 'login',
    description: '打开模型设置',
    source: 'yan',
    executable: true,
    usage: '/login'
  },
  {
    name: 'new',
    description: '创建一个全局新会话',
    source: 'yan',
    executable: true,
    usage: '/new'
  },
  {
    name: 'compact',
    description: '压缩当前会话上下文',
    source: 'yan',
    executable: true,
    usage: '/compact'
  },
  {
    name: 'model',
    description: '打开模型选择与能力状态',
    source: 'yan',
    executable: true,
    usage: '/model [provider/model]'
  },
  {
    name: 'browser',
    description: '打开内置浏览器，可选带 URL',
    source: 'yan',
    executable: true,
    usage: '/browser [url]'
  },
  { name: 'settings', description: '打开设置', source: 'yan', executable: true, usage: '/settings' },
  { name: 'ultracode', description: '本条消息用 Ultracode：分阶段并行派子 Agent 并复核（耗额度、耗时）', source: 'yan', executable: true, usage: '/ultracode <任务>' },
  {
    name: 'thinking',
    description: '查看或设置思考档位',
    source: 'yan',
    executable: true,
    usage: '/thinking [档位]'
  },
  {
    name: 'export',
    description: '导出当前会话（.jsonl 路由 JSONL，其余为 HTML）',
    source: 'yan',
    executable: true,
    usage: '/export [路径]'
  },
  { name: 'tree', description: '浏览并切换当前会话的分支树', source: 'yan', executable: true, usage: '/tree' },
  { name: 'import', description: '导入并继续一个 JSONL 会话', source: 'yan', executable: true, usage: '/import <路径>' },
  { name: 'reload', description: '重新加载键位、扩展、技能、模板、主题与上下文文件', source: 'yan', executable: true, usage: '/reload' },
  { name: 'scoped-models', description: '配置交互式切换所用的模型范围', source: 'yan', executable: true, usage: '/scoped-models' },
  { name: 'trust', description: '保存当前项目的信任决定', source: 'yan', executable: true, usage: '/trust' },
  { name: 'share', description: '上传当前会话并取得查看链接', source: 'yan', executable: true, usage: '/share' },
  { name: 'copy', description: '复制最近一条回复', source: 'yan', executable: true, usage: '/copy' },
  { name: 'name', description: '重命名当前会话', source: 'yan', executable: true, usage: '/name <名称>' },
  { name: 'session', description: '查看当前会话信息', source: 'yan', executable: true, usage: '/session' },
  { name: 'clone', description: '复制当前会话到新会话', source: 'yan', executable: true, usage: '/clone' },
  ...(
    [
      ['fork', '在要分叉的那条消息上点「分叉」。'],
      ['resume', '在左栏选择要继续的会话。'],
      ['logout', '在设置的登录页管理各模型服务的登录状态。'],
      ['hotkeys', '桌面端没有快捷键总表；按钮悬停提示里标有快捷键。'],
      ['changelog', '桌面端没有更新日志入口；版本信息在设置的关于页。'],
      ['bug', '请到设置的关于页打开项目主页反馈问题。'],
      ['quit', '直接关闭窗口即可。']
    ] as const
  ).map(
    ([name, availability]): CommandDescriptor => ({
      name,
      description: `pi 终端命令（桌面端另有入口）`,
      source: 'compatibility',
      executable: false,
      hiddenInMenu: true,
      usage: `/${name}`,
      availability
    })
  ),
  {
    name: 'subagent',
    description: '子代理由模型按任务需要自主调用',
    source: 'compatibility',
    executable: false,
    hiddenInMenu: true,
    usage: '/subagent <任务>',
    availability: '请直接描述任务；模型会在需要时调用子代理。'
  },
  {
    name: 'panel',
    description: '终端面板命令（桌面端不适用）',
    source: 'compatibility',
    executable: false,
    usage: '/panel',
    hiddenInMenu: true,
    availability: '仅终端界面有效；任务由砚内置任务计划维护，桌面端不会伪造无效果按钮'
  },
  {
    name: 'footer',
    description: '终端底栏命令（桌面端仅兼容显示）',
    source: 'compatibility',
    executable: false,
    usage: '/footer',
    availability: '仅终端界面有效；桌面端不会伪造无效果按钮'
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
  return LOCAL_COMMANDS.map((command) => ({ ...command }))
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
