export type GitErrorCode =
  | 'GIT_MISSING'
  | 'CWD_MISSING'
  | 'GIT_TIMEOUT'
  | 'DEADLINE_EXCEEDED'
  | 'OUTPUT_LIMIT'
  | 'NOT_A_REPO'
  | 'QUERY_FAILED'

const KEPT_GIT_VARIABLES = new Set([
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_ASKPASS',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'GIT_PROXY_COMMAND',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM'
])

export function sanitizedGitEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (/^GIT_/i.test(key) && !KEPT_GIT_VARIABLES.has(key.toUpperCase())) continue
    env[key] = value
  }
  return {
    ...env,
    GIT_EXTERNAL_DIFF: '',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    ...overrides
  }
}

export const GIT_READ_CONFIG: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'log.showSignature=false',
  '-c', 'diff.external=',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.relative=false',
  '-c', 'color.ui=false'
]

export interface GitDeadline {
  remaining(): number
  expired(): boolean
}

export function createGitDeadline(totalMs: number, now: () => number = Date.now): GitDeadline {
  const end = now() + Math.max(0, totalMs)
  return {
    remaining: () => Math.max(0, end - now()),
    expired: () => now() >= end
  }
}

export function timeoutWithin(requestedMs: number, deadline?: GitDeadline): number {
  if (!deadline) return requestedMs
  return Math.min(requestedMs, deadline.remaining())
}

export function classifyGitRunError(input: {
  enoent?: boolean
  cwdExists?: boolean
  timedOut?: boolean
  deadlineExpired?: boolean
  outputLimit?: boolean
  stderr?: string
}): GitErrorCode {
  if (input.enoent) return input.cwdExists === false ? 'CWD_MISSING' : 'GIT_MISSING'
  if (input.outputLimit) return 'OUTPUT_LIMIT'
  if (input.timedOut) return input.deadlineExpired ? 'DEADLINE_EXCEEDED' : 'GIT_TIMEOUT'
  if (/not a git repository/i.test(input.stderr ?? '')) return 'NOT_A_REPO'
  return 'QUERY_FAILED'
}
