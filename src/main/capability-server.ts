/**
 * 砚「宿主能力服务」：给随包 CLI（`yan`）用的本机端点。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════
 * 架构修订（docs/archive/2026-09-18-架构修订-默认pi与砚原生能力层.md）定下的路线是：
 * 模型只看到 pi 的基础工具（read / bash / …），砚的能力通过**随包 CLI** 触达。
 * CLI 是**进程外**的东西，它必须先证明自己属于哪个会话，宿主才给它数据 ——
 * 否则模型（或本机任何进程）都能伪造一个 projectId 去读别的项目的内容。
 *
 * 所以这一个文件负责的是**身份与结果管道**，不是具体能力：
 *   · 只监听 127.0.0.1，端口随机；
 *   · 每个实例一份**一次性 token**，只经 pi 子进程的环境变量传递（不落盘、不进日志）；
 *   · token 与 (sessionId, projectId) **绑定** —— CLI 传来的身份对不上直接 403；
 *   · 大结果**落文件**，响应里只回受限摘要（类型 / 路径 / 大小 / 条数 / 错误 / 操作 ID）。
 *
 * ── 与 pi 扩展的分工（见 docs/plan/实施-01-默认pi架构迁移.md §1）──
 *   这里**不注册模型工具、不注册 pi 命令、不 import pi 内部模块**。
 *   模型看到的是提示里的一小段「yan 用法」，不是一大组工具 schema。
 *
 * ── 为什么不用「CLI 直接读文件」──
 *   直接读文件没有身份概念：模型只要知道路径就能读任意项目。
 *   走端点才能把「你是谁、你能看什么」钉在宿主侧。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 协议版本：CLI 与宿主必须一致，避免旧 CLI 打到新宿主上做错事。 */
export const CAPABILITY_API_VERSION = 1

/**
 * 单个结果文件的落盘上限。
 *
 * JSON 结果沿用历史行为：超过上限时截断并在摘要路径里保留结果文件；
 * 原始文本结果（例如 context recall）则必须完整可读，超过上限一律拒绝，
 * 不能把半份历史伪装成一次成功的召回。
 */
export const CAPABILITY_RESULT_MAX_BYTES = 4 * 1024 * 1024

/**
 * 注入给 pi 子进程的 CLI 环境（配合 [YanCliEnv] 使用）。
 *
 * 这几个值只会出现在 pi 子进程的环境里，**不落盘、不进日志、不进渲染端**。
 */
export interface YanCliEnv {
  url: string
  token: string
  sessionId: string
  projectId: string
  /** 启动器目录，会被前置到 pi 子进程的 PATH。 */
  binDir: string
}

export interface CapabilityContext {
  /** 当前会话的稳定 id（宿主生成，不由模型自报）。 */
  sessionId: string
  /** 当前项目的稳定 id。 */
  projectId: string
}

/**
 * 一条宿主能力命令的受管结果。
 *
 * `data` 是普通结构化 JSON；`resultText` 是必须逐字保留的受管文本文件。
 * 两者互斥：前者可在大小上限内按既有策略截断，后者用于会被下游协议识别
 * 的文本（例如 `[Recalled context]`），不能 JSON 转义、更不能截半。
 */
export interface CapabilityCommandResult {
  data?: unknown
  resultText?: string
  summary: Record<string, unknown>
}

export interface CapabilityHandlers {
  /**
   * 执行一条命令。返回 `data` 会被写进结果文件，`summary` 回给 stdout。
   *
   * 抛出的错误会被转成 `{ok:false, error}`，**不**把堆栈回给模型。
   *
   * ── 业务失败怎么表达（S3 补）──
   * 有些失败不是「端点坏了」而是「这次操作不合法」（`index` 越界、超上限、
   * 落盘失败……）。它必须让模型**既能读到可读原因，又能按错误码分支**，
   * 所以抛出 `CapabilityCommandError`：`code` 进响应，`data` 落结果文件
   * （例如「当前清单长什么样」——模型据此自己改正重试）。
   */
  run(
    command: string,
    params: Record<string, unknown>,
    ctx: CapabilityContext
  ): Promise<CapabilityCommandResult>
}

/**
 * 业务失败（不是协议/鉴权错误）。
 *
 * 为什么要单独一个类：`unknown_command` / `identity_mismatch` 是端点级错误，
 * 而「任务 `index` 越界」是命令级错误 —— 前者是接线问题，后者是模型自己要改参数。
 * 用同一个 `error` 字符串把两者混在一起，模型只能读中文去猜。
 */
export class CapabilityCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** 可选的结构化结果（如当前清单 / 候选项），会被落进结果文件。 */
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'CapabilityCommandError'
  }
}

export interface CapabilityServerOptions {
  /**
   * 命令实现。省略时除 `operations.status` 外全部回 `not_implemented` ——
   * S2 阶段只要求「管道通」，后续补实现时不用改协议层。
   */
  handlers?: CapabilityHandlers
  /** 结果文件目录（`YAN_DIR` 下），默认由调用方给出绝对路径。 */
  opsDir: string
  /** 额外允许的 command 前缀（默认只允许已登记的动词）。 */
  allowCommands?: string[]
}

/** 骨架默认实现：明确告知「命令已接通，但还没实现」，而不是静默成功。 */
const NOT_IMPLEMENTED: CapabilityHandlers = {
  async run(command: string) {
    throw new Error(`not_implemented: ${command}`)
  }
}

/**
 * 已登记命令。
 *
 * S2 阶段只要求「管道通」：`operations.status` 是真实实现，
 * 其余返回 `not_implemented` —— 但**身份校验、结果落盘、摘要返回**全部照走，
 * 这样后续补实现时不用再动协议层。
 *
 * `browser.*`（01-S4b）：内置浏览器不再注册成模型工具，模型的浏览器能力
 * 全部走这一族命令（实现在 agent.ts 的 runBrowserCommand，直接调
 * src/main/browser.ts 的服务方法，不再绕 HTTP bridge）。
 * 这里必须与 agent.ts 的实现、yan.mjs 的用法表**成对登记**：漏一处就是
 * 「命令已接通但会报 unknown_command」。
 */
const KNOWN_COMMANDS = new Set([
  'operations.status',
  'capabilities.search',
  'capabilities.discover',
  'capabilities.prepare',
  'capabilities.acquire',
  'skill.read',
  'mcp.describe',
  'mcp.call',
  'tasks.apply',
  'artifact.attach',
  'image.generate',
  'question.ask',
  'context.recall',
  /* 目标状态（实施-05 S3）：澄清档就绪转移与自主档推进报告。 */
  'goal.ready',
  'goal.report',
  'goal.status',
  'knowledge.search',
  'knowledge.read',
  'knowledge.propose',
  'subagent.start',
  'subagent.list',
  'subagent.get',
  'subagent.stop',
  'browser.navigate',
  'browser.open',
  'browser.state',
  'browser.observe',
  'browser.click',
  'browser.type',
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
  'browser.disconnect-chrome'
])

export class CapabilityServer {
  private server: Server | null = null
  private token = ''
  private port = 0
  private ctx: CapabilityContext | null = null
  /** 最近若干次调用，供 `operations.status` 回读（内存态，不持久化）。 */
  private ops: Array<{ id: string; command: string; at: number; ok: boolean; error?: string }> = []
  private readonly opsDir: string
  private readonly handlers: CapabilityHandlers
  private readonly allowCommands: Set<string>

  constructor(opts: CapabilityServerOptions) {
    this.opsDir = opts.opsDir
    this.handlers = opts.handlers ?? NOT_IMPLEMENTED
    this.allowCommands = new Set([...KNOWN_COMMANDS, ...(opts.allowCommands ?? [])])
  }

  /** 端点是否可用（CLI 侧据此决定要不要报「宿主不可用」而不是「命令不存在」）。 */
  get ready(): boolean {
    return this.server !== null
  }

  /**
   * 启动并绑定身份。
   *
   * `ctx` 一旦绑定就不再改变：**同一实例只服务一个会话**。
   * 会话切换时上层会重建 agent 实例，端点随之重建 —— 这比让端点动态换身份安全得多。
   */
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
      // 只绑回环地址：不要让它出现在局域网里。
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
    // token 作废：即使有人从旧进程环境里捡到它也用不了了。
    this.token = ''
    this.ops = []
  }

  /* ------------------------------------------------------------ 请求处理 */

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
    /*
     * 认证先于一切解析：拿不到正确 token 的请求连 body 都不读，
     * 免得畸形 body 在鉴权前就触发解析路径。
     */
    if (!this.checkToken(req.headers.authorization)) {
      reply(401, { ok: false, error: 'unauthorized' })
      return
    }

    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 1_000_000) throw new Error('body_too_large')
      }
    } catch {
      reply(413, { ok: false, error: 'body_too_large' })
      return
    }

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

    /*
     * 身份校验：**不信 CLI 自报的身份**，要和绑定值逐一比对。
     * 这是 S2 出口里「伪造 projectId 被拒」那条的实现点。
     */
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
      reply(400, { ok: false, error: 'unknown_command', detail: command })
      return
    }

    const params =
      body.params && typeof body.params === 'object'
        ? (body.params as Record<string, unknown>)
        : {}

    const opId = randomUUID()
    try {
      /*
       * `operations.status` 由服务自己答：它只知道自己的 ops 表，
       * 交给外部 handlers 会形成环（handlers 要回头问 server）。
       */
      const out =
        command === 'operations.status'
          ? this.describeOps(params)
          : await this.handlers.run(command, params, bound)
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
      /*
       * 业务失败：把错误码与（可选的）结构化数据一并带回去。
       * 结果仍落文件 —— 模型要能拿到「当前清单」这类上下文才能自我纠正，
       * 而不是只看到一个中文句子。
       */
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
    // 长度不同时 timingSafeEqual 会抛异常，先挡掉。
    if (got.length !== want.length) return false
    return timingSafeEqual(got, want)
  }

  /**
   * 大结果落文件，stdout 只回摘要。
   *
   * 为什么必须落文件：CLI 的 stdout 会**原样进入模型上下文**。
   * 让模型读一个文件、只挑需要的片段，比把几 MB JSON 直接喷进上下文便宜得多。
   */
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
    const truncated = Buffer.byteLength(text) > CAPABILITY_RESULT_MAX_BYTES
    if (truncated) text = text.slice(0, CAPABILITY_RESULT_MAX_BYTES)
    const path = join(this.opsDir, `${opId}.json`)
    try {
      writeFileSync(path, text, 'utf8')
    } catch {
      return null
    }
    return { path, bytes: Buffer.byteLength(text) }
  }

  /**
   * 写一份必须逐字保留的文本结果。
   *
   * 不能复用 JSON 结果的“超限截断”路径：调用方把这个文本交给 native `read`
   * 后，扩展还会按固定前缀识别它的生命周期。截断既会误导模型，也可能绕过
   * TTL 清理，所以大小和写盘错误都 fail closed。
   */
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

  /** 供 `operations.status` 使用。 */
  recentOps(limit: number): Array<{ id: string; command: string; at: number; ok: boolean; error?: string }> {
    return this.ops.slice(-Math.max(1, Math.min(limit, 50)))
  }

  /** `operations.status` 的实现：回读本实例最近的操作。 */
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
