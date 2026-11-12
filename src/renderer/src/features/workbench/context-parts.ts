import type { MessageKey } from '../../i18n'
import type { ContextPartId } from './context-pane-view'

export type ContextRowId = ContextPartId | 'buffer' | 'free'

const LABEL: Record<ContextRowId, MessageKey> = {
  system: 'ctx.cat.system',
  user: 'ctx.cat.user',
  assistant: 'ctx.cat.assistant',
  thinking: 'ctx.cat.thinking',
  tools: 'ctx.cat.tools',
  prompt: 'ctx.cat.prompt',
  builtin: 'ctx.cat.builtin',
  mcp: 'ctx.cat.mcp',
  skills: 'ctx.cat.skills',
  mcpInfo: 'ctx.cat.mcpInfo',
  memory: 'ctx.cat.memory',
  summary: 'ctx.cat.summary',
  buffer: 'ctx.cat.buffer',
  free: 'ctx.cat.free'
}

const HINT: Partial<Record<ContextRowId, MessageKey>> = {
  skills: 'ctx.hint.skills',
  mcpInfo: 'ctx.hint.mcpInfo',
  memory: 'ctx.hint.memory',
  summary: 'ctx.hint.summary',
  buffer: 'ctx.hint.buffer'
}

export function contextPartLabel(id: ContextRowId, compacted: boolean): MessageKey {
  return id === 'system' && compacted ? 'ctx.cat.systemSummary' : LABEL[id]
}

export function contextPartHint(id: ContextRowId): MessageKey | undefined {
  return HINT[id]
}
