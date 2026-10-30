export type CommandGroupId = 'action' | 'session' | 'message' | 'file' | 'content' | 'help'

export const COMMAND_GROUP_ORDER: readonly CommandGroupId[] = ['action', 'session']

export const PALETTE_GROUP_ORDER: readonly CommandGroupId[] = ['action', 'session', 'message', 'file', 'content', 'help']

export const COMMAND_ACTION_IDS = {
  newSession: 'newSession',
  focusSearch: 'focusSearch',
  toggleSidebar: 'toggleSidebar',
  toggleWorkspace: 'toggleWorkspace',
  toggleTheme: 'toggleTheme',
  openSettings: 'openSettings',
  stopSession: 'stopSession',
  workspaceChanges: 'workspaceChanges',
  workspaceTerminal: 'workspaceTerminal',
  workspaceFiles: 'workspaceFiles',
  workspaceBrowser: 'workspaceBrowser',
  workspacePreview: 'workspacePreview',
  settingsUsage: 'settingsUsage'
} as const

export type CommandActionId = (typeof COMMAND_ACTION_IDS)[keyof typeof COMMAND_ACTION_IDS]

export type CommandPrefix = '>' | '@' | '#' | '/' | '%' | '?'

export const COMMAND_PREFIXES: readonly CommandPrefix[] = ['>', '@', '#', '/', '%', '?']

export type PaletteMode = 'default' | 'action' | 'session' | 'message' | 'file' | 'content' | 'help'

export interface ParsedPaletteQuery {
  mode: PaletteMode
  term: string
}

const FULLWIDTH_PREFIXES: Readonly<Record<string, CommandPrefix>> = {
  '》': '>',
  '＞': '>',
  '＠': '@',
  '＃': '#',
  '／': '/',
  '％': '%',
  '？': '?'
}

export function parsePaletteQuery(query: string): ParsedPaletteQuery {
  const first = query.slice(0, 1)
  const head = FULLWIDTH_PREFIXES[first] ?? first
  const rest = query.slice(1).replace(/^\s+/, '')
  switch (head) {
    case '>':
      return { mode: 'action', term: rest }
    case '@':
      return { mode: 'session', term: rest }
    case '#':
      return { mode: 'message', term: rest }
    case '/':
      return { mode: 'file', term: rest }
    case '%':
      return { mode: 'content', term: rest }
    case '?':
      return { mode: 'help', term: rest }
    default:
      return { mode: 'default', term: query }
  }
}

export interface CommandItem {
  id: string
  group: CommandGroupId
  label: string
  keywords: string
  shortcut?: readonly string[]
  disabled?: boolean
  reason?: string
  sessionPath?: string
  messageId?: string
  helpPrefix?: CommandPrefix
  meta?: string
  filePath?: string
  line?: number
  column?: number
}

export function commandTokens(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 6)
}

export function commandMatchScore(item: CommandItem, tokens: readonly string[]): number | null {
  if (!tokens.length) return 0
  const label = item.label.toLowerCase()
  if (!tokens.every((token) => label.includes(token) || item.keywords.includes(token))) return null
  if (label.startsWith(tokens[0])) return 0
  if (label.includes(tokens[0])) return 1
  return 2
}

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

export function groupCommands(
  items: readonly CommandItem[],
  order: readonly CommandGroupId[] = COMMAND_GROUP_ORDER
): CommandGroup[] {
  return order
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter((section) => section.items.length > 0)
}

export function limitCommands(items: readonly CommandItem[], sessionLimit: number): CommandItem[] {
  return limitCommandGroup(items, 'session', sessionLimit)
}

export function commandsInGroups(items: readonly CommandItem[], groups: readonly CommandGroupId[]): CommandItem[] {
  const wanted = new Set(groups)
  return items.filter((item) => wanted.has(item.group))
}

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

export function messageSnippet(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1))}…`
}

export function navigableCommands(items: readonly CommandItem[]): CommandItem[] {
  return items.filter((item) => !item.disabled)
}

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
