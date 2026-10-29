import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CAPABILITY_API_VERSION = 1

export const CAPABILITY_RESULT_MAX_BYTES = 4 * 1024 * 1024

export const CAPABILITY_OPS_MAX_FILES = 500

export const CAPABILITY_OPS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface YanCliEnv {
  url: string
  token: string
  sessionId: string
  projectId: string
  binDir: string
}

export interface CapabilityContext {
  sessionId: string
  projectId: string
}

export interface CapabilityCommandResult {
  data?: unknown
  summary: Record<string, unknown>
}

export interface CapabilityHandlers {
  run(
    command: string,
    params: Record<string, unknown>,
    ctx: CapabilityContext,
    signal?: AbortSignal
  ): Promise<CapabilityCommandResult>
}

export class CapabilityCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'CapabilityCommandError'
  }
}

export interface CapabilityServerOptions {
  handlers?: CapabilityHandlers
  opsDir: string
  allowCommands?: string[]
  onlyCommands?: string[]
}

const NOT_IMPLEMENTED: CapabilityHandlers = {
  async run(command: string) {
    throw new Error(`not_implemented: ${command}`)
  }
}

export const KNOWN_COMMANDS = new Set([
  'operations.status',
  'capabilities.search',
  'capabilities.discover',
  'capabilities.prepare',
  'capabilities.acquire',
  'skill.read',
  'skill.save',
  'mcp.list',
  'mcp.describe',
  'mcp.call',
  'mcp.app.call',
  'tasks.apply',
  'artifact.attach',
  'artifact.preview',
  'artifact.exportVideo',
  'artifact.exportImage',
  'image.generate',
  'image.local.status',
  'image.local.start',
  'image.local.stop',
  'question.ask',
  'office.read',
  'file.trash',
  'consent.request',
  'danger.confirm',
  'danger.prefs',
  'session.move',
  'knowledge.search',
  'knowledge.read',
  'knowledge.propose',
  'schedule.create',
  'schedule.list',
  'schedule.delete',
  'schedule.pause',
  'subagent.start',
  'subagent.list',
  'subagent.get',
  'subagent.send',
  'subagent.stop',
  'browser.api',
  'browser.run',
  'browser.navigate',
  'browser.open',
  'browser.state',
  'browser.observe',
  'browser.network',
  'browser.wait',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.press',
  'browser.scroll',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.new-tab',
  'browser.switch-tab',
  'browser.close-tab',
  'browser.screenshot',
  'browser.download',
  'browser.request-user-control',
  'browser.connect-chrome',
  'browser.disconnect-chrome',
  'search.query',
  'search.fetch',
  'search.docs',
  'search.doctor'
])

const RETIRED_COMMAND_HINTS: ReadonlyArray<{ prefix: string; message: string }> = [
  {
    prefix: 'hub.',
    message:
      '多 Agent 工作台命令（hub.*）已退役：请改用 `yan subagent start|list|get|stop` 派子代理。'
  }
]

function retiredCommandMessage(command: string): string | null {
  for (const hint of RETIRED_COMMAND_HINTS) {
    if (command.startsWith(hint.prefix)) return hint.message
  }
  return null
}

function shapeOf(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      ...(depth < 1 && value.length ? { first: shapeOf(value[0], depth + 1) } : {})
    }
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (depth >= 1) return { type: 'object', keyCount: entries.length }
    const keys: Record<string, unknown> = {}
    for (const [key, item] of entries.slice(0, 24)) keys[key] = shapeOf(item, depth + 1)
    return { type: 'object', keyCount: entries.length, keys }
  }
  if (typeof value === 'string') return { type: 'string', length: value.length }
  return { type: typeof value }
}

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113,
  115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556,
  563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080
])

function listenOnce(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      const addr = server.address()
      if (!addr || typeof addr === 'string') reject(new Error('能力服务未能取得端口'))
      else resolve(addr.port)
    })
  })
}

async function listenOnFetchablePort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = await listenOnce(server)
    if (!FETCH_BLOCKED_PORTS.has(port)) return port
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  throw new Error('能力服务未能取得可用端口')
}

export class CapabilityServer {
  private server: Server | null = null
  private generation = 0
  private readonly pending = new Set<AbortController>()
  private token = ''
  private port = 0
  private ctx: CapabilityContext | null = null
  private ops: Array<{ id: string; command: string; at: number; ok: boolean; error?: string; resultFile?: string; resultBytes?: number }> = []
  private readonly opsDir: string
  private readonly handlers: CapabilityHandlers
  private readonly allowCommands: Set<string>

  constructor(opts: CapabilityServerOptions) {
    this.opsDir = opts.opsDir
    this.handlers = opts.handlers ?? NOT_IMPLEMENTED
    this.allowCommands = new Set(opts.onlyCommands ?? [...KNOWN_COMMANDS, ...(opts.allowCommands ?? [])])
  }

  get ready(): boolean {
    return this.server !== null
  }

  async start(ctx: CapabilityContext): Promise<{ url: string; token: string }> {
    if (this.server) throw new Error('一个能力服务实例只服务一个会话')

    this.ctx = ctx
    this.token = randomUUID()
    mkdirSync(this.opsDir, { recursive: true })
    this.pruneOps()

    const generation = ++this.generation
    this.server = createServer((req, res) => {
      void this.handle(req, res, generation).catch(() => {
        if (res.writableEnded || res.destroyed) return
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }))
      })
    })

    this.port = await listenOnFetchablePort(this.server)
    return { url: this.url, token: this.token }
  }

  private get url(): string {
    return `http://127.0.0.1:${this.port}/rpc`
  }

  stop(): void {
    this.generation++
    this.server?.close()
    this.server = null
    this.ctx = null
    this.token = ''
    this.ops = []
    const pending = [...this.pending]
    this.pending.clear()
    for (const cancel of pending) cancel.abort()
  }

  private async handle(req: IncomingMessage, res: ServerResponse, generation: number): Promise<void> {
    const cancel = new AbortController()
    this.pending.add(cancel)
    cancel.signal.addEventListener('abort', () => res.destroy(), { once: true })
    req.on('aborted', () => cancel.abort())
    res.on('close', () => {
      if (!res.writableEnded) cancel.abort()
    })
    try {
      if (generation !== this.generation) {
        res.destroy()
        return
      }
      await this.handleRequest(req, res, cancel, generation)
    } finally {
      this.pending.delete(cancel)
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse, cancel: AbortController, generation: number): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text)
      })
      res.end(text)
    }

    if (req.method !== 'POST' || !req.url?.startsWith('/rpc')) {
      reply(404, { ok: false, error: 'not_found' })
      return
    }
    if (!this.checkToken(req.headers.authorization)) {
      reply(401, { ok: false, error: 'unauthorized' })
      return
    }

    const chunks: Buffer[] = []
    let bodyBytes = 0
    try {
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bodyBytes += bytes.length
        if (bodyBytes > 1_000_000) throw new Error('body_too_large')
        chunks.push(bytes)
      }
    } catch {
      reply(413, { ok: false, error: 'body_too_large' })
      return
    }
    const raw = Buffer.concat(chunks, bodyBytes).toString('utf8')

    let body: {
      command?: unknown
      params?: unknown
      sessionId?: unknown
      projectId?: unknown
      apiVersion?: unknown
    }
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      reply(400, { ok: false, error: 'bad_json' })
      return
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      reply(400, { ok: false, error: 'bad_request' })
      return
    }
    if (body.params !== undefined && (!body.params || typeof body.params !== 'object' || Array.isArray(body.params))) {
      reply(400, { ok: false, error: 'bad_params' })
      return
    }
    if (body.apiVersion !== CAPABILITY_API_VERSION) {
      reply(400, { ok: false, error: 'api_version_mismatch' })
      return
    }

    if (cancel.signal.aborted || generation !== this.generation) return
    const bound = this.ctx
    if (!bound) {
      reply(503, { ok: false, error: 'server_not_bound' })
      return
    }
    if (body.sessionId !== bound.sessionId || body.projectId !== bound.projectId) {
      reply(403, {
        ok: false,
        error: 'identity_mismatch',
        detail: '会话或项目身份与本次实例不匹配'
      })
      return
    }

    const command = typeof body.command === 'string' ? body.command : ''
    if (!this.allowCommands.has(command)) {
      const retirement = retiredCommandMessage(command)
      if (retirement && this.allowCommands.has('subagent.start')) {
        reply(400, { ok: false, error: retirement, code: 'retired_command', detail: command })
        return
      }
      const limited = KNOWN_COMMANDS.has(command) || Boolean(retirement)
      reply(400, { ok: false, error: 'unknown_command', detail: command, ...(limited ? { hint: `这个会话只开放：${[...this.allowCommands].join(', ')}` } : {}) })
      return
    }

    const params =
      body.params && typeof body.params === 'object'
        ? (body.params as Record<string, unknown>)
        : {}

    const opId = randomUUID()
    try {
      const out =
        command === 'operations.status'
          ? this.describeOps(params)
          : await this.handlers.run(command, params, bound, cancel.signal)
      if (cancel.signal.aborted || generation !== this.generation) return
      const file = this.writeResult(opId, out)
      this.remember({ id: opId, command, at: Date.now(), ok: true, ...(file ? { resultFile: file.path, resultBytes: file.bytes } : {}) })
      reply(200, {
        ok: true,
        operationId: opId,
        summary: out.summary,
        resultFile: file?.path,
        resultBytes: file?.bytes
      })
    } catch (err) {
      if (cancel.signal.aborted || generation !== this.generation) return
      const message = err instanceof Error ? err.message : String(err)
      const code = err instanceof CapabilityCommandError ? err.code : undefined
      const data = err instanceof CapabilityCommandError ? err.data : undefined
      const file = data === undefined ? null : this.writeResult(opId, { data })
      this.remember({ id: opId, command, at: Date.now(), ok: false, error: message, ...(file ? { resultFile: file.path, resultBytes: file.bytes } : {}) })
      reply(200, {
        ok: false,
        operationId: opId,
        error: message,
        ...(code ? { code } : {}),
        ...(file ? { resultFile: file.path, resultBytes: file.bytes } : {})
      })
    }
  }

  private pruneOps(): void {
    const cutoff = Date.now() - CAPABILITY_OPS_MAX_AGE_MS
    let kept = 0
    const files: Array<{ path: string; at: number }> = []
    try {
      for (const name of readdirSync(this.opsDir)) {
        if (!/\.(?:json|txt)$/.test(name)) continue
        const path = join(this.opsDir, name)
        try {
          const info = statSync(path)
          if (!info.isFile()) continue
          files.push({ path, at: info.mtimeMs })
        } catch {
        }
      }
    } catch {
      return
    }
    files.sort((a, b) => b.at - a.at)
    for (const file of files) {
      if (file.at < cutoff || kept >= CAPABILITY_OPS_MAX_FILES) {
        try {
          unlinkSync(file.path)
        } catch {
        }
        continue
      }
      kept++
    }
  }

  private checkToken(header: string | undefined): boolean {
    const prefix = 'Bearer '
    if (!this.token || !header?.startsWith(prefix)) return false
    const got = Buffer.from(header.slice(prefix.length))
    const want = Buffer.from(this.token)
    if (got.length !== want.length) return false
    return timingSafeEqual(got, want)
  }

  private writeResult(opId: string, out: Pick<CapabilityCommandResult, 'data'>): { path: string; bytes: number } | null {
    if (out.data === undefined) return null
    let text: string
    try {
      text = JSON.stringify(out.data, null, 2)
    } catch {
      text = JSON.stringify({ error: 'result_not_serializable' })
    }
    if (Buffer.byteLength(text) > CAPABILITY_RESULT_MAX_BYTES) {
      const bytes = Buffer.byteLength(text)
      text = JSON.stringify({ truncated: true, bytes, shape: shapeOf(out.data), head: text.slice(0, 2000) })
    }
    const path = join(this.opsDir, `${opId}.json`)
    try {
      writeFileSync(path, text, 'utf8')
    } catch {
      return null
    }
    return { path, bytes: Buffer.byteLength(text) }
  }

  private remember(op: { id: string; command: string; at: number; ok: boolean; error?: string }): void {
    this.ops.push(op)
    if (this.ops.length > 50) this.ops.splice(0, this.ops.length - 50)
  }

  recentOps(limit: number): Array<{ id: string; command: string; at: number; ok: boolean; error?: string; resultFile?: string; resultBytes?: number }> {
    return this.ops.slice(-Math.max(1, Math.min(limit, 50)))
  }

  private describeOps(params: Record<string, unknown>): {
    data: unknown
    summary: Record<string, unknown>
  } {
    const id = typeof params.id === 'string' ? params.id.trim() : ''
    if (id) {
      const op = this.ops.find((o) => o.id === id)
      if (!op) {
        throw new CapabilityCommandError('operation_not_found', `找不到这次操作：${id}（本机最近 50 次操作内才能查到）`)
      }
      return {
        data: { op },
        summary: { kind: 'operations', id: op.id, command: op.command, ok: op.ok }
      }
    }
    const raw = Number(params.limit)
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50) : 10
    const ops = this.recentOps(limit)
    return {
      data: { ops },
      summary: {
        kind: 'operations',
        count: ops.length,
        failed: ops.filter((o) => !o.ok).length
      }
    }
  }
}
