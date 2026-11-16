import { pick } from './ui-lang'
import { extensionName, parsePiExtensionFailures, type PiExtensionFailure } from './pi-start-failure'

export interface PiExtensionSkip {
  mode: 'some' | 'all-user'
  extensions: Array<Pick<PiExtensionFailure, 'path' | 'name' | 'reason' | 'conflict'>>
  othersSkipped: number
  builtinsSkipped?: boolean
}

export type PiExtensionSkipPlan =
  | { kind: 'skip'; culprits: PiExtensionFailure[] }
  | { kind: 'all-user'; culprits: PiExtensionFailure[] }
  | { kind: 'none' }

export interface ResolvedPiExtension {
  path: string
  enabled: boolean
}

const EXTENSION_HINT = /Start without extensions/
const BUILTIN_PREFIX = 'builtin:'
const BUILTIN_LIST_START = 'builtInExtensions=['
const KNOWN_BUILTINS = new Set(['llama.cpp', 'codemode', 'tool-search', 'mcp'])

export function parsePiBuiltinNames(text: string): string[] | null {
  const start = text.indexOf(BUILTIN_LIST_START)
  if (start < 0 || text.indexOf(BUILTIN_LIST_START, start + 1) >= 0) return null
  const end = text.indexOf('];', start)
  if (end < 0) return null
  const body = text.slice(start + BUILTIN_LIST_START.length, end)
  const names = [...body.matchAll(/\{name:"([^"]+)",factory:/g)].map((match) => match[1])
  const mentions = body.split('name:').length - 1
  if (names.length === 0 || names.length !== mentions || new Set(names).size !== names.length) return null
  return names.every((name) => KNOWN_BUILTINS.has(name)) ? names : null
}

function norm(path: string): string {
  const value = path.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(value) || value.startsWith('//') ? value.toLowerCase() : value
}

function within(path: string, dir: string): boolean {
  const a = norm(path)
  const b = norm(dir)
  return a === b || a.startsWith(`${b}/`)
}

export function isHostPiExtension(path: string, hostPaths: readonly string[]): boolean {
  if (path.startsWith(BUILTIN_PREFIX)) return true
  return hostPaths.some((host) => within(path, host))
}

export function planPiExtensionSkip(stderr: readonly string[], hostPaths: readonly string[]): PiExtensionSkipPlan {
  const failures = parsePiExtensionFailures(stderr)
  if (failures.length === 0) return stderr.some((line) => EXTENSION_HINT.test(line)) ? { kind: 'all-user', culprits: [] } : { kind: 'none' }
  const culprits: PiExtensionFailure[] = []
  for (const failure of failures) {
    let culprit: PiExtensionFailure | undefined
    if (!isHostPiExtension(failure.path, hostPaths)) culprit = failure
    else if (failure.conflict && failure.owner && !isHostPiExtension(failure.owner, hostPaths)) {
      culprit = { ...failure, path: failure.owner, name: extensionName(failure.owner) }
    }
    if (!culprit) return { kind: 'none' }
    if (!culprits.some((item) => norm(item.path) === norm(culprit.path))) culprits.push(culprit)
  }
  return { kind: 'skip', culprits }
}

function extensionArg(arg: string): boolean {
  return arg === '--extension' || arg === '-e'
}

export function piExtensionSkipArgs(input: {
  args: readonly string[]
  hostPaths: readonly string[]
  plan: Exclude<PiExtensionSkipPlan, { kind: 'none' }>
  resolved: readonly ResolvedPiExtension[] | null
}): { args: string[]; skip: PiExtensionSkip } {
  const discovery = !input.args.includes('--no-extensions')
  const kept: string[] = []
  const cliUser: string[] = []
  for (let i = 0; i < input.args.length; i += 1) {
    const arg = input.args[i]
    if (arg === '--no-extensions') continue
    if (extensionArg(arg) && input.args[i + 1] !== undefined) {
      const path = input.args[++i]
      if (isHostPiExtension(path, input.hostPaths)) kept.push('--extension', path)
      else cliUser.push(path)
      continue
    }
    kept.push(arg)
  }
  const ordered: Array<{ path: string; builtin: boolean }> = discovery
    ? (input.resolved ?? [])
      .filter((item) => item.enabled && !(isHostPiExtension(item.path, input.hostPaths) && !item.path.startsWith(BUILTIN_PREFIX)))
      .map((item) => ({ path: item.path, builtin: item.path.startsWith(BUILTIN_PREFIX) }))
    : cliUser.map((path) => ({ path, builtin: false }))
  const users = ordered.filter((item) => !item.builtin).map((item) => item.path)
  const hits = (user: string): boolean => input.plan.culprits.some((culprit) => within(culprit.path, user))
  const located = input.plan.kind === 'skip' && (discovery ? input.resolved !== null : true) &&
    input.plan.culprits.every((culprit) => users.some((user) => within(culprit.path, user)))
  const mode: PiExtensionSkip['mode'] = located ? 'some' : 'all-user'
  const loaded = ordered.filter((item) => item.builtin || (mode === 'some' && !hits(item.path)))
  const already = new Set(kept.filter((_, index) => index > 0 && kept[index - 1] === '--extension').map(norm))
  const extra = loaded.filter((item) => !already.has(norm(item.path))).flatMap((item) => ['--extension', item.path])
  const others = mode === 'all-user' ? users.filter((user) => !hits(user)).length : 0
  return {
    args: ['--no-extensions', ...kept, ...extra],
    skip: {
      mode,
      extensions: input.plan.culprits.map(({ path, name, reason, conflict }) => ({ path, name, reason, conflict })),
      othersSkipped: others,
      ...(discovery && input.resolved === null ? { builtinsSkipped: true } : {})
    }
  }
}

function quotedNames(skip: PiExtensionSkip): string {
  return skip.extensions.map((item) => pick(`「${item.name}」`, `"${item.name}"`)).join(pick('、', ', '))
}

export function piExtensionSkipSummary(skip: PiExtensionSkip): string {
  const names = quotedNames(skip)
  const plural = skip.extensions.length === 1 ? 'extension' : 'extensions'
  if (skip.mode === 'some') return pick(`本会话已跳过出错的扩展${names}，其他扩展照常加载`, `Skipped the failing ${plural} ${names} in this session; other extensions load as usual`)
  const builtins = skip.builtinsSkipped ? pick('，内置扩展（含 MCP）本会话也未加载', '; built-in extensions (including MCP) are not loaded in this session either') : ''
  if (skip.extensions.length === 0) return pick(`用户扩展导致 pi 无法启动，本会话已跳过全部用户扩展${builtins}`, `A user extension stopped pi from starting; all user extensions are skipped in this session${builtins}`)
  return pick(`扩展${names}出错，本会话已跳过全部用户扩展${builtins}`, `The ${plural} ${names} failed; all user extensions are skipped in this session${builtins}`)
}

export function piExtensionSkipRetryFailure(skip: PiExtensionSkip, failure: string): string {
  const names = quotedNames(skip)
  return names
    ? pick(`跳过扩展${names}后仍失败，真正原因：${failure}`, `pi still failed after skipping ${names}. Actual cause: ${failure}`)
    : pick(`跳过用户扩展后仍失败，真正原因：${failure}`, `pi still failed after skipping user extensions. Actual cause: ${failure}`)
}

export function piExtensionSkipDetail(skip: PiExtensionSkip): string {
  const reasons = skip.extensions.map((item) =>
    item.conflict
      ? pick(`「${item.name}」与其他扩展重名：${item.reason}（${item.path}）`, `"${item.name}" clashes with another extension: ${item.reason} (${item.path})`)
      : pick(`「${item.name}」加载失败：${item.reason}（${item.path}）`, `"${item.name}" failed to load: ${item.reason} (${item.path})`)
  )
  const count = skip.othersSkipped
  const others = skip.mode === 'all-user' && count > 0
    ? [pick(`另有 ${count} 个用户扩展一并跳过。`, `${count} other user ${count === 1 ? 'extension was' : 'extensions were'} skipped too.`)]
    : []
  const builtins = skip.builtinsSkipped ? [pick('内置扩展（含 MCP）本会话也未加载。', 'Built-in extensions (including MCP) are not loaded in this session either.')] : []
  const recover = pick('修好或移走出问题的扩展后，新建会话或重启本会话会自动恢复加载；砚没有改动你的 pi 设置，也没有停用任何扩展。', 'After you fix or move the failing extension, a new session or a restart of this one loads extensions as usual again; Inkstone did not change your pi settings or disable any extension.')
  return [...reasons, ...others, ...builtins, recover].join('\n')
}
