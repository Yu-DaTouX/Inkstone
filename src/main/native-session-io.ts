/**
 * pi 原生会话 IO：JSONL 导入 / 导出、分享准备与执行。
 *
 * ── 上游依据（随包 pi 1.2.0，`resources/pi-runtime/current.json`）──
 *
 * 1. `docs/session-format.md`
 *    —— 会话是 JSONL，第一行是 `{type:"session",version,id,timestamp,cwd}`，
 *       其余条目按 `id`/`parentId` 组成树；条目都有 `type` 字段。
 *
 * 2. `dist/core/session-export.js` `serializeSessionBranch()`
 *    —— `/export <x.jsonl>` 的 JSONL 只序列化**活动分支**（从当前叶子回溯到根），
 *       头部重写为 `version:3` + 新时间戳，条目 `parentId` 被重新串成一条链。
 *
 * 3. `dist/core/agent-session-runtime.js` `importFromJsonl()`
 *    —— `/import <x.jsonl>` 把源文件**复制**进当前会话目录：
 *       目标名 = `basename(source)`，已存在时追加 `-1`、`-2`…；
 *       复制用 `COPYFILE_EXCL`，**绝不覆盖**已有会话；源文件原样保留。
 *       落点由当前 SessionManager 的 `getSessionDir()` 决定。
 *
 * 4. `dist/modes/interactive/session-share.js` `shareSession()`
 *    —— `/share` 的顺序是：先导出带 `pi.share` 尾条目的 JSONL 走 Radius 上传；
 *       Radius 不可用时回退 `gh`：`gh auth status` → `pi --export` 生成 HTML
 *       → `gh gist create --public=false <html>`；
 *       查看链接 = `getShareViewerUrl(gistId)`（`PI_SHARE_VIEWER_URL` ||
 *       `https://pi.dev/session/`）。
 *
 * 5. `dist/main.js` `--export <input> [output]`
 *    —— 官方 HTML 导出的无头 CLI（`exportFromFile()`），主机用它生成 gist 用的 HTML。
 *
 * ── 本模块的边界 ──
 *
 * - 只做文件与外部命令，`child_process.execFile` 的**参数数组**调用，不经过 shell。
 * - 不碰 IPC / preload / Electron 窗口 / pi 进程内状态；不猜任何 API key。
 * - Radius 上传不在主机实现（它需要 pi 进程内的 provider 凭证），
 *   这里显式报告 unavailable，只实现官方回退的 `gh gist` 路径。
 * - 主会话负责文件对话框、覆盖确认，并把结果接到 UI。
 */
import { execFile, spawn } from 'node:child_process'
import {
  constants as fsConstants,
  copyFileSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PI_AGENT_DIR } from './paths'

/** pi 当前会话格式版本（`dist/core/session-manager.js` `CURRENT_SESSION_VERSION`）。 */
export const CURRENT_SESSION_VERSION = 3

/** pi `/share` 的默认查看器基址（`dist/config.js`）。 */
export const DEFAULT_SHARE_VIEWER_URL = 'https://pi.dev/session/'

/** 导入时的默认大小上限。大会话几 MB 到几十 MB；超过一律拒绝，先让用户自查。 */
export const DEFAULT_MAX_IMPORT_BYTES = 64 * 1024 * 1024

/** `gh` 探测与 gist 创建的默认超时。 */
export const DEFAULT_GH_TIMEOUT_MS = 20_000

/** `pi --export` 生成 HTML 的默认超时。 */
export const DEFAULT_PI_EXPORT_TIMEOUT_MS = 120_000

export type SessionIoErrorCode =
  | 'not_found'
  | 'too_large'
  | 'empty'
  | 'invalid_header'
  | 'invalid_json'
  | 'invalid_line'
  | 'exists'
  | 'invalid_path'
  | 'spawn_failed'
  | 'timeout'
  | 'aborted'
  | 'command_failed'
  | 'unavailable'
  | 'invalid_state'

export interface SessionIoFailure {
  ok: false
  code: SessionIoErrorCode
  error: string
}

/** 会话条目：pi 不校验条目内字段，这里只要求 `type` 是字符串。 */
export interface LiteSessionEntry {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
  [key: string]: unknown
}

/** 会话头（`docs/session-format.md`）。 */
export interface LiteSessionHeader {
  type: 'session'
  version?: number
  id: string
  timestamp?: string
  cwd?: string
  parentSession?: string
  [key: string]: unknown
}

export interface ParsedSessionFile {
  header: LiteSessionHeader
  /** 头之后的全部条目，按文件追加顺序（与 pi 的 `getEntries()` 一致）。 */
  entries: LiteSessionEntry[]
  /** 按 pi 的加载规则，叶子就是最后一个有 `id` 的条目。 */
  leafId: string | null
}

export interface CommandResult {
  /** 进程退出码；起不来时为 null。 */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  /** Node 侧错误信息（如 spawn 失败）。 */
  error?: string
  /** `ENOENT` 等 Node 错误码，用于区分「没装 gh」与「gh 报错退出」。 */
  errorCode?: string
}

export interface CommandRunOptions {
  timeoutMs?: number
  signal?: AbortSignal
  cwd?: string
  env?: Record<string, string | undefined>
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunOptions
) => Promise<CommandResult>

/** 注入点：主会话在 `index.ts` 里配置 pi 入口与 agent 目录；测试注入假 runner。 */
export interface NativeSessionIoContext {
  agentDir?: () => string
  /** pi 的启动方式（`resolvePi()` 的 `{cmd,args}`）；分享要跑官方 `--export`。 */
  piCommand?: () => { command: string; args: string[] } | null
  runCommand?: CommandRunner
  now?: () => Date
  newId?: () => string
}

let ctx: NativeSessionIoContext = {}

export function configureNativeSessionIo(next: NativeSessionIoContext): void {
  ctx = next
}

/** 测试用：清掉注入，回到默认实现。 */
export function resetNativeSessionIo(): void {
  ctx = {}
}

function agentDirNow(): string {
  return ctx.agentDir?.() ?? PI_AGENT_DIR
}

function nowDate(): Date {
  return ctx.now?.() ?? new Date()
}

function newId(): string {
  return ctx.newId?.() ?? randomUUID().slice(0, 8)
}

function fail(code: SessionIoErrorCode, error: string): SessionIoFailure {
  return { ok: false, code, error }
}

/* ────────────────────────── 命令执行 ────────────────────────── */

function killTree(child: ReturnType<typeof execFile>): void {
  if (!child || child.killed || child.pid === undefined) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.on('error', () => child.kill('SIGKILL'))
    killer.unref()
  } else {
    child.kill('SIGKILL')
  }
}

/**
 * 默认 runner：`execFile` + 参数数组（不过 shell），带超时与 AbortSignal。
 * Windows 上超时/取消时结束整棵进程树，避免 gh/pi 的子进程残留。
 */
function defaultRunCommand(
  command: string,
  args: string[],
  options: CommandRunOptions
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    let settled = false
    let timedOut = false
    let aborted = false
    let child: ReturnType<typeof execFile>
    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS)
    const onAbort = (): void => {
      aborted = true
      killTree(child)
    }
    child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, ...options.env }
      },
      (error, stdout, stderr) => {
        const errorCode =
          error && typeof (error as NodeJS.ErrnoException).code === 'string'
            ? String((error as NodeJS.ErrnoException).code)
            : undefined
        const code = error
          ? typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : null
          : 0
        finish({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut,
          aborted,
          error: error ? (error as Error).message : undefined,
          errorCode
        })
      }
    )
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function run(
  command: string,
  args: string[],
  options: CommandRunOptions = {}
): Promise<CommandResult> {
  return (ctx.runCommand ?? defaultRunCommand)(command, args, options)
}

/* ────────────────────────── JSONL 解析与校验 ────────────────────────── */

function asEntry(value: unknown): LiteSessionEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string') return null
  return record as LiteSessionEntry
}

/**
 * 逐行校验 JSONL 文本。
 *
 * 与 pi 的 `parseSessionEntries()`（跳过坏行）不同：导入是**写用户会话目录**的
 * 操作，这里选择更严格——坏行直接拒绝，避免把半个会话复制进去。空行忽略。
 */
export function parseSessionJsonl(
  text: string
): { ok: true; value: ParsedSessionFile } | SessionIoFailure {
  const lines = text.split(/\r?\n/)
  const entries: LiteSessionEntry[] = []
  let header: LiteSessionHeader | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return fail('invalid_json', `第 ${index + 1} 行不是合法 JSON，拒绝导入`)
    }
    const entry = asEntry(parsed)
    if (!entry) {
      return fail('invalid_line', `第 ${index + 1} 行缺少字符串 type 字段，拒绝导入`)
    }
    if (!header) {
      if (entry.type !== 'session' || typeof (entry as { id?: unknown }).id !== 'string') {
        return fail('invalid_header', '第一行不是 pi 会话头（type:"session" 且 id 为字符串）')
      }
      header = entry as LiteSessionHeader
      continue
    }
    entries.push(entry)
  }
  if (!header) return fail('empty', '文件里没有 pi 会话头，拒绝导入')
  let leafId: string | null = null
  for (const entry of entries) {
    if (typeof entry.id === 'string') leafId = entry.id
  }
  return { ok: true, value: { header, entries, leafId } }
}

/** 读文件 + 大小上限 + 解析。只读，不改动源文件。 */
export function readSessionFile(
  path: string,
  maxBytes: number = DEFAULT_MAX_IMPORT_BYTES
): { ok: true; value: ParsedSessionFile; sizeBytes: number } | SessionIoFailure {
  const source = resolve(String(path ?? ''))
  if (!path || !existsSync(source)) return fail('not_found', `找不到会话文件：${source}`)
  let stats
  try {
    stats = statSync(source)
  } catch (error) {
    return fail('not_found', `无法读取会话文件：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!stats.isFile()) return fail('invalid_path', `不是一个文件：${source}`)
  if (stats.size > maxBytes) {
    return fail('too_large', `会话文件 ${stats.size} 字节，超过上限 ${maxBytes} 字节，拒绝导入`)
  }
  let text: string
  try {
    text = readFileSync(source, 'utf8')
  } catch (error) {
    return fail('not_found', `无法读取会话文件：${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = parseSessionJsonl(text)
  if (!parsed.ok) return parsed
  return { ok: true, value: parsed.value, sizeBytes: stats.size }
}

/** 只做校验，不写盘：主会话可在挑文件后先给用户看诊断。 */
export function inspectSessionJsonl(
  path: string,
  maxBytes?: number
):
  | {
      ok: true
      path: string
      sizeBytes: number
      sessionId: string
      version: number
      cwd?: string
      entryCount: number
      leafId: string | null
    }
  | SessionIoFailure {
  const read = readSessionFile(path, maxBytes)
  if (!read.ok) return read
  const { header, entries, leafId } = read.value
  return {
    ok: true,
    path: resolve(String(path)),
    sizeBytes: read.sizeBytes,
    sessionId: header.id,
    version: header.version ?? 1,
    ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
    entryCount: entries.length,
    leafId
  }
}

/* ────────────────────────── 分支与序列化 ────────────────────────── */

/**
 * 活动分支：从叶子沿 `parentId` 回溯到根。
 *
 * 与 pi 的 `buildSessionPath()` 一致：叶子是最后一个有 `id` 的条目；
 * 父链断裂即停止（pi 对孤儿条目也是走到找不到父亲为止）。
 */
export function buildActiveBranch(
  entries: LiteSessionEntry[],
  leafId?: string | null
): LiteSessionEntry[] {
  const byId = new Map<string, LiteSessionEntry>()
  for (const entry of entries) {
    if (typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  if (leafId === null) return []
  const leaf = leafId === undefined ? entries[entries.length - 1] : byId.get(leafId)
  if (!leaf && leafId !== undefined) throw new Error('原生会话叶子不在导出条目中')
  if (!leaf) return []
  const path: LiteSessionEntry[] = []
  let current: LiteSessionEntry | undefined = leaf
  let guard = 0
  while (current && guard++ <= entries.length + 1) {
    path.push(current)
    const parentId: string | null = typeof current.parentId === 'string' ? current.parentId : null
    current = parentId ? byId.get(parentId) : undefined
  }
  return path.reverse()
}

/** 分享用的工具声明（对应 pi 的 `session.state.tools` 投影）。 */
export interface ShareTool {
  name: string
  description: string
  parameters: unknown
}

/**
 * `pi.share` 尾条目 —— 与 `session-share.js` `createShareTrailingEntries()` 同形。
 *
 * 它只为 Radius 上传的 JSONL 服务（HTML 导出不含它）。主机不实现 Radius，
 * 这里保留完整格式，方便主会话需要时复用。
 */
export function buildShareTrailingEntry(
  data: { systemPrompt: string; tools: ShareTool[] },
  parentId: string | null,
  timestamp: string
): LiteSessionEntry {
  return {
    type: 'custom',
    customType: 'pi.share',
    id: newId(),
    parentId,
    timestamp,
    data: { systemPrompt: data.systemPrompt, tools: data.tools }
  }
}

/**
 * 序列化活动分支为 JSONL —— 与 `serializeSessionBranch()` 同语义。
 *
 * 头重写为 `version:3` + 新时间戳；条目 `parentId` 重串成线性链；
 * `forShare` 时在末尾追加 `pi.share` 条目（同时也把它的 `parentId` 接上）。
 */
export function serializeSessionBranch(input: {
  sessionId: string
  cwd: string
  entries: LiteSessionEntry[]
  leafId?: string | null
  forShare?: boolean
  systemPrompt?: string
  tools?: ShareTool[]
  timestamp?: string
}): string {
  const timestamp = input.timestamp ?? nowDate().toISOString()
  const header: LiteSessionHeader = {
    type: 'session',
    version: CURRENT_SESSION_VERSION,
    id: input.sessionId,
    timestamp,
    cwd: input.cwd
  }
  const branch = buildActiveBranch(input.entries, input.leafId)
  const lines: LiteSessionEntry[] = [header]
  let parentId: string | null = null
  for (const entry of branch) {
    lines.push({ ...entry, parentId })
    parentId = typeof entry.id === 'string' ? entry.id : null
  }
  if (input.forShare) {
    lines.push(
      buildShareTrailingEntry(
        { systemPrompt: input.systemPrompt ?? '', tools: input.tools ?? [] },
        parentId,
        timestamp
      )
    )
  }
  return `${lines.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

/* ────────────────────────── 导出 ────────────────────────── */

export type ExportScope = 'branch' | 'full'

export interface ExportJsonlRequest {
  sourcePath: string
  outputPath: string
  /**
   * `branch`（默认）= pi `/export *.jsonl` 的原生语义：只导出活动分支。
   * `full` = 主机便利项：把整个文件原样复制（含被放弃的分支），**不是** pi 命令。
   */
  scope?: ExportScope
  /** Live native leaf overrides the file tail after in-memory tree navigation. Null means an empty branch. */
  leafId?: string | null
  /** 默认 false：不覆盖已有输出；pi 原生会直接覆盖，这里让主会话显式确认。 */
  overwrite?: boolean
  /** 仅 `branch` 生效：追加 `pi.share` 尾条目。 */
  forShare?: boolean
  systemPrompt?: string
  tools?: ShareTool[]
  maxBytes?: number
}

export interface ExportJsonlSuccess {
  ok: true
  outputPath: string
  scope: ExportScope
  entryCount: number
}

function sameSessionFile(sourcePath: string, outputPath: string): boolean {
  const key = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file
  if (key(resolve(sourcePath)) === key(resolve(outputPath))) return true
  try {
    if (key(realpathSync(sourcePath)) === key(realpathSync(outputPath))) return true
    const source = statSync(sourcePath, { bigint: true })
    const output = statSync(outputPath, { bigint: true })
    return source.ino !== 0n && source.dev === output.dev && source.ino === output.ino
  } catch {
    return false
  }
}

/** Open without truncation so a file alias is rejected before its contents can change. */
function writeSessionExport(sourcePath: string, outputPath: string, text: string, overwrite: boolean): void {
  if (sameSessionFile(sourcePath, outputPath)) throw new Error('导出目标不能是源会话文件本身或它的别名')
  const source = statSync(sourcePath, { bigint: true })
  const fd = openSync(outputPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | (overwrite ? 0 : fsConstants.O_EXCL))
  try {
    const output = fstatSync(fd, { bigint: true })
    if (source.ino !== 0n && source.dev === output.dev && source.ino === output.ino) {
      throw new Error('导出目标不能是源会话文件本身或它的别名')
    }
    ftruncateSync(fd, 0)
    writeFileSync(fd, text, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function exportSessionJsonl(
  request: ExportJsonlRequest
): ExportJsonlSuccess | SessionIoFailure {
  if (!request.outputPath || !String(request.outputPath).trim()) {
    return fail('invalid_path', '缺少导出目标路径')
  }
  const read = readSessionFile(request.sourcePath, request.maxBytes)
  if (!read.ok) return read
  const outputPath = resolve(String(request.outputPath))
  const sourcePath = resolve(String(request.sourcePath))
  if (sameSessionFile(sourcePath, outputPath)) return fail('invalid_path', '导出目标不能是源会话文件本身或它的别名')
  if (existsSync(outputPath) && !request.overwrite) {
    return fail('exists', `导出目标已存在：${outputPath}（pi 原生会覆盖，这里要求显式确认）`)
  }
  const scope: ExportScope = request.scope === 'full' ? 'full' : 'branch'
  try {
    mkdirSync(dirname(outputPath), { recursive: true })
    if (scope === 'full') {
      const raw = readFileSync(sourcePath, 'utf8')
      writeSessionExport(sourcePath, outputPath, raw.endsWith('\n') ? raw : `${raw}\n`, request.overwrite === true)
    } else {
      const { header, entries, leafId } = read.value
      const text = serializeSessionBranch({
        sessionId: header.id,
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        entries,
        leafId: request.leafId === undefined ? leafId : request.leafId,
        ...(request.forShare ? { forShare: true } : {}),
        ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
        ...(request.tools !== undefined ? { tools: request.tools } : {})
      })
      writeSessionExport(sourcePath, outputPath, text, request.overwrite === true)
    }
  } catch (error) {
    return fail(
      (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'invalid_path',
      `写入导出文件失败：${error instanceof Error ? error.message : String(error)}`
    )
  }
  const entryCount =
    scope === 'full'
      ? read.value.entries.length
      : buildActiveBranch(read.value.entries, request.leafId === undefined ? read.value.leafId : request.leafId).length
  return { ok: true, outputPath, scope, entryCount }
}

/* ────────────────────────── 导入 ────────────────────────── */

/** 会话目录编码：与 pi `getDefaultSessionDirPath()` 的 `--<cwd>--` 规则一致。 */
export function encodeSessionDirName(cwd: string): string {
  const resolvedCwd = resolve(String(cwd ?? ''))
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return safePath
}

/**
 * 目标会话目录。
 *
 * - 主机显式接管（`YAN_SESSIONS_DIR`）时 pi 用 `--session-dir` 平铺写入，这里也平铺。
 * - 否则复刻 pi 的默认目录：`<agentDir>/sessions/--<encoded-cwd>--`。
 */
export function defaultSessionDirFor(cwd: string, agentDirOverride?: string): string {
  const override = process.env.YAN_SESSIONS_DIR?.trim()
  if (override) return override
  return join(agentDirOverride ?? agentDirNow(), 'sessions', encodeSessionDirName(cwd))
}

export interface ImportSessionRequest {
  sourcePath: string
  /** 目标会话所属的项目目录；用于推导默认会话目录。 */
  cwd?: string
  /** 显式指定会话目录（覆盖推导）。 */
  sessionDir?: string
  /** Desktop indices key sessions by id; an imported copy can explicitly receive a fresh identity. */
  freshSessionId?: boolean
  maxBytes?: number
}

export interface ImportSessionSuccess {
  ok: true
  sourcePath: string
  destinationPath: string
  sessionDir: string
  /** 源文件已在目标位置（未复制）。 */
  alreadyStored: boolean
  sessionId: string
  entryCount: number
}

/**
 * 导入 JSONL 到目标 pi 会话目录，**绝不覆盖**已有会话。
 *
 * 复刻 `importFromJsonl()`：同名冲突时追加 `-1`、`-2`…；
 * 复制用 `COPYFILE_EXCL`；源文件保留（只读）。
 * 校验用更严格的逐行检查（见 `parseSessionJsonl()`）。
 */
export function importSessionJsonl(
  request: ImportSessionRequest
): ImportSessionSuccess | SessionIoFailure {
  const read = readSessionFile(request.sourcePath, request.maxBytes)
  if (!read.ok) return read
  const sourcePath = resolve(String(request.sourcePath))
  const sessionDir = resolve(
    String(request.sessionDir ?? defaultSessionDirFor(request.cwd ?? process.cwd()))
  )
  try {
    mkdirSync(sessionDir, { recursive: true })
  } catch (error) {
    return fail(
      'invalid_path',
      `无法创建会话目录 ${sessionDir}：${error instanceof Error ? error.message : String(error)}`
    )
  }
  const importedId = request.freshSessionId ? randomUUID() : read.value.header.id
  let destinationPath = join(sessionDir, request.freshSessionId ? `${new Date().toISOString().replace(/[:.]/g, '-')}_${importedId}.jsonl` : basename(sourcePath))
  const alreadyStored = !request.freshSessionId && resolve(destinationPath) === sourcePath
  if (!alreadyStored) {
    const { name, ext } = parse(destinationPath)
    let suffix = 1
    while (existsSync(destinationPath)) {
      destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`)
    }
  }
  if (!alreadyStored) {
    try {
      if (request.freshSessionId) {
        const text = [{ ...read.value.header, id: importedId }, ...read.value.entries].map(entry => JSON.stringify(entry)).join('\n') + '\n'
        writeFileSync(destinationPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      } else {
        copyFileSync(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL)
      }
    } catch (error) {
      return fail(
        'exists',
        `复制会话失败（不覆盖已有文件）：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return {
    ok: true,
    sourcePath,
    destinationPath,
    sessionDir,
    alreadyStored,
    sessionId: importedId,
    entryCount: read.value.entries.length
  }
}

/* ────────────────────────── 分享 ────────────────────────── */

export interface GhStatus {
  installed: boolean
  authenticated: boolean
  detail: string
}

/** `gh auth status` —— 与 `/share` 里的探测一致，只判断能否用，不解析凭证。 */
export async function checkGhStatus(options: CommandRunOptions = {}): Promise<GhStatus> {
  const result = await run('gh', ['auth', 'status'], {
    timeoutMs: options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (result.errorCode === 'ENOENT' || (result.code === null && result.error)) {
    return { installed: false, authenticated: false, detail: result.error ?? 'gh 未安装' }
  }
  if (result.timedOut) return { installed: true, authenticated: false, detail: 'gh auth status 超时' }
  if (result.code === 0) return { installed: true, authenticated: true, detail: 'gh 已登录' }
  return {
    installed: true,
    authenticated: false,
    detail: result.stderr.trim() || result.stdout.trim() || `gh auth status 退出码 ${result.code}`
  }
}

export interface ShareAvailability {
  gh: GhStatus
  radius: { available: false; reason: string }
  /** gh 可用且已登录时才为 true。 */
  canShareViaGist: boolean
  /** pi 入口是否解析出来（HTML 导出要用）。 */
  piAvailable: boolean
}

/**
 * 分享前探测。Radius 路径需要 pi 进程内的 provider 凭证，
 * 主机不实现、也不猜凭证，因此恒为 unavailable。
 */
export async function shareAvailability(options: CommandRunOptions = {}): Promise<ShareAvailability> {
  const gh = await checkGhStatus(options)
  const piAvailable = !!ctx.piCommand?.()
  return {
    gh,
    radius: {
      available: false,
      reason:
        '主机侧未接入 Radius 上传：pi 交互式 /share 的 Radius 路径需要 pi 进程内的 provider 凭证；主机不猜测凭证，也不自建上传后端。'
    },
    canShareViaGist: gh.installed && gh.authenticated && piAvailable,
    piAvailable
  }
}

export interface ExportHtmlRequest {
  sessionFile: string
  outputPath: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** 官方 HTML 导出：`pi --export <session.jsonl> <output.html>`（`dist/main.js`）。 */
export async function exportSessionHtml(
  request: ExportHtmlRequest
): Promise<{ ok: true; outputPath: string } | SessionIoFailure> {
  const pi = ctx.piCommand?.()
  if (!pi) return fail('unavailable', '没有解析到 pi 入口，无法生成分享用 HTML')
  const sessionFile = resolve(String(request.sessionFile ?? ''))
  if (!existsSync(sessionFile)) return fail('not_found', `找不到会话文件：${sessionFile}`)
  const outputPath = resolve(String(request.outputPath ?? ''))
  try {
    mkdirSync(dirname(outputPath), { recursive: true })
  } catch (error) {
    return fail('invalid_path', `无法创建输出目录：${error instanceof Error ? error.message : String(error)}`)
  }
  const result = await run(pi.command, [...pi.args, '--export', sessionFile, outputPath], {
    timeoutMs: request.timeoutMs ?? DEFAULT_PI_EXPORT_TIMEOUT_MS,
    ...(request.signal ? { signal: request.signal } : {}),
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      PI_CODING_AGENT_DIR: agentDirNow()
    }
  })
  if (result.aborted) return fail('aborted', '导出已取消')
  if (result.timedOut) return fail('timeout', '导出 HTML 超时')
  if (result.code !== 0 || !existsSync(outputPath)) {
    return fail(
      'command_failed',
      `pi --export 失败：${result.stderr.trim() || result.error || `退出码 ${result.code}`}`
    )
  }
  return { ok: true, outputPath }
}

export interface PrepareShareRequest {
  sessionFile: string
  /** 省略时在系统临时目录建 `pi-share-*`，由调用方 `disposeShareArtifacts()` 清理。 */
  outputDir?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface PrepareShareSuccess {
  ok: true
  htmlPath: string
  /** 本次为准备而创建的临时目录；调用方负责清理。 */
  tempDir?: string
  availability: ShareAvailability
}

/**
 * 准备要分享的 HTML（官方 `pi --export`），并报告 gh/Radius 可用性。
 *
 * 与 `/share` 的区别：pi 主路径先试 Radius；主机只实现 gh gist 回退，
 * 所以这里不因 Radius 不可用而失败，availability 里如实标注。
 */
export async function prepareShare(
  request: PrepareShareRequest
): Promise<PrepareShareSuccess | SessionIoFailure> {
  let outputDir = request.outputDir ? resolve(String(request.outputDir)) : undefined
  let tempDir: string | undefined
  if (!outputDir) {
    try {
      tempDir = mkdtempSync(join(tmpdir(), 'pi-share-'))
      outputDir = tempDir
    } catch (error) {
      return fail('invalid_path', `无法创建分享临时目录：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const htmlPath = join(outputDir, 'session.html')
  const exported = await exportSessionHtml({
    sessionFile: request.sessionFile,
    outputPath: htmlPath,
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.signal ? { signal: request.signal } : {})
  })
  if (!exported.ok) {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响返回 */
      }
    }
    return exported
  }
  const availability = await shareAvailability(
    request.signal ? { signal: request.signal } : {}
  )
  return { ok: true, htmlPath, ...(tempDir ? { tempDir } : {}), availability }
}

/** 查看链接 —— 与 pi `getShareViewerUrl()` 一致（`PI_SHARE_VIEWER_URL` 可覆盖）。 */
export function shareViewerUrl(gistId: string): string {
  const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL
  return `${baseUrl}#${gistId}`
}

export interface ShareViaGistRequest {
  htmlPath: string
  /** Re-check foreground ownership after gh auth but before irreversible upload. */
  beforeUpload?: () => boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ShareViaGistSuccess {
  ok: true
  gistUrl: string
  gistId: string
  viewerUrl: string
}

/**
 * 官方回退的分享执行：`gh gist create --public=false <html>`。
 *
 * 参数是数组、不过 shell；支持取消与超时；只解析 gh 输出的 URL。
 * 不做真实上传的自动化测试——由测试注入假 runner 校验参数与解析。
 */
export async function shareViaGist(
  request: ShareViaGistRequest
): Promise<ShareViaGistSuccess | SessionIoFailure> {
  const htmlPath = resolve(String(request.htmlPath ?? ''))
  if (!htmlPath || !existsSync(htmlPath)) return fail('not_found', `找不到要分享的 HTML：${htmlPath}`)
  const status = await checkGhStatus({
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.signal ? { signal: request.signal } : {})
  })
  if (!status.installed) return fail('unavailable', '未安装 GitHub CLI（gh）。请先安装：https://cli.github.com/')
  if (!status.authenticated) {
    return fail('unavailable', `GitHub CLI 未登录。请先运行 gh auth login（${status.detail}）`)
  }
  if (request.beforeUpload && !request.beforeUpload()) return fail('aborted', '会话已切换，已取消上传')
  const result = await run('gh', ['gist', 'create', '--public=false', htmlPath], {
    timeoutMs: request.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS,
    ...(request.signal ? { signal: request.signal } : {})
  })
  if (result.aborted) return fail('aborted', '分享已取消')
  if (result.timedOut) return fail('timeout', '创建 gist 超时')
  if (result.code !== 0) {
    return fail(
      'command_failed',
      `创建 gist 失败：${result.stderr.trim() || result.error || `退出码 ${result.code}`}`
    )
  }
  const gistUrl = result.stdout.trim().split(/\s+/).pop() ?? ''
  const gistId = gistUrl.split('/').filter(Boolean).pop() ?? ''
  if (!gistUrl || !gistId) return fail('invalid_state', '无法从 gh 输出解析 gist 链接')
  return { ok: true, gistUrl, gistId, viewerUrl: shareViewerUrl(gistId) }
}

/** 一步完成：准备 HTML + gh gist 分享 + 清理临时目录。 */
export async function shareSession(
  request: PrepareShareRequest
): Promise<ShareViaGistSuccess | SessionIoFailure> {
  const prepared = await prepareShare(request)
  if (!prepared.ok) return prepared
  try {
    const shared = await shareViaGist({
      htmlPath: prepared.htmlPath,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.signal ? { signal: request.signal } : {})
    })
    return shared
  } finally {
    if (prepared.tempDir) {
      try {
        rmSync(prepared.tempDir, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响结果 */
      }
    }
  }
}

/** 清理 `prepareShare()` 建的临时目录（含 HTML）。 */
export function disposeShareArtifacts(dir: string): void {
  if (!String(dir ?? '').trim()) return
  const target = resolve(String(dir))
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    /* 幂等：清理失败不抛 */
  }
}
