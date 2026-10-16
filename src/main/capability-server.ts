import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CAPABILITY_API_VERSION = 1

export const CAPABILITY_RESULT_MAX_BYTES = 4 * 1024 * 1024

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
  resultText?: string
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

const KNOWN_COMMANDS = new Set([
  'operations.status',
  'capabilities.search',
  'capabilities.discover',
  'capabilities.prepare',
  'capabilities.acquire',
  'skill.read',
  'skill.save',
  'mcp.describe',
  'mcp.call',
  'mcp.app.call',
  'tasks.apply',
  'artifact.attach',
  'image.generate',
  'image.local.status',
  'image.local.start',
  'image.local.stop',
  'question.ask',
  'context.recall',
  'context.find',
  'context.inspect',
  'office.read',
  'file.trash',
  'consent.request',
  'danger.confirm',
  'session.move',
  'context.budget.status',
  'context.budget.adjust',
  'goal.ready',
  'goal.report',
  'goal.status',
  'research.read',
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
  'subagent.stop',
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
  'search.doctor'
])

const RETIRED_COMMAND_HINTS: ReadonlyArray<{ prefix: string; message: string }> = [
  {
    prefix: 'hub.',
    message:
      '多 Agent 工作台命令（hub.*）已退役，不再从普通会话提供：请改用 `yan subagent start|list|get|stop` 派子代理；历史 Hub 记录仍可在界面查看。'
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

export class CapabilityServer {
  private server: Server | null = null
  private token = ''
  private port = 0
  private ctx: CapabilityContext | null = null
  private ops: Array<{ id: string; command: string; at: number; ok: boolean; error?: string }> = []
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
    if (this.server) return { url: this.url, token: this.token }

    this.ctx = ctx
    this.token = randomUUID()
    mkdirSync(this.opsDir, { recursive: true })

    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => resolve())
    })

    const addr = this.server.address()
    if (!addr || typeof addr === 'string') throw new Error('能力服务未能取得端口')
    this.port = addr.port
    return { url: this.url, token: this.token }
  }

  private get url(): string {
    return `http://127.0.0.1:${this.port}/rpc`
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.ctx = null
    this.token = ''
    this.ops = []
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    const cancel = new AbortController()
    req.on('aborted', () => cancel.abort())
    res.on('close', () => {
      if (!res.writableEnded) cancel.abort()
    })

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

    if (body.apiVersion !== CAPABILITY_API_VERSION) {
      reply(400, { ok: false, error: 'api_version_mismatch' })
      return
    }

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
      if (retirement) {
        reply(400, { ok: false, error: retirement, code: 'retired_command', detail: command })
        return
      }
      reply(400, { ok: false, error: 'unknown_command', detail: command })
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
      const file = this.writeResult(opId, out)
      this.remember({ id: opId, command, at: Date.now(), ok: true })
      reply(200, {
        ok: true,
        operationId: opId,
        summary: out.summary,
        resultFile: file?.path,
        resultBytes: file?.bytes
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = err instanceof CapabilityCommandError ? err.code : undefined
      const data = err instanceof CapabilityCommandError ? err.data : undefined
      const file = data === undefined ? null : this.writeResult(opId, { data })
      this.remember({ id: opId, command, at: Date.now(), ok: false, error: message })
      reply(200, {
        ok: false,
        operationId: opId,
        error: message,
        ...(code ? { code } : {}),
        ...(file ? { resultFile: file.path, resultBytes: file.bytes } : {})
      })
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

  private writeResult(opId: string, out: Pick<CapabilityCommandResult, 'data' | 'resultText'>): { path: string; bytes: number } | null {
    if (out.data !== undefined && out.resultText !== undefined) {
      throw new CapabilityCommandError('result_shape_invalid', '宿主命令不能同时返回 JSON 数据与原始文本结果')
    }
    if (out.resultText !== undefined) return this.writeRawTextResult(opId, out.resultText)
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

  private writeRawTextResult(opId: string, text: string): { path: string; bytes: number } {
    const bytes = Buffer.byteLength(text)
    if (bytes > CAPABILITY_RESULT_MAX_BYTES) {
      throw new CapabilityCommandError(
        'result_too_large',
        `原始文本结果 ${bytes} 字节超过受管上限 ${CAPABILITY_RESULT_MAX_BYTES}，未写出半份结果`
      )
    }
    const path = join(this.opsDir, `${opId}.txt`)
    try {
      writeFileSync(path, text, 'utf8')
    } catch {
      throw new CapabilityCommandError('result_write_failed', '无法写出受管文本结果；内容没有返回给模型')
    }
    return { path, bytes }
  }

  private remember(op: { id: string; command: string; at: number; ok: boolean; error?: string }): void {
    this.ops.push(op)
    if (this.ops.length > 50) this.ops.splice(0, this.ops.length - 50)
  }

  recentOps(limit: number): Array<{ id: string; command: string; at: number; ok: boolean; error?: string }> {
    return this.ops.slice(-Math.max(1, Math.min(limit, 50)))
  }

  private describeOps(params: Record<string, unknown>): {
    data: unknown
    summary: Record<string, unknown>
  } {
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
