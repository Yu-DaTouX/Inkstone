/**
 * 一组连续工具调用的一行摘要（对话里按发生顺序穿插在文字之间）。
 *
 * 写法是「已搜索 3 次, 已读取 2 个文件 … 以及另外 4 项操作」：按类别数一遍，最多点名
 * 前两类，其余归入「另外 N 项」，失败数跟在后面。纯函数，不读调用详情，不重跑工具。
 */
import type { UIToolCall } from '../../../../shared/ipc'

type Kind = 'read' | 'search' | 'fetch' | 'run' | 'edit' | 'other'

const NAMES: Record<string, Kind> = {
  read: 'read', view: 'read', cat: 'read', open: 'read',
  grep: 'search', glob: 'search', find: 'search', ls: 'search', search: 'search', web_search: 'search',
  fetch: 'fetch', web_fetch: 'fetch', webfetch: 'fetch', browse: 'fetch',
  bash: 'run', powershell: 'run', shell: 'run', run: 'run', exec: 'run', codemode: 'run',
  edit: 'edit', write: 'edit', multi_edit: 'edit', multiedit: 'edit', apply_patch: 'edit', patch: 'edit'
}

export function toolKind(name: string): Kind {
  return NAMES[name.toLowerCase()] ?? 'other'
}

const ZH: Record<Exclude<Kind, 'other'>, (n: number) => string> = {
  read: (n) => `已读取 ${n} 个文件`,
  search: (n) => `已搜索 ${n} 次`,
  fetch: (n) => `已获取 ${n} 个页面`,
  run: (n) => `已运行 ${n} 个命令`,
  edit: (n) => `已编辑 ${n} 个文件`
}
const EN: Record<Exclude<Kind, 'other'>, (n: number) => string> = {
  read: (n) => `Read ${n} ${n === 1 ? 'file' : 'files'}`,
  search: (n) => `Searched ${n} ${n === 1 ? 'time' : 'times'}`,
  fetch: (n) => `Fetched ${n} ${n === 1 ? 'page' : 'pages'}`,
  run: (n) => `Ran ${n} ${n === 1 ? 'command' : 'commands'}`,
  edit: (n) => `Edited ${n} ${n === 1 ? 'file' : 'files'}`
}

/** 一步的目标文字（命令 / 文件名 / 查询词等）：步骤行与过程行的运行标签共用 */
export function summarize(call: UIToolCall): string {
  const a = call.args as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') return ''
  if (typeof a.command === 'string') return a.command
  if (typeof a.code === 'string') return a.code.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  if (typeof a.file_path === 'string') return a.file_path.split(/[\\/]/).pop() || a.file_path
  if (typeof a.path === 'string') return a.path.split(/[\\/]/).pop() || a.path
  if (typeof a.pattern === 'string') return a.pattern
  if (typeof a.query === 'string') return a.query
  if (typeof a.url === 'string') return a.url
  const keys = Object.keys(a)
  return keys.length ? keys.slice(0, 3).join(', ') : ''
}

export function toolGroupLabel(tools: readonly Pick<UIToolCall, 'name' | 'status' | 'cancelled'>[], zh: boolean): string {
  const counts = new Map<Kind, number>()
  for (const call of tools) counts.set(toolKind(call.name), (counts.get(toolKind(call.name)) ?? 0) + 1)
  const named = [...counts.entries()].filter(([kind]) => kind !== 'other').slice(0, 2)
  const namedTotal = named.reduce((sum, [, n]) => sum + n, 0)
  const rest = tools.length - namedTotal
  const words = zh ? ZH : EN
  const parts = named.map(([kind, n]) => words[kind as Exclude<Kind, 'other'>](n))
  if (!parts.length) return zh ? `${tools.length} 项操作` : `${tools.length} ${tools.length === 1 ? 'action' : 'actions'}`
  const head = parts.join(', ')
  if (rest <= 0) return head
  return zh ? `${head}… 以及另外 ${rest} 项操作` : `${head}… and ${rest} more ${rest === 1 ? 'action' : 'actions'}`
}
