import { execFile, spawn } from 'node:child_process'
import {
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync
} from 'node:fs'
import { access, copyFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PI_AGENT_DIR } from './paths'

export const CURRENT_SESSION_VERSION = 3

export const DEFAULT_SHARE_VIEWER_URL = 'https://pi.dev/session/'

export const DEFAULT_MAX_IMPORT_BYTES = 64 * 1024 * 1024

export const DEFAULT_GH_TIMEOUT_MS = 20_000

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

export interface LiteSessionEntry {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
  [key: string]: unknown
}

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
  entries: LiteSessionEntry[]
  leafId: string | null
}

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  error?: string
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

export interface NativeSessionIoContext {
  agentDir?: () => string
  piCommand?: () => { command: string; args: string[] } | null
  runCommand?: CommandRunner
  now?: () => Date
  newId?: () => string
}

let ctx: NativeSessionIoContext = {}

export function configureNativeSessionIo(next: NativeSessionIoContext): void {
  ctx = next
}

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

function asEntry(value: unknown): LiteSessionEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string') return null
  return record as LiteSessionEntry
}

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function readSessionFile(
  path: string,
  maxBytes: number = DEFAULT_MAX_IMPORT_BYTES
): Promise<{ ok: true; value: ParsedSessionFile; sizeBytes: number } | SessionIoFailure> {
  const source = resolve(String(path ?? ''))
  if (!path || !(await pathExists(source))) return fail('not_found', `找不到会话文件：${source}`)
  let stats
  try {
    stats = await stat(source)
  } catch (error) {
    return fail('not_found', `无法读取会话文件：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!stats.isFile()) return fail('invalid_path', `不是一个文件：${source}`)
  if (stats.size > maxBytes) {
    return fail('too_large', `会话文件 ${stats.size} 字节，超过上限 ${maxBytes} 字节，拒绝导入`)
  }
  let text: string
  try {
    text = await readFile(source, 'utf8')
  } catch (error) {
    return fail('not_found', `无法读取会话文件：${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = parseSessionJsonl(text)
  if (!parsed.ok) return parsed
  return { ok: true, value: parsed.value, sizeBytes: stats.size }
}

export async function inspectSessionJsonl(
  path: string,
  maxBytes?: number
): Promise<
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
  | SessionIoFailure
> {
  const read = await readSessionFile(path, maxBytes)
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

export interface ShareTool {
  name: string
  description: string
  parameters: unknown
}

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

export type ExportScope = 'branch' | 'full'

export interface ExportJsonlRequest {
  sourcePath: string
  outputPath: string
  scope?: ExportScope
  leafId?: string | null
  overwrite?: boolean
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

async function sameSessionFile(sourcePath: string, outputPath: string): Promise<boolean> {
  const key = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file
  if (key(resolve(sourcePath)) === key(resolve(outputPath))) return true
  try {
    if (key(await realpath(sourcePath)) === key(await realpath(outputPath))) return true
    const source = await stat(sourcePath, { bigint: true })
    const output = await stat(outputPath, { bigint: true })
    return source.ino !== 0n && source.dev === output.dev && source.ino === output.ino
  } catch {
    return false
  }
}

async function writeSessionExport(sourcePath: string, outputPath: string, text: string, overwrite: boolean): Promise<void> {
  if (await sameSessionFile(sourcePath, outputPath)) throw new Error('导出目标不能是源会话文件本身或它的别名')
  if (!overwrite) {
    const handle = await open(outputPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL)
    try {
      await handle.writeFile(text, 'utf8')
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(outputPath, { force: true }).catch(() => undefined)
      throw error
    }
    await handle.close()
    return
  }
  const temp = `${outputPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, outputPath)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function exportSessionJsonl(
  request: ExportJsonlRequest
): Promise<ExportJsonlSuccess | SessionIoFailure> {
  if (!request.outputPath || !String(request.outputPath).trim()) {
    return fail('invalid_path', '缺少导出目标路径')
  }
  const read = await readSessionFile(request.sourcePath, request.maxBytes)
  if (!read.ok) return read
  const outputPath = resolve(String(request.outputPath))
  const sourcePath = resolve(String(request.sourcePath))
  if (await sameSessionFile(sourcePath, outputPath)) return fail('invalid_path', '导出目标不能是源会话文件本身或它的别名')
  if ((await pathExists(outputPath)) && !request.overwrite) {
    return fail('exists', `导出目标已存在：${outputPath}（pi 原生会覆盖，这里要求显式确认）`)
  }
  const scope: ExportScope = request.scope === 'full' ? 'full' : 'branch'
  const leafId = request.leafId === undefined ? read.value.leafId : request.leafId
  let entryCount = read.value.entries.length
  try {
    await mkdir(dirname(outputPath), { recursive: true })
    if (scope === 'full') {
      const raw = await readFile(sourcePath, 'utf8')
      await writeSessionExport(sourcePath, outputPath, raw.endsWith('\n') ? raw : `${raw}\n`, request.overwrite === true)
    } else {
      const { header, entries } = read.value
      let branch: LiteSessionEntry[]
      try {
        branch = buildActiveBranch(entries, leafId)
      } catch {
        return fail('invalid_path', '导出分支的叶子不在当前会话条目中（未写入任何文件）')
      }
      const text = serializeSessionBranch({
        sessionId: header.id,
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        entries,
        leafId,
        ...(request.forShare ? { forShare: true } : {}),
        ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
        ...(request.tools !== undefined ? { tools: request.tools } : {})
      })
      await writeSessionExport(sourcePath, outputPath, text, request.overwrite === true)
      entryCount = branch.length
    }
  } catch (error) {
    return fail(
      (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'invalid_path',
      `写入导出文件失败：${error instanceof Error ? error.message : String(error)}`
    )
  }
  return { ok: true, outputPath, scope, entryCount }
}

export function encodeSessionDirName(cwd: string): string {
  const resolvedCwd = resolve(String(cwd ?? ''))
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return safePath
}

export function defaultSessionDirFor(cwd: string, agentDirOverride?: string): string {
  const override = process.env.YAN_SESSIONS_DIR?.trim()
  if (override) return override
  return join(agentDirOverride ?? agentDirNow(), 'sessions', encodeSessionDirName(cwd))
}

export interface ImportSessionRequest {
  sourcePath: string
  cwd?: string
  sessionDir?: string
  freshSessionId?: boolean
  maxBytes?: number
}

export interface ImportSessionSuccess {
  ok: true
  sourcePath: string
  destinationPath: string
  sessionDir: string
  alreadyStored: boolean
  sessionId: string
  entryCount: number
}

export async function importSessionJsonl(
  request: ImportSessionRequest
): Promise<ImportSessionSuccess | SessionIoFailure> {
  const read = await readSessionFile(request.sourcePath, request.maxBytes)
  if (!read.ok) return read
  const sourcePath = resolve(String(request.sourcePath))
  const sessionDir = resolve(
    String(request.sessionDir ?? defaultSessionDirFor(request.cwd ?? process.cwd()))
  )
  try {
    await mkdir(sessionDir, { recursive: true })
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
    while (await pathExists(destinationPath)) {
      destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`)
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (request.freshSessionId) {
          const text = [{ ...read.value.header, id: importedId }, ...read.value.entries].map(entry => JSON.stringify(entry)).join('\n') + '\n'
          await writeFile(destinationPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        } else {
          await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL)
        }
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST' && attempt < 2) {
          while (await pathExists(destinationPath)) {
            destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`)
          }
          continue
        }
        return fail(
          'exists',
          `复制会话失败（不覆盖已有文件）：${error instanceof Error ? error.message : String(error)}`
        )
      }
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

export interface GhStatus {
  installed: boolean
  authenticated: boolean
  detail: string
}

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
  canShareViaGist: boolean
  piAvailable: boolean
}

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
  outputDir?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface PrepareShareSuccess {
  ok: true
  htmlPath: string
  tempDir?: string
  availability: ShareAvailability
}

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
      }
    }
    return exported
  }
  const availability = await shareAvailability(
    request.signal ? { signal: request.signal } : {}
  )
  return { ok: true, htmlPath, ...(tempDir ? { tempDir } : {}), availability }
}

export function shareViewerUrl(gistId: string): string {
  const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL
  return `${baseUrl}#${gistId}`
}

export interface ShareViaGistRequest {
  htmlPath: string
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
      }
    }
  }
}

export function disposeShareArtifacts(dir: string): void {
  if (!String(dir ?? '').trim()) return
  const target = resolve(String(dir))
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
  }
}
