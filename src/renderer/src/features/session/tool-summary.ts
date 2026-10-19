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

export function generatingArgs(call: UIToolCall): boolean {
  return (call.status === 'running' || call.status === 'pending') && call.args === undefined && !call.incomplete
}

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

export function runningCallLabel(call: UIToolCall, generating: string): string {
  return `${call.name} ${generatingArgs(call) ? generating : summarize(call)}`.trim()
}
