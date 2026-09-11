/**
 * AgentController —— 一回话一个 pi 子进程，外加**协议 → UI 的归一化**。
 *
 * 这是整个应用唯一认识 pi 协议的地方（HANDOFF §9 原则 2）。
 * 它对外只吐 MainPush（已在 src/shared/ipc.ts 定义），
 * 渲染端完全不认识 `assistantMessageEvent` 之类的东西。
 *
 * 为什么要维护一份消息副本：
 *   message_update 是**增量**（delta），没有累积快照；
 *   tool_execution_* 用 toolCallId 关联，但UI 上要挂到"哪条助手消息"下面。
 *   所以要在这里组装出完整的 UIMessage[]，再以补丁形式推给渲染端。
 */
import { EventEmitter } from 'node:events'
import { PiRpc } from './protocol'
import { SESSIONS_DIR, SESSIONS_DIR_IS_OVERRIDE } from './sessions'
import { generateTitle } from './title'
import type {
  BashRun,
  ForkPoint,
  MainPush,
  ModelInfo,
  QueueState,
  SessionState,
  SessionStats,
  SessionTodo,
  CustomEntry,
  SlashCommand,
  UIMessage,
  UIToolCall,
  Usage
} from '../shared/ipc'

/** 流式文本的推送节流：60 帧够了，再多是给 IPC 白干活 */
const FLUSH_MS = 16

type Push = (msg: MainPush) => void

/* ==================================================================
   pi 的原始类型（只在这里出现）
   ================================================================== */

interface PiContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
  /** 图片块（ImageContent） */
  data?: string
  mimeType?: string
}

interface PiMessage {
  role: string
  content?: string | PiContentBlock[]
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    totalTokens?: number
    cost?: { total?: number }
  }
  model?: string
  stopReason?: string
  timestamp?: number
  toolCallId?: string
  toolName?: string
  isError?: boolean
  command?: string
  exitCode?: number | null
  cancelled?: boolean
}

function toUsage(u: PiMessage['usage']): Usage | undefined {
  if (!u) return undefined
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens:
      u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
    cost: u.cost?.total ?? 0
  }
}

/** 把 pi 的 AgentMessage 归一化成 UIMessage（历史回放用） */
export function normalizeMessage(m: PiMessage, idx: number): UIMessage | null {
  const id = `m${idx}`

  if (m.role === 'user') {
    let text = ''
    const images: { mimeType: string; data: string }[] = []

    if (typeof m.content === 'string') {
      text = m.content
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text') text += c.text ?? ''
        else if (c.type === 'image' && c.data) {
          images.push({ mimeType: c.mimeType ?? 'image/png', data: c.data })
        }
      }
    }

    // 去掉客户端塞进去的 XML 包裹
    text = text.replace(/^<[^>]{1,40}>/, '').replace(/<\/[^>]{1,40}>$/, '')
    return {
      id,
      role: 'user',
      text,
      images: images.length ? images : undefined,
      timestamp: m.timestamp
    }
  }

  if (m.role === 'assistant') {
    const blocks = Array.isArray(m.content) ? m.content : []
    const text = blocks
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    const thinking = blocks
      .filter((c) => c.type === 'thinking')
      .map((c) => c.thinking ?? '')
      .join('')

    const toolCalls: UIToolCall[] = blocks
      .filter((c) => c.type === 'toolCall' && c.id)
      .map((c) => ({
        id: c.id!,
        name: c.name ?? 'unknown',
        args: c.arguments,
        // 历史里的工具调用已经没有结果了（结果在单独的 toolResult 消息里），
        // 后面用 toolResult 回填
        status: 'ok' as const
      }))

    return {
      id,
      role: 'assistant',
      text,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: toUsage(m.usage),
      model: m.model,
      timestamp: m.timestamp,
      error: m.stopReason === 'error' ? '模型返回错误' : undefined
    }
  }

  if (m.role === 'toolResult') {
    // 归一化成一条工具结果（挂不上就独立显示）
    return {
      id,
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          id: m.toolCallId ?? id,
          name: m.toolName ?? 'tool',
          args: undefined,
          status: m.isError ? 'error' : 'ok',
          output: Array.isArray(m.content)
            ? m.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text ?? '')
                .join('')
            : typeof m.content === 'string'
              ? m.content
              : ''
        }
      ],
      timestamp: m.timestamp
    }
  }

  if (m.role === 'bashExecution') {
    return {
      id,
      role: 'bash',
      text: m.command ?? '',
      bash: {
        command: m.command ?? '',
        exitCode: m.exitCode ?? null,
        cancelled: !!m.cancelled
      },
      toolCalls: [
        {
          id,
          name: 'bash',
          args: { command: m.command },
          status: m.exitCode === 0 ? 'ok' : 'error',
          output: m.content as string | undefined
        }
      ],
      timestamp: m.timestamp
    }
  }

  return null
}

/** 历史回放：把 toolResult 的结果回填到对应的 toolCall 上 */
export function normalizeHistory(raw: unknown[]): UIMessage[] {
  const out: UIMessage[] = []
  const callIndex = new Map<string, { msg: UIMessage; call: UIToolCall }>()

  raw.forEach((r, i) => {
    const m = r as PiMessage
    const norm = normalizeMessage(m, i)
    if (!norm) return

    if (m.role === 'toolResult') {
      const hit = norm.toolCalls?.[0] ? callIndex.get(norm.toolCalls[0].id) : undefined
      if (hit) {
        // 挂到原有调用上，不新增消息
        hit.call.status = norm.toolCalls![0].status
        hit.call.output = norm.toolCalls![0].output
        return
      }
    }

    for (const c of norm.toolCalls ?? []) {
      callIndex.set(c.id, { msg: norm, call: c })
    }
    out.push(norm)
  })

  return out
}

/* ------------------------------------------------------------ 任务清单 */

/**
 * 从会话的 custom entries 里抽任务清单。
 *
 * 用户的 `left-info-panel.ts` 用 `pi.appendEntry('left-panel-tasks', {todos})` 写，
 * 数据形状是 `{ todos: {text, done}[] }`。
 * 这里做宽松解析：认不出就不显示，不让整个面板崩。
 */
function todosFromEntries(entries: Record<string, unknown>[]): SessionTodo[] {
  let latest: SessionTodo[] = []

  for (const e of entries) {
    if (e.type !== 'custom') continue
    const ct = String(e.customType ?? '')
    // 具体名字认不出来就跳过 —— 不能把所有 custom entry 都当任务
    if (!/task|todo/i.test(ct)) continue

    const data = e.data as { todos?: unknown } | undefined
    if (!Array.isArray(data?.todos)) continue

    latest = data.todos
      .filter((t): t is { text?: unknown; done?: unknown } => !!t && typeof t === 'object')
      .map((t) => ({ text: String(t.text ?? ''), done: Boolean(t.done) }))
      .filter((t) => t.text.length > 0)
  }

  return latest
}

/* ==================================================================
   AgentController
   ================================================================== */

export class AgentController extends EventEmitter {
  private rpc: PiRpc | null = null
  private push: Push
  private memoryPath: string
  private extensionPath: string
  private cwd: string
  private piBin?: string

  /** 权威消息列表 */
  private messages: UIMessage[] = []
  /** 正在流式的那条助手消息 */
  private streaming: {
    id: string
    text: string
    thinking: string
    thinkingMs?: number
    thinkingStartedAt?: number
    tools: UIToolCall[]
    /** 本轮助手消息开始生成的时间 */
    startedAt?: number
    /** 首个 token 到达的时间（用于更准的速率：排除排队/首包延迟） */
    firstTokenAt?: number
    /** 累积 usage（message_update 里带的就是累积值） */
    usage?: Usage
  } | null = null
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private state: SessionState | null = null
  private uiSeen = new Set<string>()

  /** 当前直执行的 bash（RPC bash 命令，不走 LLM）。流式输出靠它累积。 */
  private bash: {
    reqId: string
    msgId: string
    command: string
    output: string
  } | null = null

  constructor(opts: {
    push: Push
    cwd: string
    extensionPath: string
    memoryPath: string
    piBin?: string
  }) {
    super()
    this.push = opts.push
    this.cwd = opts.cwd
    this.extensionPath = opts.extensionPath
    this.memoryPath = opts.memoryPath
    this.piBin = opts.piBin
  }

  get running(): boolean {
    return this.rpc?.running ?? false
  }

  /**
   * 连接状态。
   *
   * ⚠️ 这里要**缓存**，不能只靠 push。
   * 主进程启动 pi 只需几秒，而 dev 模式下渲染进程从 vite dev server
   * 逐个模块加载更慢 —— `proc: ready` 发出时渲染端可能还没订阅，
   * 这个事件就**永久丢失**了（界面永远停在「正在启动 pi」，但功能其实是好的）。
   * 所以渲染端 bootstrap 时会来拉一次（getConn），主进程必须答得上。
   */
  private conn: 'starting' | 'ready' | 'exited' | 'error' = 'starting'
  private connDetail = ''

  /**
   * 标题生成中/已尝试的标记。
   *
   * 只在「没有名字 + 有第一条用户消息」时尝试一次 ——
   * 每轮 agent_settled 都触发的话会反复请求模型，白花钱。
   */
  private titleTried = new Set<string>()

  /** 供渲染端拉取（补上可能错过的 push） */
  getConn(): { state: 'starting' | 'ready' | 'exited' | 'error'; detail: string } {
    return { state: this.conn, detail: this.connDetail }
  }

  /** 统一的连接状态出口：缓存 + 推送 */
  private setConn(state: 'starting' | 'ready' | 'exited' | 'error', detail = ''): void {
    this.conn = state
    this.connDetail = detail
    this.push({ ch: 'proc', payload: { state, detail } })
  }

  /* ---------------------------------------------------------------- 启动 */

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.rpc?.running) return { ok: true }

    this.setConn('starting')

    const rpc = new PiRpc({
      cwd: this.cwd,
      piBin: this.piBin,
      args: [
        // 显式加载砚的记忆扩展：不碰用户的 ~/.pi/agent/extensions/
        '--extension',
        this.extensionPath,
        // 只在测试隔离时接管会话目录。
        // 平时不传 —— 传了 pi 就不再按 cwd 建项目子目录，
        // 会把新会话平铺到根目录，与用户已有会话分居两处。
        ...(SESSIONS_DIR_IS_OVERRIDE ? ['--session-dir', SESSIONS_DIR] : [])
        // 注意：**不传 --name**。
        // 曾经传 `--name 砚` 希望“好辨认”，结果每个新会话标题都是「砚」，
        // 在左栏里长得一模一样，等于没标题。
        // 让 pi 用首条用户消息当标题，才真正可辨认。
      ]
    })
    this.rpc = rpc

    rpc.on('stderr', (line) => {
      this.push({ ch: 'proc', payload: { state: 'stderr', detail: line } })
    })

    rpc.on('exit', (code) => {
      this.streaming = null
      this.setConn('exited', `pi 已退出（code=${code ?? 'null'}）`)
    })

    rpc.on('ui', (req) => this.handleUi(req))
    rpc.on('event', (evt) => this.handleEvent(evt))

    rpc.spawn()

    // 等 pi 起来（它要先加载扩展，可能几百 ms）
    const ok = await this.waitReady(20_000)
    if (!ok) {
      const msg = 'pi 启动超时（20s）。点「详情」看 stderr，或跑 npm run probe-pi。'
      this.setConn('error', msg)
      return { ok: false, error: msg }
    }

    this.setConn('ready')

    await this.hydrate()
    return { ok: true }
  }

  /** 等第一次 get_state 成功 */
  private async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await this.rpc!.command('get_state')
        if (res.success) return true
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  /** 拉一次全量：消息 + 状态 + 统计 + 任务 */
  private async hydrate(): Promise<void> {
    const [msgs, state, stats] = await Promise.all([
      this.rpc!.command('get_messages').catch(() => null),
      this.rpc!.command('get_state').catch(() => null),
      this.rpc!.command('get_session_stats').catch(() => null)
    ])

    const raw = (msgs?.data as { messages?: unknown[] } | undefined)?.messages
    this.messages = Array.isArray(raw) ? normalizeHistory(raw) : []
    this.push({ ch: 'sync', payload: this.messages })

    if (state?.success) this.setStateFrom(state.data as Record<string, unknown>)
    if (stats?.success) this.push({ ch: 'stats', payload: stats.data as SessionStats })

    // 任务清单（扩展写的 custom entry）
    void this.refreshTodos()
  }

  /* ------------------------------------------------------------ 任务清单 */

  async getCustomEntries(): Promise<CustomEntry[]> {
    try {
      const res = await this.rpc?.command<{ entries?: Record<string, unknown>[] }>('get_entries')
      if (!res?.success) return []
      return (res.data?.entries ?? [])
        .filter((e) => e.type === 'custom')
        .map((e) => ({
          id: String(e.id ?? ''),
          customType: String(e.customType ?? ''),
          data: e.data
        }))
    } catch {
      return []
    }
  }

  /**
   * 重读任务清单并推给渲染端。
   *
   * 触发时机：hydrate、切会话、agent_settled 兑底，
   * 以及**监听到 `panel_todos` 工具执行完**（与 remember 处理同一套路）。
   */
  async refreshTodos(): Promise<SessionTodo[]> {
    try {
      const res = await this.rpc?.command<{ entries?: Record<string, unknown>[] }>('get_entries')
      if (!res?.success) return []
      const todos = todosFromEntries(res.data?.entries ?? [])
      this.push({ ch: 'todos', payload: todos })
      return todos
    } catch {
      return []
    }
  }

  private setStateFrom(data: Record<string, unknown>): void {
    const model = data.model as ModelInfo | null | undefined
    this.state = {
      sessionId: String(data.sessionId ?? ''),
      sessionFile: data.sessionFile ? String(data.sessionFile) : undefined,
      sessionName: data.sessionName ? String(data.sessionName) : undefined,
      model: model ?? undefined,
      thinkingLevel: String(data.thinkingLevel ?? 'off'),
      availableThinkingLevels: this.state?.availableThinkingLevels ?? [],
      isStreaming: !!data.isStreaming,
      isCompacting: !!data.isCompacting,
      messageCount: Number(data.messageCount ?? 0),
      pendingMessageCount: Number(data.pendingMessageCount ?? 0),
      cwd: this.cwd,
      autoCompactionEnabled:
        data.autoCompactionEnabled === undefined ? undefined : !!data.autoCompactionEnabled
    }
    this.push({ ch: 'state', payload: this.state })
  }

  /* ---------------------------------------------------------------- 事件 */

  private handleEvent(evt: Record<string, unknown>): void {
    const type = String(evt.type ?? '')

    switch (type) {
      /* ---- 助手消息：开始 ---- */
      case 'message_start': {
        const m = evt.message as PiMessage | undefined
        if (m?.role === 'user') {
          const norm = normalizeMessage(m, this.messages.length)
          if (norm) {
            this.messages.push(norm)
            this.push({ ch: 'msg-add', payload: norm })
          }
        } else if (m?.role === 'assistant') {
          const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
          this.streaming = { id, text: '', thinking: '', tools: [], startedAt: Date.now() }
          this.push({
            ch: 'msg-add',
            payload: { id, role: 'assistant', text: '', timestamp: Date.now() }
          })
          this.markStreaming(true)
        }
        break
      }

      /* ---- 助手消息：流式增量 ---- */
      case 'message_update': {
        const ev = evt.assistantMessageEvent as Record<string, unknown> | undefined
        if (!ev || !this.streaming) break
        const kind = String(ev.type ?? '')

        // 顶层的 usage 是**累积值**（有的 provider 流式期间不报，保持 0）
        const u = toUsage(evt.usage as PiMessage['usage'])
        if (u) this.streaming.usage = u

        // 首个内容 delta 到达 → 记下首包时间（算速率时排除排队与首包延迟）
        if (
          !this.streaming.firstTokenAt &&
          (kind === 'text_delta' || kind === 'thinking_delta' || kind === 'toolcall_start')
        ) {
          this.streaming.firstTokenAt = Date.now()
        }

        if (kind === 'thinking_start') {
          this.streaming.thinkingStartedAt = Date.now()
        } else if (kind === 'thinking_delta') {
          this.streaming.thinking += String(ev.delta ?? '')
          this.markDirty()
        } else if (kind === 'thinking_end') {
          const started = this.streaming.thinkingStartedAt
          if (started) this.streaming.thinkingMs = Date.now() - started
          this.markDirty()
        } else if (kind === 'text_delta') {
          this.streaming.text += String(ev.delta ?? '')
          this.markDirty()
        } else if (kind === 'toolcall_start') {
          const call: UIToolCall = {
            id: String(ev.id ?? `call-${this.streaming.tools.length}`),
            name: String(ev.toolName ?? 'tool'),
            args: undefined,
            argsRaw: '',
            status: 'running',
            startedAt: Date.now()
          }
          this.streaming.tools.push(call)
          this.flushNow()
          this.pushTool(call)
        } else if (kind === 'toolcall_delta') {
          const last = this.streaming.tools[this.streaming.tools.length - 1]
          if (last) {
            last.argsRaw = (last.argsRaw ?? '') + String(ev.delta ?? '')
            // 参数流完之前就顺手解析一下，让卡片早点显示命令
            try {
              last.args = JSON.parse(last.argsRaw)
            } catch {
              /* 还没流完，正常 */
            }
          }
        } else if (kind === 'toolcall_end') {
          const tc = ev.toolCall as PiContentBlock | undefined
          const last = this.streaming.tools[this.streaming.tools.length - 1]
          if (last && tc) {
            if (tc.id) last.id = tc.id
            if (tc.name) last.name = tc.name
            if (tc.arguments !== undefined) last.args = tc.arguments
          }
          this.flushNow()
          if (last) this.pushTool(last)
        }
        break
      }

      /* ---- 助手消息：结束（权威快照） ---- */
      case 'message_end': {
        const m = evt.message as PiMessage | undefined
        if (m?.role !== 'assistant' || !this.streaming) break

        const s = this.streaming
        const id = s.id
        this.streaming = null

        // 以 message_end 的 usage 为准（流式期间的可能是 0 或旧值）
        const finalUsage = toUsage(m.usage) ?? s.usage
        const sp = this.speedOf({ ...s, usage: finalUsage })
        const msg: UIMessage = {
          id,
          role: 'assistant',
          text: s.text,
          thinking: s.thinking || undefined,
          thinkingMs: s.thinkingMs,
          toolCalls: s.tools.length ? s.tools : undefined,
          usage: finalUsage,
          speed: sp.speed,
          elapsedMs: sp.elapsedMs,
          model: m.model,
          timestamp: m.timestamp ?? Date.now(),
          error: m.stopReason === 'error' ? '模型返回错误' : undefined
        }
        this.messages.push(msg)
        this.push({
          ch: 'msg-update',
          payload: { id, patch: msg }
        })
        this.markStreaming(false)
        break
      }

      /* ---- 工具执行 ---- */
      case 'tool_execution_start': {
        const call = this.findOrCreateCall(
          String(evt.toolCallId ?? ''),
          String(evt.toolName ?? 'tool'),
          evt.args
        )
        call.status = 'running'
        call.startedAt = Date.now()
        this.pushTool(call)
        break
      }

      case 'tool_execution_update': {
        const call = this.findCall(String(evt.toolCallId ?? ''))
        if (!call) break
        const partial = evt.partialResult as { content?: PiContentBlock[]; details?: unknown } | undefined
        call.output = (partial?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
        call.details = partial?.details
        this.pushTool(call)
        break
      }

      case 'tool_execution_end': {
        const call = this.findCall(String(evt.toolCallId ?? ''))
        if (!call) break
        const result = evt.result as { content?: PiContentBlock[]; details?: unknown } | undefined
        call.status = evt.isError ? 'error' : 'ok'
        call.output = (result?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
        call.details = result?.details
        call.endedAt = Date.now()
        this.pushTool(call)

        // remember / forget 改了记忆文件 → 让界面刷新
        if (call.name === 'remember' || call.name === 'forget') {
          this.emit('memory-touched')
        }
        // panel_todos 改了会话里的 custom entry → 任务清单要重读
        if (call.name === 'panel_todos') {
          void this.refreshTodos()
        }
        break
      }

      /* ---- 会话级 ---- */
      case 'agent_start':
        this.markStreaming(true)
        break

      case 'agent_settled':
        this.markStreaming(false)
        void this.refreshState()
        void this.refreshStats()
        // 兑底：扩展也可能通过 /panel task 命令改任务（不经过工具调用）
        void this.refreshTodos()
        // 第一次聊完 → 用模型给这个会话起个短标题
        void this.maybeGenerateTitle()
        break

      case 'turn_end':
      case 'agent_end':
        void this.refreshStats()
        break

      case 'queue_update':
        this.push({
          ch: 'queue',
          payload: {
            steering: Array.isArray(evt.steering) ? (evt.steering as string[]) : [],
            followUp: Array.isArray(evt.followUp) ? (evt.followUp as string[]) : []
          } satisfies QueueState
        })
        break

      /* ---- 直执行 bash 的流式输出 ---- */
      case 'bash_execution_update': {
        if (!this.bash) break
        // 只接属于当前那次 bash 的 chunk
        const evtId = String(evt.id ?? '')
        if (evtId && evtId !== this.bash.reqId) break

        this.bash.output += String(evt.delta ?? '')
        // 与助手消息共用节流：bash 输出可能很密
        if (this.flushTimer) break
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null
          this.flushBash()
        }, FLUSH_MS)
        break
      }

      case 'compaction_start':
        this.markStreaming(true)
        void this.refreshState()
        break

      case 'compaction_end':
        this.markStreaming(false)
        void this.refreshState()
        void this.refreshStats()
        void this.hydrate()
        break

      case 'thinking_level_changed':
        void this.refreshState()
        break

      case 'model_change':
        void this.refreshState()
        break

      case 'auto_retry_start':
        this.push({
          ch: 'notify',
          payload: {
            id: `retry-${Date.now()}`,
            method: 'notify',
            notifyType: 'warning',
            message: `上游出错，第 ${Number(evt.attempt ?? 1)} 次重试…`
          }
        })
        break

      case 'auto_retry_end':
        if (evt.success === false) {
          this.push({
            ch: 'notify',
            payload: {
              id: `retry-fail-${Date.now()}`,
              method: 'notify',
              notifyType: 'error',
              message: '重试失败，本轮结束。'
            }
          })
        }
        break

      case 'extension_error':
        this.push({
          ch: 'notify',
          payload: {
            id: `ext-${Date.now()}`,
            method: 'notify',
            notifyType: 'error',
            message: `扩展出错：${String(evt.error ?? evt.message ?? '未知')}`
          }
        })
        break

      default:
        break
    }
  }

  /* ------------------------------------------------------- 消息组装辅助 */

  private findCall(id: string): UIToolCall | undefined {
    if (!id) return undefined
    for (const m of this.messages) {
      const hit = m.toolCalls?.find((c) => c.id === id)
      if (hit) return hit
    }
    return this.streaming?.tools.find((c) => c.id === id)
  }

  private findOrCreateCall(id: string, name: string, args: unknown): UIToolCall {
    const existing = this.findCall(id)
    if (existing) return existing

    const call: UIToolCall = { id, name, args, status: 'running', startedAt: Date.now() }
    if (this.streaming) {
      this.streaming.tools.push(call)
    } else {
      // 没有对应的助手消息（例如扩展直接调工具）—— 补一条
      const msg: UIMessage = {
        id: `t${Date.now().toString(36)}`,
        role: 'assistant',
        text: '',
        toolCalls: [call],
        timestamp: Date.now()
      }
      this.messages.push(msg)
      this.push({ ch: 'msg-add', payload: msg })
    }
    return call
  }

  /** 工具补丁：先找到它属于哪条消息 */
  private pushTool(call: UIToolCall): void {
    let msgId = this.streaming?.id
    if (!msgId) {
      for (const m of this.messages) {
        if (m.toolCalls?.some((c) => c.id === call.id)) {
          msgId = m.id
          break
        }
      }
    }
    if (!msgId) return
    this.push({ ch: 'tool', payload: { msgId, call: { ...call } } })
  }

  /** 流式文本节流：累积到下一帧再推，避免每个 delta 一次 IPC */
  private markDirty(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
    }, FLUSH_MS)
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.dirty || !this.streaming) return
    this.dirty = false
    const s = this.streaming
    const sp = this.speedOf(s)
    this.push({
      ch: 'msg-update',
      payload: {
        id: s.id,
        patch: {
          text: s.text,
          thinking: s.thinking || undefined,
          thinkingMs: s.thinkingMs,
          toolCalls: s.tools.length ? s.tools : undefined,
          // 流式期间也让输入/输出/速度实时更新
          usage: s.usage,
          speed: sp.speed,
          elapsedMs: sp.elapsedMs
        }
      }
    })
  }

  /**
   * 算输出速率（token/秒）。
   *
   * 用「首个内容 token 到达」到最后的时间，而不是整个回合 ——
   * 排队、首包延迟、工具往返都不该算进生成速度，否则会偏低。
   *
   * 拿不到 usage.output 时返回 undefined（宁可不显示，也不拿字符数瞎猜）。
   */
  private speedOf(s: {
    usage?: Usage
    firstTokenAt?: number
    startedAt?: number
  }, endedAt = Date.now()): { speed?: number; elapsedMs?: number } {
    const out = s.usage?.output ?? 0
    const from = s.firstTokenAt ?? s.startedAt
    if (!out || !from) return {}
    const ms = Math.max(1, endedAt - from)
    return { speed: out / (ms / 1000), elapsedMs: ms }
  }

  /** 直执行 bash 的流式推送 */
  private flushBash(): void {
    if (!this.bash) return
    const b = this.bash
    this.push({
      ch: 'msg-update',
      payload: {
        id: b.msgId,
        patch: {
          text: b.command,
          bash: { command: b.command, exitCode: null, cancelled: false },
          toolCalls: [
            {
              id: b.msgId,
              name: 'bash',
              args: { command: b.command },
              status: 'running',
              output: b.output
            }
          ]
        }
      }
    })
  }

  private markStreaming(v: boolean): void {
    if (!this.state) return
    if (this.state.isStreaming === v) return
    this.state = { ...this.state, isStreaming: v }
    this.push({ ch: 'state', payload: this.state })
  }

  /* -------------------------------------------------------------- 扩展 UI */

  private handleUi(req: Record<string, unknown>): void {
    const id = String(req.id ?? '')
    const method = String(req.method ?? '')

    // fire-and-forget 的几种
    if (method === 'notify') {
      this.push({ ch: 'notify', payload: { id, method: 'notify', ...req } as never })
      return
    }
    if (method === 'setStatus') {
      this.push({
        ch: 'status',
        payload: {
          key: String(req.statusKey ?? 'ext'),
          text: req.statusText === undefined ? undefined : String(req.statusText)
        }
      })
      return
    }
    if (method === 'setTitle') {
      this.push({ ch: 'title', payload: String(req.title ?? '砚') })
      return
    }
    if (method === 'set_editor_text') {
      this.push({ ch: 'editor-text', payload: String(req.text ?? '') })
      return
    }
    if (method === 'setWidget') {
      // TUI 专属，桌面端不做 widget；记录下来方便排查
      this.push({
        ch: 'proc',
        payload: {
          state: 'stderr',
          detail: `[扩展 ${String(req.widgetKey ?? '?')}] setWidget 在桌面端不支持，已忽略`
        }
      })
      return
    }

    // 需要应答的对话框
    if (id && this.uiSeen.has(id)) return
    if (id) this.uiSeen.add(id)
    this.push({ ch: 'ui-request', payload: { id, method, ...req } as never })
  }

  /** 渲染端回答案（由 IPC 调） */
  respondUi(res: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    this.rpc?.respondUi(res as Record<string, unknown>)
  }

  /* ---------------------------------------------------------------- 命令 */

  async send(text: string, images?: { data: string; mimeType: string }[]): Promise<{ ok: boolean; error?: string }> {
    const payload: Record<string, unknown> = { message: text }
    if (images?.length) {
      payload.images = images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))
    }
    // 流式中必须指定行为，否则 pi 直接报错
    if (this.state?.isStreaming) payload.streamingBehavior = 'steer'

    const res = await this.rpc!.command('prompt', payload)
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async steer(text: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('steer', { message: text })
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async followUp(text: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('follow_up', { message: text })
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async abort(): Promise<{ steering: string[]; followUp: string[] }> {
    // 按 pi 的约定：先 clear_queue 再 abort，把排队的文本拿回来。
    // 否则用户打了一半又改主意的话，那几句话就白打了（rpc.md §clear_queue）。
    let cleared: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] }
    try {
      const res = await this.rpc?.command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
      if (res?.success && res.data) {
        cleared = { steering: res.data.steering ?? [], followUp: res.data.followUp ?? [] }
      }
    } catch {
      /* clear_queue 失败不阻碍中止 */
    }

    // 本地先把流式收尾，UI 立刻有反馈
    if (this.streaming) {
      const s = this.streaming
      this.streaming = null
      const msg: UIMessage = {
        id: s.id,
        role: 'assistant',
        text: s.text,
        thinking: s.thinking || undefined,
        toolCalls: s.tools.length ? s.tools : undefined,
        timestamp: Date.now()
      }
      this.messages.push(msg)
      this.push({ ch: 'msg-update', payload: { id: s.id, patch: msg } })
    }

    // 直执行的 bash 也要收尾
    if (this.bash) {
      const b = this.bash
      this.bash = null
      this.push({
        ch: 'msg-update',
        payload: {
          id: b.msgId,
          patch: {
            bash: { command: b.command, exitCode: null, cancelled: true },
            toolCalls: [
              {
                id: b.msgId,
                name: 'bash',
                args: { command: b.command },
                status: 'error',
                output: b.output,
                endedAt: Date.now()
              }
            ]
          }
        }
      })
      await this.rpc?.command('abort_bash').catch(() => null)
    }

    this.markStreaming(false)
    await this.rpc?.command('abort').catch(() => null)
    void this.refreshState()

    return cleared
  }

  /* ------------------------------------------------------ 直执行 bash */

  /**
   * 跑一个 shell 命令，不走 LLM。
   * pi 会把它当成 BashExecutionMessage 存进会话，**下一次 prompt 时会进上下文**。
   * 所以这是「我先看一眼，再让它基于这个结果干活」的逃生口。
   */
  async runBash(command: string): Promise<{ ok: boolean; error?: string }> {
    const cmd = command.trim()
    if (!cmd) return { ok: false, error: '命令为空' }
    if (this.bash) return { ok: false, error: '已有一条命令在跑' }

    const reqId = `yan-bash-${Date.now().toString(36)}`
    const msgId = `bash-${reqId}`
    this.bash = { reqId, msgId, command: cmd, output: '' }

    const msg: UIMessage = {
      id: msgId,
      role: 'bash',
      text: cmd,
      bash: { command: cmd, exitCode: null, cancelled: false },
      toolCalls: [
        { id: msgId, name: 'bash', args: { command: cmd }, status: 'running', output: '', startedAt: Date.now() }
      ],
      timestamp: Date.now()
    }
    this.messages.push(msg)
    this.push({ ch: 'msg-add', payload: msg })

    try {
      // bash 可能跑很久（编译/测试），给足超时
      const res = await this.rpc!.command<{
        output?: string
        exitCode?: number
        cancelled?: boolean
        truncated?: boolean
        fullOutputPath?: string
      }>('bash', { command: cmd }, { id: reqId, timeoutMs: 0 + 30 * 60_000 })

      const b = this.bash
      this.bash = null

      if (!res.success) {
        this.finishBash(msgId, cmd, b?.output ?? '', null, true, res.error)
        return { ok: false, error: res.error }
      }

      const d = res.data ?? {}
      // 流式可能不完整（某些命令一次性吐完），用响应的 output 兼底
      const output = d.output && d.output.length > (b?.output.length ?? 0) ? d.output : (b?.output ?? '')
      this.finishBash(msgId, cmd, output, d.exitCode ?? null, !!d.cancelled, undefined, d.truncated, d.fullOutputPath)
      return { ok: true }
    } catch (e) {
      const b = this.bash
      this.bash = null
      const err = e instanceof Error ? e.message : String(e)
      this.finishBash(msgId, cmd, b?.output ?? '', null, true, err)
      return { ok: false, error: err }
    }
  }

  private finishBash(
    msgId: string,
    command: string,
    output: string,
    exitCode: number | null,
    cancelled: boolean,
    error?: string,
    truncated?: boolean,
    fullOutputPath?: string
  ): void {
    const failed = cancelled || exitCode === null || exitCode !== 0
    this.push({
      ch: 'msg-update',
      payload: {
        id: msgId,
        patch: {
          text: command,
          bash: { command, exitCode, cancelled },
          error,
          toolCalls: [
            {
              id: msgId,
              name: 'bash',
              args: { command },
              status: failed ? 'error' : 'ok',
              output,
              details: truncated ? { truncated, fullOutputPath } : undefined,
              endedAt: Date.now()
            }
          ]
        }
      }
    })
  }

  async abortBash(): Promise<void> {
    await this.rpc?.command('abort_bash').catch(() => null)
  }

  /* ---------------------------------------------------------- 会话管理 */

  async newSession(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('new_session')
    if (!res.success) return { ok: false, error: res.error }
    if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
      return { ok: false, error: '会话切换被扩展取消' }
    }
    this.uiSeen.clear()
    await this.hydrate()
    return { ok: true }
  }

  async switchSession(path: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('switch_session', { sessionPath: path })
    if (!res.success) return { ok: false, error: res.error }
    if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
      return { ok: false, error: '会话切换被扩展取消' }
    }
    this.uiSeen.clear()
    await this.hydrate()
    return { ok: true }
  }

  /**
   * 给会话起名。
   *
   * ⚠️ 空名字会被 pi 拒绝（`set_session_name` 返回 success:false）。
   * 所以这里直接拦住，并把错误信息说清楚 —— 否则用户看到的是“重命名失败”
   * 但不知道因为什么。
   */
  async renameSession(name: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = name.trim()
    if (!trimmed) {
      return { ok: false, error: '名字不能为空（pi 不支持清除会话名）' }
    }
    const res = await this.rpc!.command('set_session_name', { name: trimmed })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async fork(entryId: string): Promise<{ ok: boolean; error?: string; text?: string }> {
    const res = await this.rpc!.command<{ text?: string; cancelled?: boolean }>('fork', { entryId })
    if (!res.success) return { ok: false, error: res.error }
    if (res.data?.cancelled) return { ok: false, error: '分叉被扩展取消' }
    this.uiSeen.clear()
    await this.hydrate()
    return { ok: true, text: res.data?.text }
  }

  async clone(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command<{ cancelled?: boolean }>('clone')
    if (!res.success) return { ok: false, error: res.error }
    if (res.data?.cancelled) return { ok: false, error: '复制被扩展取消' }
    this.uiSeen.clear()
    await this.hydrate()
    return { ok: true }
  }

  async forkPoints(): Promise<ForkPoint[]> {
    const res = await this.rpc!.command<{ messages?: ForkPoint[] }>('get_fork_messages')
    return res.success ? (res.data?.messages ?? []) : []
  }

  async exportHtml(): Promise<{ ok: boolean; path?: string; error?: string }> {
    const res = await this.rpc!.command<{ path?: string }>('export_html')
    if (!res.success) return { ok: false, error: res.error }
    return { ok: true, path: res.data?.path }
  }

  async compact(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('compact')
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /* ---------------------------------------------------------- 模型 / 开关 */

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.rpc!.command<{ models?: ModelInfo[] }>('get_available_models')
    return res.success ? (res.data?.models ?? []) : []
  }

  async setModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_model', { provider, modelId })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async setThinking(level: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_thinking_level', { level })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async listThinkingLevels(): Promise<string[]> {
    const res = await this.rpc!.command<{ levels?: string[] }>('get_available_thinking_levels')
    const levels = res.success ? (res.data?.levels ?? []) : []
    if (this.state) {
      this.state = { ...this.state, availableThinkingLevels: levels }
      this.push({ ch: 'state', payload: this.state })
    }
    return levels
  }

  async setAutoCompaction(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_auto_compaction', { enabled })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async setAutoRetry(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_auto_retry', { enabled })
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async listCommands(): Promise<SlashCommand[]> {
    const res = await this.rpc!.command<{ commands?: SlashCommand[] }>('get_commands')
    return res.success ? (res.data?.commands ?? []) : []
  }

  /* ------------------------------------------------------------ 查询 */

  async getMessages(): Promise<UIMessage[]> {
    return this.messages
  }

  async refreshState(): Promise<SessionState | null> {
    try {
      const res = await this.rpc?.command('get_state')
      if (res?.success) this.setStateFrom(res.data as Record<string, unknown>)
    } catch {
      /* 进程没了 */
    }
    return this.state
  }

  async refreshStats(): Promise<SessionStats | null> {
    try {
      const res = await this.rpc?.command<SessionStats>('get_session_stats')
      if (res?.success && res.data) {
        this.push({ ch: 'stats', payload: res.data })
        return res.data
      }
    } catch {
      /* ignore */
    }
    return null
  }

  /* ---------------------------------------------------------- 标题生成 */

  /**
   * 用模型把用户的第一句话总结成短标题。
   *
   * 触发条件（三个都要满足，否则一次都不发请求）：
   *   ① 这个会话还没有名字（用户没起过）
   *   ② 有至少一条用户消息（否则没东西可总结）
   *   ③ 这个会话本次运行还没试过
   *
   * 为什么用独立进程：见 src/main/title.ts 的说明 —— 复用主会话会污染对话、
   * 还会让 prompt cache 失效（那个代价比一次请求贵得多）。
   */
  private async maybeGenerateTitle(): Promise<void> {
    const st = this.state
    if (!st) return
    if (st.sessionName) return // 用户已经起过名字
    if (this.titleTried.has(st.sessionId)) return

    const firstUser = this.messages.find((m) => m.role === 'user' && m.text.trim())
    if (!firstUser) return

    this.titleTried.add(st.sessionId)

    try {
      const res = await generateTitle({
        sessionId: st.sessionId,
        firstMessage: firstUser.text,
        cwd: this.cwd,
        piBin: this.piBin
      })
      if (!res?.title) return

      // 写回 pi（TUI 的 /resume 也能看到）
      const ok = await this.rpc?.command('set_session_name', { name: res.title })
      if (ok?.success) await this.refreshState()
      // 不管写没写进 pi，都推给界面 —— 标题是给用户看的
      this.push({ ch: 'session-title', payload: { sessionId: st.sessionId, title: res.title } })
    } catch (e) {
      // 标题失败不该影响任何事
      console.error('[agent] 标题生成失败：', e)
    }
  }

  getState(): SessionState | null {
    return this.state
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.streaming = null
    this.bash = null
    await this.rpc?.close()
    this.rpc = null
    this.messages = []
  }
}

export type { BashRun, ForkPoint, SlashCommand }
