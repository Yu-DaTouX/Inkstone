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
    description: '打开模型接入设置',
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
  {
    name: 'subagent',
    description: '启动一个独立子代理任务',
    source: 'yan',
    executable: true,
    usage: '/subagent <任务> [--read-only]'
  },
  {
    name: 'panel',
    description: '终端面板命令（桌面端仅兼容显示）',
    source: 'compatibility',
    executable: false,
    usage: '/panel',
    availability: '仅终端界面有效；桌面端不会伪造无效果按钮'
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
