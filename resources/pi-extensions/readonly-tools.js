import { execFile } from 'node:child_process'
import { readResult, toolText as text } from './host-tool-call.js'
import { createWebTools } from './web-tools.js'

const GIT_ACTIONS = ['diff', 'log', 'show', 'status', 'blame']
const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const OUTPUT_MAX_CHARS = 60_000
const ARGS_MAX = 40
const ARG_MAX_CHARS = 500
const HOST_TIMEOUT_MS = 90_000
const FORBIDDEN_GIT_ARG = /^(--output|--ext-diff|--textconv|--ignore-submodules|--submodule|--exec|--upload-pack|--receive-pack|--open-files-in-pager|--config-env|--git-dir|--work-tree|--namespace|--super-prefix|--paginate|-p$|-o|-O)/
const FORBIDDEN_LONG_OPTIONS = [
  { name: 'ignore-submodules', min: 7, negated: true },
  { name: 'submodule', min: 3 },
  { name: 'textconv', min: 5 },
  { name: 'ext-diff', min: 3 },
  { name: 'show-signature', min: 7 },
  { name: 'contents', min: 4 },
  { name: 'no-index', min: 4 },
  { name: 'ignore-revs-file', min: 11 }
]
const REPEAT_AFTER_ARGS = new Set(['status', 'blame'])
const BUILTIN_PRETTY = new Set(['oneline', 'short', 'medium', 'full', 'fuller', 'reference', 'email', 'mboxrd', 'raw'])
const AUTO_READ_PROTOCOLS = 'file:git:http:https:ssh'
const GIT_GLOBALS = ['-c', 'core.quotepath=false', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'log.showSignature=false', '-c', 'format.pretty=medium', '-c', 'diff.external=', '--no-pager', '--no-optional-locks']
const SUBMODULE_GUARD = ['--ignore-submodules=dirty', '--submodule=short']
const NO_DRIVERS = { diff: ['--no-ext-diff', '--no-textconv', ...SUBMODULE_GUARD], show: ['--no-ext-diff', '--no-textconv', ...SUBMODULE_GUARD], log: ['--no-ext-diff', '--no-textconv', ...SUBMODULE_GUARD], status: ['--ignore-submodules=dirty'], blame: ['--no-textconv'] }
const KEPT_GIT_VARIABLES = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_PROXY_COMMAND', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'])

export function gitFilterOverrides(configNames) {
  const names = new Set()
  for (const line of String(configNames ?? '').split('\0')) {
    const match = /^filter\.([\s\S]+)\.(?:clean|process|smudge|required)$/.exec(line)
    if (match) names.add(match[1])
  }
  return [...names].flatMap((name) => [
    [`filter.${name}.clean`, ''],
    [`filter.${name}.process`, ''],
    [`filter.${name}.smudge`, ''],
    [`filter.${name}.required`, 'false']
  ])
}

export function gitInspectEnv(base = process.env, overrides = []) {
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    if (/^GIT_/i.test(key) && !KEPT_GIT_VARIABLES.has(key.toUpperCase())) continue
    env[key] = value
  }
  Object.assign(env, { GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: AUTO_READ_PROTOCOLS })
  if (overrides.length) {
    env.GIT_CONFIG_COUNT = String(overrides.length)
    overrides.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key
      env[`GIT_CONFIG_VALUE_${index}`] = value
    })
  }
  return env
}

function clip(value) {
  if (value.length <= OUTPUT_MAX_CHARS) return value
  return `${value.slice(0, OUTPUT_MAX_CHARS)}\n… [output truncated: ${value.length - OUTPUT_MAX_CHARS} more characters; narrow with paths, -n, --stat or a revision range]`
}

function forbiddenLongOption(arg) {
  const match = /^--([^=]+)/.exec(arg)
  if (!match) return false
  const name = match[1]
  const positive = name.startsWith('no-') ? name.slice(3) : null
  return FORBIDDEN_LONG_OPTIONS.some((option) =>
    [name, option.negated ? positive : null].some((candidate) => candidate && candidate.length >= option.min && option.name.startsWith(candidate))
  )
}

function unsafePrettyFormat(arg) {
  const match = /^--(?:pretty|format)(?:=([\s\S]*))?$/.exec(arg)
  if (!match) return false
  const value = match[1] ?? ''
  if (/%[-+ ]?G/.test(value.replace(/%%/g, ''))) return true
  if (!value || value.includes('%') || /^t?format:/.test(value)) return false
  return !BUILTIN_PRETTY.has(value)
}

const NETWORK_PREFIX = /^(?:[\\/]{2}|[\\/]\?\?[\\/])/
const LOCAL_DRIVE_DEVICE = /^[\\/]{2}[?.][\\/](?=[a-zA-Z]:(?:[\\/]|$))/
const DOT_SEGMENT = /(?:^|[\\/])[. ]*\.[. ]*(?:[\\/]|$)/

function networkLocalPath(value) {
  if (LOCAL_DRIVE_DEVICE.test(value)) return DOT_SEGMENT.test(value.replace(LOCAL_DRIVE_DEVICE, ''))
  return NETWORK_PREFIX.test(value)
}

export function isNetworkPath(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  const url = /^file:([\s\S]*)$/i.exec(text)
  if (!url) return networkLocalPath(text)
  let rest = url[1]
  try {
    rest = decodeURIComponent(rest)
  } catch {
  }
  const authority = /^[\\/]{2}([^\\/]*)/.exec(rest)
  if (!authority) return networkLocalPath(rest)
  const host = authority[1]
  if (host && host.toLowerCase() !== 'localhost') return true
  return networkLocalPath(rest.slice(2 + host.length))
}

const PATHSPEC_MAGIC = /^:(?:\([^)]*\)|[!^/]*):?/
const SHORT_CLUSTER_RULES = {
  diff: { forbidden: 'O', value: 'SGL' },
  log: { forbidden: 'O', value: 'SGL' },
  show: { forbidden: 'O', value: 'SGL' },
  blame: { forbidden: 'S', value: 'L' }
}

function networkArg(arg) {
  const candidates = [arg, arg.replace(PATHSPEC_MAGIC, '')]
  const long = /^--[^=]+=([\s\S]*)$/.exec(arg)
  if (long) candidates.push(long[1])
  else if (/^-[^-]/.test(arg)) for (let index = 2; index < arg.length; index += 1) candidates.push(arg.slice(index))
  return candidates.some(isNetworkPath)
}

function forbiddenShortCluster(action, arg) {
  const rule = SHORT_CLUSTER_RULES[action]
  if (!rule || !/^-[^-]/.test(arg)) return false
  for (const flag of arg.slice(1)) {
    if (rule.forbidden.includes(flag)) return true
    if (rule.value.includes(flag)) return false
  }
  return false
}

function escapesWorkTree(arg) {
  const path = arg.replace(PATHSPEC_MAGIC, '')
  if (/^[a-zA-Z]:/.test(path) || /^[\\/]/.test(path)) return true
  return path.split(/[\\/]/).includes('..')
}

export function gitInspectArgs(action, args = []) {
  if (!GIT_ACTIONS.includes(action)) return { error: `action must be one of ${GIT_ACTIONS.join(', ')}` }
  if (!Array.isArray(args) || args.length > ARGS_MAX) return { error: `args must be an array of at most ${ARGS_MAX} strings` }
  let afterSeparator = false
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg || arg.length > ARG_MAX_CHARS || arg.includes('\0')) return { error: 'every arg must be a non-empty string without NUL' }
    if (arg === '--') {
      afterSeparator = true
      continue
    }
    if (networkArg(arg)) return { error: `network paths are not allowed: ${arg}` }
    if (action === 'diff' && (afterSeparator || !arg.startsWith('-')) && escapesWorkTree(arg)) return { error: `diff paths must stay inside the work tree: ${arg}` }
    if (!afterSeparator && (FORBIDDEN_GIT_ARG.test(arg) || forbiddenLongOption(arg) || unsafePrettyFormat(arg) || forbiddenShortCluster(action, arg))) return { error: `option not allowed in read-only mode: ${arg}` }
  }
  const separator = args.indexOf('--')
  const options = separator < 0 ? args : args.slice(0, separator)
  const paths = separator < 0 ? [] : args.slice(separator)
  const repeat = separator >= 0 || REPEAT_AFTER_ARGS.has(action) ? NO_DRIVERS[action] : []
  return { argv: [...GIT_GLOBALS, action, ...NO_DRIVERS[action], ...options, ...repeat, ...paths] }
}

function runGit(argv, cwd, signal, env) {
  return new Promise((resolve) => {
    execFile('git', argv, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, signal, env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error && typeof error.code !== 'number' ? String(error.message ?? error) : '' })
    })
  })
}

async function callHost(command, params, signal, env = process.env) {
  if (!env.YAN_CLI_URL || !env.YAN_CLI_TOKEN || !env.YAN_SESSION_ID || !env.YAN_PROJECT_ID) return { ok: false, error: 'Inkstone host endpoint is not available' }
  const timeout = AbortSignal.timeout(HOST_TIMEOUT_MS)
  try {
    const response = await fetch(env.YAN_CLI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.YAN_CLI_TOKEN}` },
      body: JSON.stringify({ apiVersion: 1, command, params, sessionId: env.YAN_SESSION_ID, projectId: env.YAN_PROJECT_ID }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    const payload = await response.json()
    if (!payload?.ok) return { ok: false, error: String(payload?.error ?? 'host error') }
    return { ok: true, summary: payload.summary ?? {}, data: readResult(payload.resultFile) }
  } catch (error) {
    return { ok: false, error: signal?.aborted ? 'cancelled' : String(error?.message ?? error) }
  }
}

export const GIT_INSPECT_TOOL = {
  name: 'git_inspect',
  label: 'Git (read-only)',
  description: 'Read-only git in the working directory. args are passed as separate argv entries (no shell); options that write files or run external programs are rejected. Use paths after "--" to narrow output.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: GIT_ACTIONS },
      args: { type: 'array', items: { type: 'string' }, maxItems: ARGS_MAX, description: 'Extra arguments, e.g. ["151429f5..HEAD", "--stat"] or ["HEAD~3", "--", "src/main/agent.ts"]' }
    },
    required: ['action']
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const built = gitInspectArgs(params?.action, params?.args ?? [])
    if (built.error) return text(built.error, {}, true)
    const cwd = ctx?.cwd ?? process.cwd()
    if (params.action === 'diff') {
      const inside = await runGit([...GIT_GLOBALS, 'rev-parse', '--is-inside-work-tree'], cwd, signal, gitInspectEnv())
      if (inside.code !== 0 || inside.stdout.trim() !== 'true') return text('git_inspect diff only works inside a git work tree', {}, true)
    }
    const listed = await runGit([...GIT_GLOBALS, 'config', '--name-only', '--list', '-z'], cwd, signal, gitInspectEnv())
    const result = await runGit(built.argv, cwd, signal, gitInspectEnv(process.env, gitFilterOverrides(listed.stdout)))
    if (result.error) return text(`git failed: ${result.error}`, { code: result.code }, true)
    const body = result.stdout || (result.code === 0 ? '(no output)' : '')
    const stderr = result.stderr.trim() ? `\n[stderr]\n${result.stderr.trim().slice(0, 4000)}` : ''
    return text(clip(`${body}${stderr}`), { code: result.code }, result.code !== 0)
  }
}

export const [WEB_SEARCH_TOOL, WEB_FETCH_TOOL, WEB_DOCS_TOOL] = createWebTools(({ command, params, signal }) => callHost(command, params, signal))

export default function readOnlyToolsExtension(pi) {
  pi.registerTool(GIT_INSPECT_TOOL)
  pi.registerTool(WEB_SEARCH_TOOL)
  pi.registerTool(WEB_FETCH_TOOL)
  pi.registerTool(WEB_DOCS_TOOL)
}
