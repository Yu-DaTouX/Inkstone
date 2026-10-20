import type { UIToolCall } from '../../../../shared/ipc'
import type { SessionTextKey } from './text'
import { redactCommandSecrets, stepCategory, stepVerbKey, toolTarget } from './tool-title'

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

export function generatingArgs(call: UIToolCall): boolean {
  return (call.status === 'running' || call.status === 'pending') && call.args === undefined && !call.incomplete
}

export function summarize(call: UIToolCall): string {
  const target = toolTarget(call)
  return stepCategory(call.name) === 'bash' ? redactCommandSecrets(target) : target
}

export function runningCallLabel(call: UIToolCall, generating: string): string {
  return `${call.name} ${generatingArgs(call) ? generating : summarize(call)}`.trim()
}

export function toolRunningLabel(
  call: UIToolCall,
  generating: string,
  tt: (key: SessionTextKey, vars?: Record<string, string | number>) => string
): string {
  const label = stepVerbKey(call, tt) ?? call.name
  const meta = generatingArgs(call) ? generating : summarize(call)
  return `${label} ${meta}`.trim()
}
