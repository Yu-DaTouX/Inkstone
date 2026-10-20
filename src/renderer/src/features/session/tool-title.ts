import type { UIToolCall } from '../../../../shared/ipc'
import { isDangerDenial } from '../../../../shared/danger-block'
import type { SessionTextKey } from './text'

export type StepCategory = 'read' | 'bash' | 'edit' | 'write' | 'grep' | 'ls' | 'web' | 'other'

export type StepTextKey = (key: SessionTextKey, vars?: Record<string, string | number>) => string

const CATEGORY_NAMES: Record<string, StepCategory> = {
  read: 'read', view: 'read', cat: 'read', open: 'read', read_file: 'read',
  bash: 'bash', powershell: 'bash', pwsh: 'bash', shell: 'bash', sh: 'bash', cmd: 'bash',
  run: 'bash', exec: 'bash', codemode: 'bash',
  edit: 'edit', multi_edit: 'edit', multiedit: 'edit', apply_patch: 'edit', patch: 'edit',
  str_replace: 'edit', notebook_edit: 'edit',
  write: 'write', create_file: 'write',
  grep: 'grep', rg: 'grep', ripgrep: 'grep', search: 'grep', search_files: 'grep',
  ls: 'ls', list: 'ls', list_dir: 'ls', list_directory: 'ls', list_files: 'ls',
  glob: 'ls', find: 'ls',
  web: 'web', web_search: 'web', websearch: 'web', fetch: 'web', web_fetch: 'web',
  webfetch: 'web', browse: 'web'
}

function bareName(name: string): string {
  const tail = name.split(/__|[./:]/).filter(Boolean).pop() ?? name
  return tail.toLowerCase().replace(/-/g, '_')
}

export function stepCategory(name: string): StepCategory {
  return CATEGORY_NAMES[bareName(name)] ?? 'other'
}

const VERBS: Record<Exclude<StepCategory, 'other'>, [SessionTextKey, SessionTextKey, SessionTextKey]> = {
  read: ['stepRead', 'stepReadRunning', 'stepReadFailed'],
  bash: ['stepRan', 'stepRunning', 'stepRunFailed'],
  edit: ['stepEdited', 'stepEditing', 'stepEditFailed'],
  write: ['stepCreated', 'stepCreating', 'stepWriteFailed'],
  grep: ['stepSearched', 'stepSearching', 'stepSearchFailed'],
  ls: ['stepListed', 'stepListing', 'stepListFailed'],
  web: ['stepWebSearched', 'stepWebSearching', 'stepWebSearchFailed']
}

const DENIED_VERBS: Record<Exclude<StepCategory, 'other'>, SessionTextKey> = {
  read: 'stepReadDenied',
  bash: 'stepRunDenied',
  edit: 'stepEditDenied',
  write: 'stepWriteDenied',
  grep: 'stepSearchDenied',
  ls: 'stepListDenied',
  web: 'stepWebSearchDenied'
}

type StepStateCall = Pick<UIToolCall, 'status' | 'cancelled' | 'denied' | 'output'>

export function isDeniedCall(call: StepStateCall): boolean {
  if (call.cancelled) return false
  if (call.denied) return true
  return call.status === 'error' && isDangerDenial(call.output)
}

export function stepState(call: StepStateCall): 'running' | 'failed' | 'done' | 'denied' {
  if (call.cancelled) return 'done'
  if (call.status === 'running' || call.status === 'pending') return 'running'
  if (isDeniedCall(call)) return 'denied'
  if (call.status === 'error') return 'failed'
  return 'done'
}

export function stepVerbKey(call: Pick<UIToolCall, 'name' | 'status' | 'cancelled' | 'denied' | 'output'>, tt: StepTextKey): string | null {
  const category = stepCategory(call.name)
  if (category === 'other') return null
  const [done, running, failed] = VERBS[category]
  const state = stepState(call)
  return tt(state === 'running' ? running : state === 'denied' ? DENIED_VERBS[category] : state === 'failed' ? failed : done)
}

const SECRET_FLAG = /(^|[\s;&|()])(--?(?:token|secret|passwd|password|passphrase|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|auth|key))(\s*=\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi
const SECRET_ENV = /(^|[\s;&|()])([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY|_AUTH)[A-Za-z0-9_]*)(\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi
const SECRET_QUERY = /([?&](?:[A-Za-z0-9_.-]*(?:token|secret|key|password|auth|credential|signature|sig)[A-Za-z0-9_.-]*)=)([^&\s"']+)/gi
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi
const AUTH_HEADER = /(\b(?:authorization|proxy-authorization|x-api-key|api-key)\s*[:=]\s*)(?:(bearer|basic|token)\s+)?([^\s"',;]+)/gi
const BEARER = /(\bbearer\s+)([A-Za-z0-9._~+/-]+=*)/gi

export const REDACTED = '***'

export function redactCommandSecrets(command: string): string {
  if (!command) return command
  return command
    .replace(AUTH_HEADER, (_match, head: string, scheme: string | undefined) => `${head}${scheme ? `${scheme} ` : ''}${REDACTED}`)
    .replace(BEARER, (_match, head: string) => `${head}${REDACTED}`)
    .replace(URL_USERINFO, (_match, head: string, _secret: string, at: string) => `${head}${REDACTED}${at}`)
    .replace(SECRET_QUERY, (_match, head: string) => `${head}${REDACTED}`)
    .replace(SECRET_FLAG, (_match, lead: string, flag: string, sep: string) => `${lead}${flag}${sep}${REDACTED}`)
    .replace(SECRET_ENV, (_match, lead: string, name: string, sep: string) => `${lead}${name}${sep}${REDACTED}`)
}

function commandText(call: Pick<UIToolCall, 'args'>): string {
  const args = call.args as Record<string, unknown> | undefined
  if (!args || typeof args !== 'object') return ''
  for (const key of ['command', 'cmd', 'script', 'code']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function textArg(call: Pick<UIToolCall, 'args'>, keys: readonly string[]): string {
  const args = call.args as Record<string, unknown> | undefined
  if (!args || typeof args !== 'object') return ''
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

export function fileBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function toolTarget(call: Pick<UIToolCall, 'name' | 'args'>): string {
  const category = stepCategory(call.name)
  if (category === 'bash') return redactCommandSecrets(commandText(call))
  if (category === 'read' || category === 'edit' || category === 'write') {
    const path = textArg(call, ['file_path', 'path', 'file'])
    if (path) return fileBaseName(path)
  }
  if (category === 'grep') {
    const pattern = textArg(call, ['pattern', 'query', 'regex'])
    if (pattern) return pattern
  }
  if (category === 'ls') {
    const path = textArg(call, ['path', 'dir', 'directory', 'cwd'])
    if (path) return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
  }
  if (category === 'web') {
    const target = textArg(call, ['url', 'query', 'q', 'pattern'])
    if (target) return target
  }
  const args = call.args as Record<string, unknown> | undefined
  if (!args || typeof args !== 'object') return ''
  if (typeof args.code === 'string') return args.code.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (typeof args.file_path === 'string') return fileBaseName(args.file_path)
  if (typeof args.path === 'string') return fileBaseName(args.path)
  if (typeof args.pattern === 'string') return args.pattern
  if (typeof args.query === 'string') return args.query
  if (typeof args.url === 'string') return args.url
  const keys = Object.keys(args)
  return keys.length ? keys.slice(0, 3).join(', ') : ''
}

export interface ToolStepTitle {
  label: string
  meta: string
  code: boolean
}

export function toolStepTitle(
  call: Pick<UIToolCall, 'name' | 'args' | 'status' | 'cancelled' | 'denied' | 'output'>,
  tt: StepTextKey
): ToolStepTitle {
  const category = stepCategory(call.name)
  const verb = stepVerbKey(call, tt)
  return {
    label: verb ?? call.name,
    meta: toolTarget(call),
    code: category === 'bash'
  }
}

export function shellTitle(name: string): string {
  const bare = bareName(name)
  return bare === 'powershell' || bare === 'pwsh' ? 'PowerShell' : 'Bash'
}
