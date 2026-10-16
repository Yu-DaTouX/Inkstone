/**
 * 命令面板的纯逻辑：命令项描述、前缀模式、搜索过滤、排序与分组。
 *
 * 为什么单独一份、不放在组件里：前缀解析 / 过滤 / 排序 / 分组 / Enter 组字判定都是纯函数，
 * 可以在 Node（esbuild 编译后）里直接钉死，不必启动 Electron、不碰 store。
 * 组件只负责画、绑键盘、调正式 store 动作。
 *
 * 这里**不读 store、不 import React**：入参全是普通数据，便于 `scripts/test-v3-command-items.mjs`
 * 与 `scripts/test-v3-shortcuts.mjs` 在隔离环境里验证。
 */

/** 面板里的分组；顺序即渲染顺序。 */
export type CommandGroupId = 'action' | 'session' | 'message' | 'help'

/** 旧默认顺序（动作 → 会话）；`limitCommands` 与既有单测按这个口径，保持不动。 */
export const COMMAND_GROUP_ORDER: readonly CommandGroupId[] = ['action', 'session']

/** 面板实际渲染顺序（含 `#` 消息与 `?` 帮助两个前缀模式新增的组）。 */
export const PALETTE_GROUP_ORDER: readonly CommandGroupId[] = ['action', 'session', 'message', 'help']

/** v3 当前**确能执行**的动作 ID；没迁移、没入口的动作不在这里出现。 */
export const COMMAND_ACTION_IDS = {
  newSession: 'newSession',
  focusSearch: 'focusSearch',
  toggleSidebar: 'toggleSidebar',
  toggleWorkspace: 'toggleWorkspace',
  toggleTheme: 'toggleTheme',
  openRuns: 'openRuns',
  openSettings: 'openSettings',
  openSideBySide: 'openSideBySide',
  stopSession: 'stopSession',
  workspaceChanges: 'workspaceChanges',
  workspaceTerminal: 'workspaceTerminal',
  workspaceFiles: 'workspaceFiles',
  workspaceBrowser: 'workspaceBrowser',
  workspacePreview: 'workspacePreview',
  settingsAppearance: 'settingsAppearance',
  settingsModels: 'settingsModels',
  settingsCapabilities: 'settingsCapabilities',
  settingsUsage: 'settingsUsage'
} as const

export type CommandActionId = (typeof COMMAND_ACTION_IDS)[keyof typeof COMMAND_ACTION_IDS]

/** 命令面板的前缀模式（02 §13.1）：`>` 操作、`@` 会话、`#` 当前会话消息、`?` 帮助。 */
export type CommandPrefix = '>' | '@' | '#' | '?'

export const COMMAND_PREFIXES: readonly CommandPrefix[] = ['>', '@', '#', '?']

export type PaletteMode = 'default' | 'action' | 'session' | 'message' | 'help'

export interface ParsedPaletteQuery {
  /** 没写前缀就是默认混合模式。 */
  mode: PaletteMode
  /** 去掉前缀与紧随空白后的检索词；默认模式就是原查询。 */
  term: string
}

/** 首字符是前缀就进入对应模式；否则默认模式。前缀后允许跟空白，如 `@ 登录`。 */
export function parsePaletteQuery(query: string): ParsedPaletteQuery {
  const head = query.slice(0, 1)
  const rest = query.slice(1).replace(/^\s+/, '')
  switch (head) {
    case '>':
      return { mode: 'action', term: rest }
    case '@':
      return { mode: 'session', term: rest }
    case '#':
      return { mode: 'message', term: rest }
    case '?':
      return { mode: 'help', term: rest }
    default:
      return { mode: 'default', term: query }
  }
}

export interface CommandItem {
  /** 全局唯一；动作是动作 ID，会话是 `session:<path>`。 */
  id: string
  group: CommandGroupId
  /** 已翻译的显示名。 */
  label: string
  /** 参与搜索但不显示的补充词（英文名 / 路径 / 项目名等）。 */
  keywords: string
  /** 已确认实际绑定的快捷键；没接的键不写，免得标了却按不出来。 */
  shortcut?: readonly string[]
  /** 不可用：整行置灰、Enter 不执行。 */
  disabled?: boolean
  /** 不可用原因（已翻译），显示在行尾。 */
  reason?: string
  /** 会话命令的跳转目标（`switchSession` 的 path）。 */
  sessionPath?: string
  /** 消息命令要定位的消息 id（`store.locateMessage`）。 */
  messageId?: string
  /** 帮助命令选中后把面板查询改成这个前缀。 */
  helpPrefix?: CommandPrefix
  /** 行右侧的次要信息（项目 / 目录）。 */
  meta?: string
}

/** 把查询拆成去重后的小写词；全部出现才算命中（与会话切换器同一口径）。 */
export function commandTokens(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 6)
}

/**
 * 命中返回排序分（越小越靠前），没命中返回 `null`。
 *
 * 0 = 标题以第一个词开头；1 = 标题包含第一个词；2 = 只在补充词里命中。
 * 多词时要求每个词都出现在「标题 + 补充词」里，避免只匹配其中一个词。
 */
export function commandMatchScore(item: CommandItem, tokens: readonly string[]): number | null {
  if (!tokens.length) return 0
  const label = item.label.toLowerCase()
  const haystack = `${item.label}\n${item.keywords}`.toLowerCase()
  if (!tokens.every((token) => haystack.includes(token))) return null
  if (label.startsWith(tokens[0])) return 0
  if (label.includes(tokens[0])) return 1
  return 2
}

/**
 * 过滤 + 排序。分数相同保持输入顺序（稳定排序）——会话按最近活动排好后传入，
 * 结果就不会因为分数相同被打乱。
 */
export function rankCommands(items: readonly CommandItem[], query: string): CommandItem[] {
  const tokens = commandTokens(query)
  const ranked: { item: CommandItem; score: number; order: number }[] = []
  items.forEach((item, order) => {
    const score = commandMatchScore(item, tokens)
    if (score === null) return
    ranked.push({ item, score, order })
  })
  ranked.sort((a, b) => a.score - b.score || a.order - b.order)
  return ranked.map((entry) => entry.item)
}

export interface CommandGroup {
  group: CommandGroupId
  items: CommandItem[]
}

/** 按固定顺序分组，空组不出现（面板不画空标题）。 */
export function groupCommands(
  items: readonly CommandItem[],
  order: readonly CommandGroupId[] = COMMAND_GROUP_ORDER
): CommandGroup[] {
  return order
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter((section) => section.items.length > 0)
}

/** 限制会话结果条数：动作全留，会话最多 `limit` 条（已排序，截前 N 条即最相关）。 */
export function limitCommands(items: readonly CommandItem[], sessionLimit: number): CommandItem[] {
  return limitCommandGroup(items, 'session', sessionLimit)
}

/** 只保留指定分组的项（前缀模式各取一组，互不混入）。 */
export function commandsInGroups(items: readonly CommandItem[], groups: readonly CommandGroupId[]): CommandItem[] {
  const wanted = new Set(groups)
  return items.filter((item) => wanted.has(item.group))
}

/** 限制某个分组的结果条数（`#` 消息等），其余分组原样保留。 */
export function limitCommandGroup(
  items: readonly CommandItem[],
  group: CommandGroupId,
  limit: number
): CommandItem[] {
  if (limit < 0) return [...items]
  let seen = 0
  return items.filter((item) => {
    if (item.group !== group) return true
    if (seen >= limit) return false
    seen += 1
    return true
  })
}

/** 消息行标题用的短摘（压平空白并截断，不发全文）。 */
export function messageSnippet(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1))}…`
}

/** 键盘导航用的平铺项：跳过禁用行（置灰行不抢上下键与 Enter）。 */
export function navigableCommands(items: readonly CommandItem[]): CommandItem[] {
  return items.filter((item) => !item.disabled)
}

/**
 * IME 组字时的 Enter 不能当执行：组字过程中 keydown 也报 `Enter`，
 * 且 `isComposing` 为 true（部分输入法只给 `keyCode === 229`）。
 * 这是纯函数，方便在 Node 里钉死。
 */
export function shouldExecuteOnEnter(event: {
  key: string
  isComposing?: boolean
  keyCode?: number
}): boolean {
  if (event.key !== 'Enter') return false
  if (event.isComposing) return false
  if (event.keyCode === 229) return false
  return true
}
