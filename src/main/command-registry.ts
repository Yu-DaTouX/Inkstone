/**
 * Yan 命令注册表（N18）。
 *
 * pi 的 get_commands 只描述它自己发现的命令；桌面端还需要把本地路由、
 * 扩展/技能来源和“仅兼容显示”的终端命令统一成一个可审阅列表。
 * 这里不执行命令，只负责清洗和合并描述，真正的本地路由仍在 Composer。
 */
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
  {
    name: 'thinking',
    description: '查看或设置思考档位',
    source: 'yan',
    executable: true,
    usage: '/thinking [档位]'
  },
  { name: 'export', description: '导出当前会话为 HTML', source: 'yan', executable: true, usage: '/export' },
  { name: 'copy', description: '复制最近一条回复', source: 'yan', executable: true, usage: '/copy' },
  { name: 'name', description: '重命名当前会话', source: 'yan', executable: true, usage: '/name <名称>' },
  { name: 'session', description: '查看当前会话信息', source: 'yan', executable: true, usage: '/session' },
  { name: 'clone', description: '复制当前会话到新会话', source: 'yan', executable: true, usage: '/clone' },
  /*
   * pi 终端内置、桌面端换了入口的命令。pi RPC 的 get_commands 不报内置命令，
   * 不登记的话手打 `/tree` 会被当成消息发给模型。保留为 compatibility 并隐藏在补全外：
   * 手打时给出桌面端对应的入口，输入与附件原样保留。
   */
  ...(
    [
      ['tree', '桌面端没有会话树视图；在消息上点「分叉」回到某一轮。'],
      ['fork', '在要分叉的那条消息上点「分叉」。'],
      ['resume', '在左栏选择要继续的会话。'],
      ['import', '桌面端没有导入 JSONL 会话的入口。'],
      ['share', '桌面端不提供 gist 分享；可用 /export 导出后自行分享。'],
      ['scoped-models', '桌面端没有模型范围设置；Ctrl+P 在已发现的模型间切换。'],
      ['logout', '在设置的登录页管理各模型服务的登录状态。'],
      ['trust', '项目信任记录在 pi 的 trust.json 里；桌面端不提供命令入口，未信任的项目不加载项目级 .pi 资源。'],
      ['reload', '技能与扩展在新会话启动时重新加载；/ 菜单会自动刷新。'],
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
    /*
     * 实施-02 S4：从 `/` 补全里隐藏，但**不删这一项**。
     * 任务清单现在由砚内置任务计划维护（`yan tasks apply` + 宿主服务），
     * 终端面板命令在桌面端没有对应界面。保留在这里的目的是占住
     * source=compatibility 这个来源 —— 手打时命中它就会给明确反馈，
     * 而不是掉到「未知命令当消息发给模型」那条路上。
     */
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
  if (!name) return null
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

/** 始终可见的 Yan 内置命令；不依赖 pi 的 get_commands。 */
export function localCommandDescriptors(): CommandDescriptor[] {
  return LOCAL_COMMANDS.map((command) => ({ ...command }))
}

/**
 * 合并 pi/扩展发现结果与本地注册项。
 * 同名命令不被静默覆盖：source/module 会让用户分辨它们来自哪里；
 * 完全相同的重复项才去重，避免刷新时菜单出现双份同一条。
 */
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
