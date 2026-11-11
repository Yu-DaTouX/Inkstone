import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { CapabilityCommandError, type CapabilityCommandResult } from './capability-server'
import { safeTerminalCut } from './terminal-registry'
import { buildTerminalNotice, type TerminalNoticeState } from '../shared/host-notice-text'
import type { TerminalJob } from '../shared/terminal-jobs'
import { addTerminalJob, terminalJob, updateTerminalJob } from './terminal-jobs'
import type { TerminalSessionInfo, TerminalSnapshot, TerminalStartOptions, TerminalStream, TerminalAgentPhase } from './terminal'
import type { TerminalProgramStatus } from '../shared/ipc'

const requireModule = createRequire(import.meta.url)

export const TERMINAL_SUMMARY_CHARS = 8000
export const TERMINAL_SUMMARY_LINES = 150
export const TERMINAL_READ_LINES_MAX = 2000
export const TERMINAL_RUN_TIMEOUT_MS = 120_000
export const TERMINAL_RUN_TIMEOUT_MAX_MS = 900_000
export const TERMINAL_QUIET_MS = 15_000
export const TERMINAL_BACKGROUND_TIMEOUT_MS = 3 * 3600_000
export const TERMINAL_BACKGROUND_TIMEOUT_MAX_MS = 24 * 3600_000
export const TERMINAL_BACKGROUND_SETTLE_MS = 3000
const BACKGROUND_NOTICE_LINES = 40
const BACKGROUND_NOTICE_CHARS = 4000
const AGENT_INTERRUPT_GRACE_MS = 10_000
export const TERMINAL_WRITE_WAIT_MS = 1500
export const TERMINAL_WRITE_WAIT_MAX_MS = 30_000
const SETTLE_IDLE_MS = 500
const UNTIL_MATCH_TIMEOUT_MS = 200
const WRITE_IDLE_MS = 300
const READY_TIMEOUT_MS = 8000
const NEW_TERMINAL_SETTLE_MS = 1200
const POLL_MS = 100
const PROCESS_RECHECK_MS = 1500
const AGENT_TERMINAL_COLS = 120
const AGENT_TERMINAL_ROWS = 30

const KEY_SEQUENCES: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  space: ' '
}

export function keySequence(raw: string): string | null {
  const name = raw.trim().toLowerCase()
  if (!name) return null
  if (KEY_SEQUENCES[name] !== undefined) return KEY_SEQUENCES[name]
  const ctrl = /^(?:ctrl|control)\+([a-z\[\\\]])$/.exec(name)
  if (ctrl) {
    const code = ctrl[1].charCodeAt(0)
    return String.fromCharCode(code >= 97 ? code - 96 : code - 64)
  }
  if (/^[a-z0-9]$/.test(name)) return name
  return null
}

export function keysToSequence(list: readonly string[]): { data: string; unknown: string[] } {
  let data = ''
  const unknown: string[] = []
  for (const key of list) {
    const sequence = keySequence(key)
    if (sequence === null) unknown.push(key)
    else data += sequence
  }
  return { data, unknown }
}

export function planSubmission(pending: string, data: string): { submitted: string[]; pending: string } {
  const submitted: string[] = []
  let line = pending
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]
    if (ch === '\x1b') {
      const next = data[i + 1]
      if (next === '[' || next === 'O') {
        i += 2
        while (i < data.length && !/[@-~]/.test(data[i])) i++
      } else i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\n' && data[i - 1] === '\r') continue
      if (line.trim()) submitted.push(line)
      line = ''
    } else if (ch === '\x03' || ch === '\x15') line = ''
    else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1)
    else if (ch >= ' ') line += ch
  }
  return { submitted, pending: line }
}

const ANSI_PATTERN = /\x1b\[[0-9;?<=>!]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g

export function stripTerminalControls(raw: string): string {
  const plain = raw.replace(ANSI_PATTERN, '')
  const lines: string[] = []
  for (const segment of plain.split('\n')) {
    const parts = segment.split('\r')
    let line = ''
    for (const part of parts) line = part.length >= line.length ? part : part + line.slice(part.length)
    lines.push(line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''))
  }
  return lines.join('\n')
}

const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g
const MAX_ESCAPE_CARRY = 4096

function unfinishedEscapeIndex(text: string): number {
  let index = 0
  while (index < text.length) {
    const at = text.indexOf('\x1b', index)
    if (at < 0) return -1
    const rest = text.slice(at + 1)
    if (!rest) return at
    const head = rest[0]
    const lineBreak = rest.search(/[\r\n]/)
    if (head === '[') {
      const complete = /^\[[0-9;:?<=>!]*[ -\/]*[@-~]/.exec(rest)
      if (complete) {
        index = at + 1 + complete[0].length
        continue
      }
      if (lineBreak >= 0) {
        index = at + 1
        continue
      }
      if (/^\[[0-9;:?<=>!]*[ -\/]*$/.test(rest)) return at
      index = at + 1
      continue
    }
    if (head === ']' || head === 'P' || head === 'X' || head === '^' || head === '_') {
      const terminated = /\x07|\x1b\\/.exec(rest)
      if (terminated) {
        index = at + 1 + terminated.index + terminated[0].length
        continue
      }
      if (lineBreak >= 0) {
        index = at + 1
        continue
      }
      return at
    }
    if (head === '(' || head === ')' || head === '#' || head === '%') {
      if (rest.length < 2) return at
      index = at + 3
      continue
    }
    index = at + 2
  }
  return -1
}

export class TerminalPlainText {
  private head = ''
  private line = ''
  private segment = ''
  private carry = ''
  private cached = ''

  get text(): string {
    return this.cached
  }

  push(chunk: string): string {
    if (!chunk) return this.cached
    let text = this.carry + chunk
    this.carry = ''
    const at = unfinishedEscapeIndex(text)
    if (at >= 0) {
      this.carry = text.slice(at)
      text = text.slice(0, at)
      if (this.carry.length > MAX_ESCAPE_CARRY) this.carry = ''
    }
    if (text) this.consume(text.replace(ANSI_PATTERN, ''))
    this.cached = this.head + this.merge().replace(CONTROL_CHARS, '')
    return this.cached
  }

  private consume(text: string): void {
    let start = 0
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      if (ch !== '\r' && ch !== '\n') continue
      this.segment += text.slice(start, i)
      this.line = this.merge()
      this.segment = ''
      if (ch === '\n') {
        this.head += this.line.replace(CONTROL_CHARS, '') + '\n'
        this.line = ''
      }
      start = i + 1
    }
    this.segment += text.slice(start)
  }

  private merge(): string {
    return this.segment.length >= this.line.length ? this.segment : this.segment + this.line.slice(this.segment.length)
  }
}

interface PlainStreamState {
  from: number
  start: number
  next: number
  tracker: TerminalPlainText
}

interface TruncatedPlainState {
  start: number
  total: number
  text: string
}

const plainStreams = new Map<string, PlainStreamState>()
const truncatedPlains = new Map<string, TruncatedPlainState>()

export function plainSince(id: string, stream: Pick<TerminalStream, 'buffer' | 'total'>, from: number): string {
  const start = stream.total - stream.buffer.length
  if (from >= stream.total) {
    plainStreams.delete(id)
    truncatedPlains.delete(id)
    return ''
  }
  if (from < start) {
    plainStreams.delete(id)
    const cached = truncatedPlains.get(id)
    if (cached && cached.start === start && cached.total === stream.total) return cached.text
    const text = stripTerminalControls(stream.buffer)
    truncatedPlains.set(id, { start, total: stream.total, text })
    return text
  }
  truncatedPlains.delete(id)
  const cached = plainStreams.get(id)
  if (!cached || cached.from !== from || cached.start !== start || cached.next > stream.total) {
    const tracker = new TerminalPlainText()
    tracker.push(stream.buffer.slice(from - start))
    plainStreams.set(id, { from, start, next: stream.total, tracker })
    return tracker.text
  }
  if (cached.next < stream.total) {
    cached.tracker.push(stream.buffer.slice(cached.next - start))
    cached.next = stream.total
  }
  return cached.tracker.text
}

export function programBusy(program: TerminalProgramStatus | undefined, childCount: number | null): boolean {
  if (childCount === null) return program?.state === 'working' || program?.state === 'blocked'
  return childCount > 0
}

export function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\s+$/, '')
    if (line) return line
  }
  return ''
}

export function afterEcho(plain: string): string {
  const newline = plain.indexOf('\n')
  return newline < 0 ? '' : plain.slice(newline + 1)
}

export function looksLikePrompt(line: string): boolean {
  const text = line.replace(/\s+$/, '')
  if (!text || text.length > 400) return false
  return /^PS [^\n]*>$/.test(text) || /^[A-Za-z]:\\[^\n]*>$/.test(text) || /[$#%❯›]$/.test(text)
}

export function tailText(text: string, maxLines = TERMINAL_SUMMARY_LINES, maxChars = TERMINAL_SUMMARY_CHARS): { text: string; truncated: boolean; lines: number } {
  const all = text.split('\n')
  let lines = all.length > maxLines ? all.slice(-maxLines) : all
  let joined = lines.join('\n')
  let truncated = lines.length < all.length
  if (joined.length > maxChars) {
    joined = joined.slice(joined.length - maxChars)
    const cut = joined.indexOf('\n')
    if (cut >= 0 && cut < 400) joined = joined.slice(cut + 1)
    truncated = true
    lines = joined.split('\n')
  }
  return { text: joined, truncated, lines: all.length }
}

const RENDER_CONTEXT_CHARS = 64 * 1024

export function sliceSince(stream: Pick<TerminalStream, 'buffer' | 'total'>, from: number): { raw: string; truncated: boolean; context: string } {
  const start = stream.total - stream.buffer.length
  if (from >= stream.total) return { raw: '', truncated: false, context: '' }
  if (from < start) return { raw: stream.buffer, truncated: true, context: '' }
  const offset = from - start
  const before = stream.buffer.slice(0, offset)
  const context = before.length > RENDER_CONTEXT_CHARS ? before.slice(safeTerminalCut(before, before.length - RENDER_CONTEXT_CHARS)) : before
  return { raw: stream.buffer.slice(offset), truncated: false, context }
}

let headlessModule: typeof import('@xterm/headless') | null = null

export async function renderTerminalText(raw: string, cols: number, context = ''): Promise<string> {
  if (!raw) return ''
  headlessModule ??= requireModule('@xterm/headless') as typeof import('@xterm/headless')
  const term = new headlessModule.Terminal({ cols: Math.max(20, Math.min(cols, 1000)), rows: 50, scrollback: 20_000, allowProposedApi: true })
  try {
    let first = 0
    if (context) {
      await new Promise<void>((done) => term.write(context, done))
      first = term.buffer.active.baseY + term.buffer.active.cursorY
    }
    await new Promise<void>((done) => term.write(raw, done))
    const buffer = term.buffer.active
    while (first > 0 && buffer.getLine(first)?.isWrapped) first--
    const lines: string[] = []
    for (let i = first; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (!line) continue
      const text = line.translateToString(true)
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
      else lines.push(text)
    }
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
    return lines.join('\n')
  } finally {
    term.dispose()
  }
}

export interface DangerRules {
  detectDanger(toolName: string, input: { command: string }, cwd: string, options?: { base?: string | null }): string[]
  outsideWrites(toolName: string, input: { command: string }, cwd: string, prefs: unknown): string[]
  shellLocationAfter(command: string, base: string | null): string | null
}

let dangerRules: Promise<DangerRules | null> | null = null

function dangerGuardPath(): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return [
    process.resourcesPath ? join(process.resourcesPath, 'yan-thin', 'danger-guard.js') : '',
    join(here, '..', '..', 'resources', 'pi-extensions', 'danger-guard.js'),
    join(process.cwd(), 'resources', 'pi-extensions', 'danger-guard.js')
  ].find((path) => path && existsSync(path))
}

export function loadDangerRules(): Promise<DangerRules | null> {
  dangerRules ??= (async () => {
    const path = dangerGuardPath()
    if (!path) return null
    try {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(path).href)) as Partial<DangerRules>
      return typeof mod.detectDanger === 'function' && typeof mod.outsideWrites === 'function' && typeof mod.shellLocationAfter === 'function' ? (mod as DangerRules) : null
    } catch {
      return null
    }
  })()
  return dangerRules
}

export interface TerminalGuardPrefs {
  mode: 'danger' | 'all'
  outsideWrites: boolean
  allowRoots: string[]
}

export interface TerminalConfirmRequest {
  detail: string
  reasons: string[]
  outsideDirs: string[]
}

export interface TerminalAgentHost {
  available(): boolean
  list(): TerminalSnapshot[]
  stream(id: string): TerminalStream | null
  start(options: TerminalStartOptions): TerminalSnapshot | null
  write(id: string, data: string): boolean
  kill(id: string): boolean
  announce(id: string, phase: TerminalAgentPhase, action: string): void
  sameOwner(a: string, b: string): boolean
  childCount(pid: number): Promise<number | null>
  render(raw: string, cols: number, context?: string): Promise<string>
  rules(): Promise<DangerRules | null>
  prefs(): Promise<TerminalGuardPrefs>
  now(): number
  sleep(ms: number): Promise<void>
}

export interface TerminalAgentContext {
  ownerKeys(): string[]
  cwd(): string
  confirm(request: TerminalConfirmRequest): Promise<{ allowed: boolean; feedback?: string }>
  notify?(text: string, stillOwner: () => boolean, wake: boolean): void
}

type WaitState = 'completed' | 'matched' | 'quiet' | 'timeout' | 'exited' | 'cancelled' | 'settled'

const agentTerminals = new Set<string>()

export function agentTerminalIds(): string[] {
  return [...agentTerminals]
}
const typedLines = new Map<string, string>()
const terminalLocations = new Map<string, string | null>()
const lastUsed = new Map<string, string>()
const backgroundJobs = new Map<string, AbortController>()
const agentInterrupts = new Map<string, number>()
const userInputChains = new Map<string, Promise<void>>()

export function resetTerminalAgentState(): void {
  for (const job of backgroundJobs.values()) job.abort()
  backgroundJobs.clear()
  agentInterrupts.clear()
  agentTerminals.clear()
  typedLines.clear()
  terminalLocations.clear()
  lastUsed.clear()
  userInputChains.clear()
  plainStreams.clear()
  truncatedPlains.clear()
}

export function pendingTerminalUserInput(id: string): Promise<void> {
  return userInputChains.get(id) ?? Promise.resolve()
}

const LOCATION_SAFE_HEADS = new Set([
  'ls', 'dir', 'cat', 'type', 'echo', 'printf', 'write-output', 'write-host', 'pwd', 'get-location', 'gl',
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'node', 'nodejs',
  'python', 'python3', 'py', 'pip', 'pip3', 'uv', 'poetry', 'conda',
  'cargo', 'rustc', 'rustup', 'go', 'java', 'javac', 'mvn', 'mvnw', 'gradle', 'gradlew', 'dotnet',
  'make', 'cmake', 'ninja', 'msbuild', 'docker', 'docker-compose', 'kubectl', 'helm', 'gh',
  'rg', 'grep', 'find', 'findstr', 'select-string', 'sls', 'fzf', 'sed', 'awk',
  'head', 'tail', 'get-content', 'gc', 'wc', 'sort', 'uniq', 'diff', 'compare-object',
  'curl', 'wget', 'invoke-webrequest', 'iwr', 'tar', 'unzip', 'zip', 'gzip',
  'cp', 'copy', 'copy-item', 'mv', 'move', 'move-item', 'rm', 'del', 'remove-item', 'mkdir', 'md', 'new-item', 'rmdir', 'touch',
  'code', 'vim', 'nvim', 'nano', 'less', 'more', 'man', 'help', 'get-help',
  'where', 'where.exe', 'which', 'get-command', 'test-path', 'get-childitem', 'gci',
  'tree', 'ps', 'tasklist', 'taskkill', 'kill', 'stop-process', 'export', 'set', 'env', 'printenv',
  'clear', 'cls', 'clear-host', 'history', 'get-history', 'whoami', 'hostname', 'date', 'time',
  'ping', 'ipconfig', 'nslookup', 'netstat', 'format', 'prettier', 'eslint', 'tsc', 'vite', 'esbuild'
])

const SHELL_LAUNCHERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'nu', 'pwsh', 'powershell', 'cmd', 'cmd.exe', 'wsl', 'ssh', 'mintty', 'winpty', 'script', 'tmux', 'screen'])

const LOCATION_COMMAND_HEADS = new Set(['cd', 'chdir', 'pushd', 'popd', 'push-location', 'pop-location', 'set-location', 'sl'])

function commandHeads(command: string): string[] {
  const text = command.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ')
  return text
    .split(/\r?\n|&&|\|\||[;|]|\$\(|`/)
    .map((part) => part.trim().replace(/^[({]+/, '').split(/\s+/)[0] ?? '')
    .map((head) => head.replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean)
}

export function userLocationAfterUserInput(rules: DangerRules, command: string, base: string | null): string | null {
  const heads = commandHeads(command)
  if (!heads.length) return base
  if (heads.some((head) => SHELL_LAUNCHERS.has(head))) return null
  if (heads.some((head) => !LOCATION_SAFE_HEADS.has(head) && !LOCATION_COMMAND_HEADS.has(head))) return null
  return rules.shellLocationAfter(command, base)
}

export function noteTerminalUserInput(id: string, data: string, cwd: string): Promise<void> {
  const previous = userInputChains.get(id) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    const plan = planSubmission(typedLines.get(id) ?? '', data)
    typedLines.set(id, plan.pending)
    if (!plan.submitted.length) return
    const rules = await loadDangerRules()
    const base = terminalLocations.has(id) ? (terminalLocations.get(id) ?? null) : cwd || null
    const command = plan.submitted.join('\n')
    terminalLocations.set(id, rules ? userLocationAfterUserInput(rules, command, base) : null)
  })
  const settled = next.catch(() => undefined)
  userInputChains.set(id, settled)
  void settled.then(() => {
    if (userInputChains.get(id) === settled) userInputChains.delete(id)
  })
  return next
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = params[key]
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function flagParam(params: Record<string, unknown>, key: string): boolean {
  const raw = params[key]
  return raw === true || raw === 'true' || raw === '1'
}

function secondsParam(params: Record<string, unknown>, key: string, fallbackMs: number, maxMs: number): number {
  const raw = params[key]
  const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs
  return Math.min(maxMs, Math.round(seconds * 1000))
}

function untilMatches(pattern: RegExp, text: string): boolean {
  try {
    return runInNewContext('pattern.test(text)', { pattern, text }, { timeout: UNTIL_MATCH_TIMEOUT_MS }) === true
  } catch {
    throw new CapabilityCommandError('terminal_bad_until', `--until pattern timed out; use a simpler one: ${pattern.source}`)
  }
}

function untilPattern(params: Record<string, unknown>): RegExp | null {
  const source = stringParam(params, 'until')
  if (!source) return null
  try {
    return new RegExp(source, 'm')
  } catch {
    throw new CapabilityCommandError('terminal_bad_until', `--until 不是合法的正则：${source}`)
  }
}

function describe(info: TerminalSessionInfo, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: info.id,
    title: info.title,
    cwd: info.cwd,
    alive: info.alive,
    ...(info.alive ? {} : { exitCode: info.exitCode ?? null }),
    ...(info.status ? { program: info.status.state } : {}),
    agentOpened: agentTerminals.has(info.id),
    ...extra
  }
}

function shellToolName(info: TerminalSessionInfo): string {
  return /(?:pwsh|powershell)(?:\.exe)?$/i.test(basename(info.shell)) ? 'powershell' : 'bash'
}

export class TerminalAgentCommands {
  constructor(private readonly host: TerminalAgentHost, private readonly ctx: TerminalAgentContext) {}

  async run(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    if (!this.host.available()) throw new CapabilityCommandError('terminal_unavailable', '终端组件不可用（node-pty 未加载）')
    switch (action) {
      case 'list':
        return this.list()
      case 'read':
        return this.read(params)
      case 'run':
        return this.runCommand(params, signal)
      case 'write':
        return this.write(params, signal)
      case 'keys':
        return this.keys(params, signal)
      case 'start':
        return this.start(params, signal)
      case 'stop':
        return this.stop(params)
      default:
        throw new CapabilityCommandError('terminal_unknown_action', `未知的 terminal 动作：${action}`)
    }
  }

  private ownerKey(): string {
    const key = this.ctx.ownerKeys().find(Boolean)
    if (!key) throw new CapabilityCommandError('terminal_no_session', '当前会话还没有身份，暂时不能使用终端')
    return key
  }

  private owned(info: TerminalSessionInfo): boolean {
    if (!info.owner) return false
    return this.ctx.ownerKeys().some((key) => key && this.host.sameOwner(info.owner as string, key))
  }

  private ownedTerminals(): TerminalSnapshot[] {
    return this.host.list().filter((item) => this.owned(item))
  }

  private target(params: Record<string, unknown>): TerminalStream {
    const id = stringParam(params, 'id').trim()
    if (!id) throw new CapabilityCommandError('terminal_id_required', '缺少 --id（先用 yan terminal list 查看）')
    const stream = this.host.stream(id)
    if (!stream || !this.owned(stream.info)) {
      throw new CapabilityCommandError('terminal_not_found', `本会话没有这个终端：${id}（用 yan terminal list 查看）`)
    }
    return stream
  }

  private async busy(stream: TerminalStream): Promise<boolean> {
    if (backgroundJobs.has(stream.info.id)) return true
    const count = stream.pid ? await this.host.childCount(stream.pid) : 0
    return programBusy(stream.info.status, count)
  }

  private async pickForRun(params: Record<string, unknown>): Promise<{ stream: TerminalStream; created: boolean }> {
    if (stringParam(params, 'id').trim()) {
      const stream = this.target(params)
      if (!stream.info.alive) throw new CapabilityCommandError('terminal_exited', `终端已退出（退出码 ${stream.info.exitCode ?? '—'}），换一个或用 yan terminal start 新开`)
      if (await this.busy(stream)) {
        throw new CapabilityCommandError('terminal_busy', '这个终端里还有程序在运行；要和它交互用 write / keys，要另跑命令就不带 --id（会换空闲终端）或加 --new')
      }
      return { stream, created: false }
    }
    if (!flagParam(params, 'new')) {
      const owner = this.ownerKey()
      const alive = this.ownedTerminals().filter((item) => item.alive).reverse()
      const preferred = lastUsed.get(owner)
      alive.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))
      for (const candidate of alive.slice(0, 2)) {
        const stream = this.host.stream(candidate.id)
        if (stream && !(await this.busy(stream))) return { stream, created: false }
      }
    }
    return { stream: this.open(params), created: true }
  }

  private open(params: Record<string, unknown>): TerminalStream {
    const owner = this.ownerKey()
    const requested = stringParam(params, 'cwd').trim()
    const base = this.ctx.cwd()
    const cwd = requested ? (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(requested) ? requested : join(base, requested)) : base
    if (requested) {
      let isDir = false
      try {
        isDir = statSync(cwd).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) throw new CapabilityCommandError('terminal_bad_cwd', `目录不存在：${cwd}`)
    }
    const title = stringParam(params, 'title').trim().slice(0, 60)
    const snapshot = this.host.start({ cwd, fallbackCwd: base, cols: AGENT_TERMINAL_COLS, rows: AGENT_TERMINAL_ROWS, owner, ...(title ? { title } : {}) })
    if (!snapshot) throw new CapabilityCommandError('terminal_start_failed', '没能新开终端（可能已达到本会话的终端上限）')
    agentTerminals.add(snapshot.id)
    const stream = this.host.stream(snapshot.id)
    if (!stream) throw new CapabilityCommandError('terminal_start_failed', '新开的终端已经退出')
    return stream
  }

  private async waitReady(id: string, signal?: AbortSignal, minimumMs = 0): Promise<void> {
    const started = this.host.now()
    while (this.host.now() - started < READY_TIMEOUT_MS) {
      if (signal?.aborted) return
      const stream = this.host.stream(id)
      if (!stream || !stream.info.alive) return
      const quiet = this.host.now() - stream.lastOutputAt
      if (this.host.now() - started >= minimumMs && stream.total > 0 && quiet >= WRITE_IDLE_MS && looksLikePrompt(lastNonEmptyLine(stripTerminalControls(stream.buffer.slice(-2000))))) return
      await this.host.sleep(POLL_MS)
    }
  }

  private async guard(stream: TerminalStream, data: string): Promise<void> {
    await pendingTerminalUserInput(stream.info.id)
    const plan = planSubmission(typedLines.get(stream.info.id) ?? '', data)
    if (plan.submitted.length > 0) {
      const prefs = await this.host.prefs()
      const command = plan.submitted.join('\n')
      const rules = await this.host.rules()
      const root = this.ctx.cwd()
      const tracked = terminalLocations.get(stream.info.id)
      const base = tracked === undefined ? stream.info.cwd || root : tracked
      if (prefs.mode !== 'all') {
        if (!rules) throw new CapabilityCommandError('terminal_guard_unavailable', '危险命令检查不可用，暂不执行写入终端的命令')
        const tool = shellToolName(stream.info)
        const outside = rules.outsideWrites(tool, { command }, root, { ...prefs, base })
        const reasons = [...new Set([...rules.detectDanger(tool, { command }, root, { base }), ...outside.map((target) => `写入项目之外的路径：${target}`)])]
        if (reasons.length > 0) {
          const answer = await this.ctx.confirm({ detail: command, reasons, outsideDirs: outside })
          if (!answer.allowed) {
            const why = answer.feedback ? `The user declined this operation and said: ${answer.feedback}` : 'The user declined this operation'
            throw new CapabilityCommandError(
              'terminal_blocked',
              `High-risk operation not confirmed by the user: ${reasons.join('; ')}. ${why}. Do not retry it and do not work around the refusal by another route; tell the user why this one is needed, or ask which alternative they want.`
            )
          }
        }
      }
      if (rules) terminalLocations.set(stream.info.id, rules.shellLocationAfter(command, base))
    }
    typedLines.set(stream.info.id, plan.pending)
  }

  private async waitFor(
    id: string,
    from: number,
    options: { mode: 'command' | 'settle'; timeoutMs: number; quietMs: number; idleMs: number; until: RegExp | null },
    signal?: AbortSignal
  ): Promise<WaitState> {
    const started = this.host.now()
    let nextProcessCheck = 0
    while (true) {
      if (signal?.aborted) return 'cancelled'
      const stream = this.host.stream(id)
      if (!stream || !stream.info.alive) return 'exited'
      const now = this.host.now()
      const plain = options.until || options.mode === 'command' ? plainSince(id, stream, from) : ''
      if (options.until && untilMatches(options.until, plain)) return 'matched'
      const quietFor = now - Math.max(stream.lastOutputAt, started)
      const sawOutput = stream.total > from
      if (options.mode === 'settle') {
        if ((sawOutput && quietFor >= options.idleMs) || now - started >= options.timeoutMs) return 'settled'
      } else {
        if (sawOutput && quietFor >= options.idleMs && looksLikePrompt(lastNonEmptyLine(afterEcho(plain))) && now >= nextProcessCheck) {
          const count = stream.pid ? await this.host.childCount(stream.pid) : 0
          if (count === 0 || count === null) return 'completed'
          nextProcessCheck = this.host.now() + PROCESS_RECHECK_MS
        }
        if (quietFor >= options.quietMs) return 'quiet'
        if (now - started >= options.timeoutMs) return 'timeout'
      }
      await this.host.sleep(POLL_MS)
    }
  }

  private async outputSince(id: string, from: number): Promise<{ text: string; truncated: boolean; cursor: number; info: TerminalSessionInfo | null }> {
    const stream = this.host.stream(id)
    if (!stream) return { text: '', truncated: false, cursor: from, info: null }
    const slice = sliceSince(stream, from)
    const text = await this.host.render(slice.raw, stream.info.cols, slice.context)
    return { text, truncated: slice.truncated, cursor: stream.total, info: stream.info }
  }

  private async withAnnounce<T>(id: string, action: string, work: () => Promise<T>): Promise<T> {
    this.host.announce(id, 'start', action)
    try {
      return await work()
    } finally {
      this.host.announce(id, 'end', action)
    }
  }

  private result(action: string, info: TerminalSessionInfo, output: { text: string; truncated: boolean; cursor: number }, extra: Record<string, unknown>): CapabilityCommandResult {
    const tail = tailText(output.text)
    const summary = {
      kind: 'terminal',
      action,
      ...describe(info),
      ...extra,
      cursor: output.cursor,
      output: tail.text,
      outputLines: tail.lines,
      ...(tail.truncated || output.truncated ? { outputTruncated: true } : {})
    }
    return { summary, data: { ...summary, output: output.text } }
  }

  private list(): CapabilityCommandResult {
    const terminals = this.ownedTerminals().map((item) => describe(item, { lastOutputAgoMs: Math.max(0, this.host.now() - (this.host.stream(item.id)?.lastOutputAt ?? this.host.now())) }))
    return { summary: { kind: 'terminal', action: 'list', count: terminals.length, terminals }, data: { terminals } }
  }

  private async read(params: Record<string, unknown>): Promise<CapabilityCommandResult> {
    const stream = this.target(params)
    const sinceRaw = stringParam(params, 'since').trim()
    const lines = numberParam(params, 'lines', 80, 1, TERMINAL_READ_LINES_MAX)
    if (sinceRaw) {
      const since = Number(sinceRaw)
      if (!Number.isFinite(since) || since < 0) throw new CapabilityCommandError('terminal_bad_since', '--since 要用上次结果里的 cursor')
      const output = await this.outputSince(stream.info.id, since)
      return this.result('read', stream.info, { ...output, text: tailText(output.text, lines, Number.MAX_SAFE_INTEGER).text }, { since })
    }
    const text = await this.host.render(stream.buffer, stream.info.cols)
    const shown = tailText(text, lines, Number.MAX_SAFE_INTEGER)
    return this.result('read', stream.info, { text: shown.text, truncated: shown.truncated, cursor: stream.total }, {})
  }

  private async runCommand(params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const command = stringParam(params, 'command').replace(/[\r\n]+$/, '')
    if (!command.trim()) throw new CapabilityCommandError('terminal_command_required', '缺少 --command')
    const until = untilPattern(params)
    const timeoutMs = secondsParam(params, 'timeout', TERMINAL_RUN_TIMEOUT_MS, TERMINAL_RUN_TIMEOUT_MAX_MS)
    const quietMs = secondsParam(params, 'quiet', TERMINAL_QUIET_MS, TERMINAL_RUN_TIMEOUT_MAX_MS)
    const background = flagParam(params, 'background')
    const { stream, created } = await this.pickForRun(params)
    const id = stream.info.id
    await this.guard(stream, `${command}\r`)
    const owner = this.ownerKey()
    lastUsed.set(owner, id)
    return this.withAnnounce(id, 'run', async () => {
      if (created || stream.total === 0) await this.waitReady(id, signal, created ? NEW_TERMINAL_SETTLE_MS : 0)
      const from = this.host.stream(id)?.total ?? stream.total
      if (!this.host.write(id, `${command}\r`)) throw new CapabilityCommandError('terminal_write_failed', '写入终端失败（终端可能已退出）')
      if (background) {
        const startedAt = this.host.now()
        const first = await this.waitFor(id, from, { mode: 'command', timeoutMs: TERMINAL_BACKGROUND_SETTLE_MS, quietMs: Number.POSITIVE_INFINITY, idleMs: SETTLE_IDLE_MS, until }, signal)
        const early = await this.outputSince(id, from)
        if (first === 'completed' || first === 'matched' || first === 'exited') {
          return this.result('run', early.info ?? stream.info, early, { command, state: first, created })
        }
        const backgroundTimeoutMs = secondsParam(params, 'timeout', 0, TERMINAL_BACKGROUND_TIMEOUT_MAX_MS)
        const job = this.watchBackground({ id, from, command, until, timeoutMs: backgroundTimeoutMs || TERMINAL_BACKGROUND_TIMEOUT_MS, timeoutAsked: backgroundTimeoutMs > 0, owner, startedAt, cwd: (early.info ?? stream.info).cwd })
        return this.result('run', early.info ?? stream.info, early, {
          command,
          state: 'background',
          jobId: job.id,
          created,
          hint: '命令在后台运行，它自己结束、命中 --until 或到了你给的 --timeout 时砚会通知你，你空闲时也会叫醒你；期间可以做别的事，不要轮询。你自己停掉的不再通知。看进度用 read --id <id> --since <cursor>，停止用 keys ctrl+c'
        })
      }
      const state = await this.waitFor(id, from, { mode: 'command', timeoutMs, quietMs, idleMs: SETTLE_IDLE_MS, until }, signal)
      const output = await this.outputSince(id, from)
      const info = output.info ?? stream.info
      const hint =
        state === 'quiet' || state === 'timeout'
          ? '命令可能还在运行或在等输入：用 yan terminal read --id <id> --since <cursor> 看后续输出，用 write / keys 交互，必要时 keys ctrl+c 中断'
          : undefined
      return this.result('run', info, output, { command, state, created, ...(hint ? { hint } : {}) })
    })
  }

  private watchBackground(job: { id: string; from: number; command: string; until: RegExp | null; timeoutMs: number; timeoutAsked: boolean; owner: string; startedAt: number; cwd: string }): TerminalJob {
    const controller = new AbortController()
    backgroundJobs.get(job.id)?.abort()
    backgroundJobs.set(job.id, controller)
    agentInterrupts.delete(job.id)
    const record = addTerminalJob({ terminalId: job.id, owners: this.ctx.ownerKeys(), command: job.command, cwd: job.cwd, startedAt: job.startedAt })
    const release = (): void => {
      if (backgroundJobs.get(job.id) === controller) backgroundJobs.delete(job.id)
    }
    void (async () => {
      const waited = await this.waitFor(job.id, job.from, { mode: 'command', timeoutMs: job.timeoutMs, quietMs: Number.POSITIVE_INFINITY, idleMs: SETTLE_IDLE_MS, until: job.until }, controller.signal)
      release()
      const stopping = terminalJob(record.id)?.state === 'stopping'
      if (waited !== 'completed' && waited !== 'matched' && waited !== 'exited' && waited !== 'timeout') {
        updateTerminalJob(record.id, { state: 'stopped', endedAt: this.host.now() })
        return
      }
      const interruptedAt = agentInterrupts.get(job.id)
      agentInterrupts.delete(job.id)
      const byAgent = waited !== 'timeout' && waited !== 'matched' && interruptedAt !== undefined && this.host.now() - interruptedAt <= AGENT_INTERRUPT_GRACE_MS
      const state: TerminalNoticeState = (stopping || byAgent) && waited !== 'timeout' ? 'stopped' : waited
      updateTerminalJob(record.id, { state, endedAt: this.host.now() })
      if (byAgent || (waited === 'timeout' && !job.timeoutAsked)) return
      const output = await this.outputSince(job.id, job.from)
      const tail = tailText(output.text, BACKGROUND_NOTICE_LINES, BACKGROUND_NOTICE_CHARS)
      const text = buildTerminalNotice({
        id: job.id,
        command: job.command,
        state,
        seconds: (this.host.now() - job.startedAt) / 1000,
        exitCode: output.info?.exitCode ?? null,
        output: tail.text,
        truncated: tail.truncated || output.truncated,
        since: job.from
      })
      this.ctx.notify?.(text, () => this.ctx.ownerKeys().some((key) => key && this.host.sameOwner(job.owner, key)), state !== 'stopped')
    })().catch((error: unknown) => {
      release()
      if (terminalJob(record.id)?.endedAt === undefined) updateTerminalJob(record.id, { state: 'stopped', endedAt: this.host.now() })
      console.warn('[terminal-agent] 后台命令监视失败：', error)
    })
    return record
  }

  private async write(params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const stream = this.target(params)
    if (!stream.info.alive) throw new CapabilityCommandError('terminal_exited', '终端已退出')
    const text = stringParam(params, 'text')
    const data = flagParam(params, 'enter') ? `${text}\r` : text
    if (!data) throw new CapabilityCommandError('terminal_text_required', '缺少 --text（要回车就加 --enter）')
    return this.send(stream, data, 'write', params, signal)
  }

  private async keys(params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const stream = this.target(params)
    if (!stream.info.alive) throw new CapabilityCommandError('terminal_exited', '终端已退出')
    const list = stringParam(params, 'keys').split(/[,\s]+/).filter(Boolean)
    if (list.length === 0) throw new CapabilityCommandError('terminal_keys_required', '缺少 --keys，例如 --keys ctrl+c 或 --keys up,enter')
    const { data, unknown } = keysToSequence(list)
    if (unknown.length > 0) {
      throw new CapabilityCommandError('terminal_bad_keys', `不认识的按键：${unknown.join(', ')}。可用：enter tab escape backspace delete up down left right home end pageup pagedown space ctrl+<字母> 或单个字母数字`)
    }
    return this.send(stream, data, 'keys', params, signal)
  }

  private async send(stream: TerminalStream, data: string, action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const id = stream.info.id
    await this.guard(stream, data)
    const waitMs = numberParam(params, 'wait', TERMINAL_WRITE_WAIT_MS, 0, TERMINAL_WRITE_WAIT_MAX_MS)
    return this.withAnnounce(id, action, async () => {
      const from = this.host.stream(id)?.total ?? stream.total
      if (!this.host.write(id, data)) throw new CapabilityCommandError('terminal_write_failed', '写入终端失败（终端可能已退出）')
      if (data.includes('\x03') && backgroundJobs.has(id)) agentInterrupts.set(id, this.host.now())
      const state = waitMs > 0 ? await this.waitFor(id, from, { mode: 'settle', timeoutMs: waitMs, quietMs: waitMs, idleMs: WRITE_IDLE_MS, until: null }, signal) : 'settled'
      const output = await this.outputSince(id, from)
      return this.result(action, output.info ?? stream.info, output, { state })
    })
  }

  private async start(params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const stream = this.open(params)
    const id = stream.info.id
    lastUsed.set(this.ownerKey(), id)
    return this.withAnnounce(id, 'start', async () => {
      await this.waitReady(id, signal)
      const latest = this.host.stream(id)
      const text = latest ? await this.host.render(latest.buffer, latest.info.cols) : ''
      return this.result('start', latest?.info ?? stream.info, { text, truncated: false, cursor: latest?.total ?? 0 }, {})
    })
  }

  private stop(params: Record<string, unknown>): CapabilityCommandResult {
    const stream = this.target(params)
    if (!agentTerminals.has(stream.info.id)) {
      throw new CapabilityCommandError('terminal_not_agent_opened', '这个终端不是你开的，不能直接关闭；要停下里面的程序用 keys ctrl+c')
    }
    backgroundJobs.get(stream.info.id)?.abort()
    backgroundJobs.delete(stream.info.id)
    this.host.kill(stream.info.id)
    agentTerminals.delete(stream.info.id)
    typedLines.delete(stream.info.id)
    terminalLocations.delete(stream.info.id)
    userInputChains.delete(stream.info.id)
    plainStreams.delete(stream.info.id)
    truncatedPlains.delete(stream.info.id)
    return { summary: { kind: 'terminal', action: 'stop', id: stream.info.id, stopped: true } }
  }
}
