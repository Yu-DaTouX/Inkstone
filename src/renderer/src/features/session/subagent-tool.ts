import type { SubagentRun, UIToolCall } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'
import type { BotActivity, BotTool } from '../../patterns/model-bot/draw'
import { toolKind } from './tool-summary'

const COMMAND_NAMES = /^(bash|sh|zsh|cmd|pwsh|powershell|shell|terminal|exec|execute|run|codemode)(_|$)|_(command|cmd|shell|terminal)$/
const READ_NAMES = /^(read|view|cat|open|grep|glob|find|search|ls|list_dir|list_directory|list_files|fetch|web_fetch|web_search|browse)(_|$)/
const EDIT_NAMES = /^(edit|write|multi_edit|multiedit|str_replace|apply_patch|patch|notebook_edit|create_file|delete_file|move_file|rename_file)(_|$)/

function bareToolName(name: string): string {
  const tail = name.split(/__|[./:]/).filter(Boolean).pop() ?? name
  return tail.toLowerCase().replace(/-/g, '_')
}

export function subagentToolLook(name: string): BotTool | null {
  const bare = bareToolName(name)
  switch (toolKind(bare)) {
    case 'run':
      return 'command'
    case 'read':
    case 'search':
    case 'fetch':
      return 'read'
    case 'edit':
      return 'edit'
  }
  if (COMMAND_NAMES.test(bare)) return 'command'
  if (EDIT_NAMES.test(bare)) return 'edit'
  if (READ_NAMES.test(bare)) return 'read'
  return null
}

function pendingCall(calls: readonly UIToolCall[] | undefined): BotActivity | null {
  if (!calls) return null
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]
    if (call.output !== undefined || call.cancelled || call.parentToolCallId) continue
    const look = subagentToolLook(call.name)
    if (look) return { look, id: call.id }
  }
  return null
}

export function subagentActiveTool(run: Pick<SubagentRun, 'transcript'>, snapshot?: Pick<RunSnapshot, 'phase'>): BotActivity | null {
  const phase = snapshot?.phase
  if (phase?.kind === 'running' && phase.tool) {
    const look = subagentToolLook(phase.tool.name)
    if (look) return { look, id: phase.tool.callId }
  }
  for (let i = run.transcript.length - 1; i >= 0; i--) {
    const message = run.transcript[i]
    if (message.role === 'assistant') return pendingCall(message.toolCalls)
  }
  return null
}
