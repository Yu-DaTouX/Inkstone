import type { UIMessage, UIMessageImage, UIToolCall } from './ipc'

export type ToolItemKind = 'bash' | 'file-change' | 'mcp' | 'subagent' | 'question' | 'todos' | 'tool'

export type SessionItemStatus = 'running' | 'ok' | 'error' | 'cancelled'

interface SessionItemBase {
  id: string
  turnId: string
  messageId: string
  entryId?: string
  timestamp?: number
}

export interface UserItem extends SessionItemBase {
  kind: 'user'
  text: string
  images?: UIMessageImage[]
}

export interface AssistantTextItem extends SessionItemBase {
  kind: 'assistant-text'
  step: number
  block: number
  text: string
}

export interface ReasoningItem extends SessionItemBase {
  kind: 'reasoning'
  step: number
  block: number
  text: string
  durationMs?: number
  live?: boolean
}

export interface ToolItem extends SessionItemBase {
  kind: 'tool'
  tool: ToolItemKind
  step: number
  status: SessionItemStatus
  call: UIToolCall
}

export interface ShellItem extends SessionItemBase {
  kind: 'shell'
  command: string
  exitCode: number | null
  cancelled: boolean
  call?: UIToolCall
}

export interface NoteItem extends SessionItemBase {
  kind: 'note'
  note: NonNullable<UIMessage['note']>
  text: string
  images?: UIMessageImage[]
}

export interface StatusItem extends SessionItemBase {
  kind: 'status'
  step: number
  status: 'error'
  text: string
}

export type SessionItem =
  | UserItem
  | AssistantTextItem
  | ReasoningItem
  | ToolItem
  | ShellItem
  | NoteItem
  | StatusItem

export const PRELUDE_TURN_ID = 'prelude'

export function assistantBlockId(turnId: string, step: number, block: number): string {
  return `${turnId}:${step}:${block}`
}

export function statusItemId(turnId: string, step: number): string {
  return `${turnId}:${step}:status`
}

const FILE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'multiedit', 'apply_patch', 'notebook_edit'])
const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell'])
const SUBAGENT_TOOLS = new Set(['subagent', 'task', 'agent'])

export function toolItemKind(name: string): ToolItemKind {
  const lower = name.toLowerCase()
  if (SHELL_TOOLS.has(lower)) return 'bash'
  if (FILE_TOOLS.has(lower)) return 'file-change'
  if (lower.startsWith('mcp__') || lower === 'mcp') return 'mcp'
  if (SUBAGENT_TOOLS.has(lower)) return 'subagent'
  if (lower === 'question') return 'question'
  if (lower === 'todos') return 'todos'
  return 'tool'
}

export function toolItemStatus(call: Pick<UIToolCall, 'status' | 'cancelled'>): SessionItemStatus {
  if (call.cancelled) return 'cancelled'
  if (call.status === 'pending') return 'running'
  return call.status
}
