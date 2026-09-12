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
import {
  normalizeHistory,
  normalizeMessage,
  toUsage,
  type PiContentBlock,
  type PiMessage
} from './normalize'
import { SESSIONS_DIR, SESSIONS_DIR_IS_OVERRIDE } from './sessions'
import { generateTitle } from './title'
import { trimTree } from './session-tree'
import type {
  BashRun,
  CustomEntry,
  ForkPoint,
  MainPush,
  ModelInfo,
  PiInfo,
  QueueMode,
  QueueState,
  SessionState,
  SessionStats,
  SessionTodo,
  SessionTodoSnapshot,
  SessionTree,
  SlashCommand,
  UIMessage,
  UIToolCall,
  Usage
} from '../shared/ipc'

/** 流式文本的推送节流：60 帧够了，再多是给 IPC 白干活 */
const FLUSH_MS = 16


/** 推送补丁到渲染端（主进程注入） */
type Push = (msg: MainPush) => void

/* ------------------------------------------------------------ 任务清单 */

/**
 * 从会话的 custom entries 里抽任务清单 —— **全部快照**，不只最后一份。
 *
 * 用户的 `left-info-panel.ts` 用 `pi.appendEntry('left-panel-tasks', {todos})` 写，
 * 数据形状是 `{ todos: {text, done}[] }`。**每轮都会写一份**（agent 重新规划任务时
 * 覆盖写一个新的 entry），所以旧的那些就是「历史任务」——
 * 上一版只留最后一份，于是界面上完全看不到历史（用户提了这个需求）。
 *
 * `round`：这份清单是在第几轮写的 —— 数一下它前面有多少条消息即可。
 * 有了它，「跳转到那次任务的对话」才能真的跳（否则只能跳到最后）。
 * 数的是 message entry，与 UI 的回合分组口径一致（都以用户消息为界）。
 */
function todoSnapshotsFromEntries(
  entries: Record<string, unknown>[]
): SessionTodoSnapshot[] {
  const out: SessionTodoSnapshot[] = []
  let userMsgs = 0

  for (const e of entries) {
    /*
     * 先算轮次：遇到用户消息就 +1。
     * 所以在这之后写的任务清单属于「第 userMsgs 轮」。
     */
    if (e.type === 'message') {
      const m = e.message as { role?: unknown } | undefined
      if (m?.role === 'user') userMsgs++
      continue
    }
    if (e.type !== 'custom') continue

    const ct = String(e.customType ?? '')
    // 具体名字认不出来就跳过 —— 不能把所有 custom entry 都当任务
    if (!/task|todo/i.test(ct)) continue

    const data = e.data as { todos?: unknown } | undefined
    if (!Array.isArray(data?.todos)) continue

    const todos = data.todos
      .filter((t): t is { text?: unknown; done?: unknown } => !!t && typeof t === 'object')
      .map((t) => ({ text: String(t.text ?? ''), done: Boolean(t.done) }))
      .filter((t) => t.text.length > 0)
    if (todos.length === 0) continue

    out.push({
      id: String(e.id ?? `t${out.length}`),
      todos,
      round: Math.max(1, userMsgs)
    })
  }

  return out
}

/**
 * pi 的队列模式字段是自由字符串（协议文档只保证这两个值）。
 * 认不出就当成 undefined —— 宁可界面不显示，也不能因为一个认知外的值而崩。
 */
function normalizeQueueMode(v: unknown): QueueMode | undefined {
  return v === 'all' || v === 'one-at-a-time' ? v : undefined
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
   * 正在生成标题的会话（防并发）。
   *
   * 用户要求每轮都重算，所以它只做「同一会话不要同时跑两个标题进程」，
   * 而不是「一个会话只生成一次」。
   */
  private titleTried = new Set<string>()

  /** 上一次真的写进 pi 的标题（去重，避免每轮都改会话文件） */
  private lastTitle: string | undefined

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

    // 历史会话的标题补生成：
    // 只对「还没有缓存的会话」做（force 默认 false，命中缓存就直接返回），
    // 所以切到一个看过的会话不会反复烧钱。
    this.titleTried.clear()
    this.lastTitle = undefined
    void this.maybeGenerateTitle()
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
      const snaps = todoSnapshotsFromEntries(res.data?.entries ?? [])
      /*
       * 推两条：
       *   · todos —— 最新那份（旧行为不变，界面主体的任务清单就是它）
       *   · todo-history —— 全部快照（含最新），供「历史任务」模块用
       * 兼容性：单独加一条 push 而不是改 todos 的形状 ——
       * 已有探针与界面都按「todos = 当前清单」写的。
       */
      const latest = snaps.length ? snaps[snaps.length - 1].todos : []
      this.push({ ch: 'todos', payload: latest })
      this.push({ ch: 'todo-history', payload: snaps })
      return latest
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
        data.autoCompactionEnabled === undefined ? undefined : !!data.autoCompactionEnabled,
      steeringMode: normalizeQueueMode(data.steeringMode),
      followUpMode: normalizeQueueMode(data.followUpMode)
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
        // 每轮结束都重算标题（用户要求每次都是新生成的）
        void this.maybeGenerateTitle({ force: true })
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
      // TUI 里它显示在输入框上方。桌面端把它收进右栏「扩展」分区 ——
      // 扩展写的东西（MCP/LSP 状态之类）对用户有意义，直接丢等于骗扩展。
      const lines = Array.isArray(req.widgetLines) ? req.widgetLines.map((x) => String(x)) : undefined
      this.push({ ch: 'widget', payload: { key: String(req.widgetKey ?? 'ext'), lines } })
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

  /**
   * 取当前会话的分支树（已裁成「分支点 + 标签」）。
   * 为什么要裁：实测真实会话有 2000+ 节点，原样发给界面既慢又没法显示。
   */
  /** 当前会话文件路径（分支树要知道属于哪个会话） */
  currentSessionPath(): string {
    return this.state?.sessionFile ?? ''
  }

  async sessionTree(sessionPath: string): Promise<SessionTree> {
    const res = await this.rpc?.command<{ tree?: unknown[]; leafId?: string }>('get_tree')
    if (!res?.success || !Array.isArray(res.data?.tree)) {
      return { branches: [], points: 0, total: 0 }
    }
    const t = trimTree(res.data.tree as never, String(res.data.leafId ?? ''), sessionPath)
    return t
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

  /* -------------------------------------------------- 队列模式 / 轮换 */

  /**
   * 排队消息的投递方式。
   *
   * 为什么值得做：用户在生成中插话（steer）时，“什么时候听我的”有两种真实选择 ——
   *   一次说完（all）：当前工具跑完就全部投进去
   *   一次一条（one-at-a-time）：每完成一个回合投一条，节奏更可控
   * 这是 pi 的正式能力，藏着一个没法用的选项等于少了半个功能。
   */
  async setSteeringMode(mode: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_steering_mode', { mode })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  async setFollowUpMode(mode: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_follow_up_mode', { mode })
    if (res.success) await this.refreshState()
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /** 取消正在等待的重试（自动重试计时器还开着的时候特别有用） */
  async abortRetry(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('abort_retry')
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /**
   * 循环切下一个模型（TUI 的 Ctrl+P）。
   *
   * ⚠️ 这里**不用** pi 的 `cycle_model`。
   *   pi 的 cycle 只在它自己的 “scoped models” 列表里转（默认是从配置推出来的
   *   一小撮），而界面上的选择器列出的是 `get_available_models` 的全部。
   *   两者不一致时，用户按 Ctrl+P 看到的行为就是「模型跳到了一个我没见过的」。
   *   所以按**界面所示的顺序**走：拿当前模型在完整列表里的下一个。
   *
   * 按 provider 分组、组内保持原顺序 —— 与选择器渲染的一致，
   * 否则“下一个”与面板里看到的“下一行”不是一个东西。
   */
  async cycleModel(): Promise<{ ok: boolean; error?: string; to?: string }> {
    const models = await this.listModels()
    if (models.length < 2) return { ok: false, error: '只有一个可用模型' }

    const cur = this.state?.model
    const i = models.findIndex((m) => m.provider === cur?.provider && m.id === cur?.id)
    // 当前模型不在列表里（刚切过来 / 列表变了）→ 从第一个开始
    const next = models[i < 0 ? 0 : (i + 1) % models.length]

    const res = await this.rpc!.command('set_model', {
      provider: next.provider,
      modelId: next.id
    })
    if (!res.success) return { ok: false, error: res.error }

    await this.refreshState()
    // 换模型后可用档位会变 —— 旧列表里的 high/max 可能不存在了
    const levels = await this.listThinkingLevels()
    if (this.state && levels.length) {
      this.state = { ...this.state, availableThinkingLevels: levels }
      this.push({ ch: 'state', payload: this.state })
    }
    return { ok: true, to: next.name }
  }

  /** 循环切下一档思考强度（TUI 的 Shift+Tab）。同样按界面所示档位走。 */
  async cycleThinking(): Promise<{ ok: boolean; error?: string; to?: string }> {
    const levels = await this.listThinkingLevels()
    if (levels.length < 2) return { ok: false, error: '当前模型不支持思考' }

    const cur = this.state?.thinkingLevel ?? 'off'
    const i = levels.indexOf(cur)
    const next = levels[i < 0 ? 0 : (i + 1) % levels.length]

    const res = await this.rpc!.command('set_thinking_level', { level: next })
    if (!res.success) return { ok: false, error: res.error }

    await this.refreshState()
    return { ok: true, to: next }
  }

  /** 最后一条助手消息的纯文本（复制用） */
  async lastAssistantText(): Promise<string | null> {
    const res = await this.rpc!.command<{ text?: string | null }>('get_last_assistant_text')
    if (!res.success) return null
    return res.data?.text ?? null
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
   * 用模型给会话起一个短标题（≤ 8 字）。
   *
   * 触发条件：
   *   ① 这个会话至少有一条用户消息（没东西可总结）
   *   ② 该会话现在没有正在跑的标题任务（避免并发多个 pi 进程）
   *
   * ⚠️ 用户要求「每次对话标题需要 agent 生成一个新的」—— 所以**每轮**都会重算
   * （ `force: true` 绕过缓存）。代价是每轮多一个 `--no-session --no-extensions`
   * 的短进程；这是用户明确要的行为，不是疏忽。
   *
   * 为什么用独立进程：见 src/main/title.ts —— 复用主会话会污染对话、
   * 还会让 prompt cache 全部失效（那个代价比一次请求贵得多）。
   */
  private async maybeGenerateTitle(opts: { force?: boolean } = {}): Promise<void> {
    const st = this.state
    if (!st) return
    if (this.titleTried.has(st.sessionId)) return

    const users = this.messages.filter((m) => m.role === 'user' && m.text.trim())
    if (users.length === 0) return

    // 样本：第一句 + 最近一句。只给第一句的话，
    // 一个聊到第四轮的会话标题会一直停在第一句的话题上。
    const samples = [users[0].text, users[users.length - 1].text]

    this.titleTried.add(st.sessionId)
    const sessionId = st.sessionId

    try {
      const res = await generateTitle({
        sessionId,
        samples,
        cwd: this.cwd,
        piBin: this.piBin,
        force: opts.force
      })
      if (!res?.title) return

      // 写回 pi（TUI 的 /resume 也能看到）。
      // ⚠️ 只有在标题真的变了才写 —— set_session_name 会改会话文件，
      // 每轮都写一下是没意义的磁盘写入。
      if (this.lastTitle !== res.title) {
        this.lastTitle = res.title
        const ok = await this.rpc?.command('set_session_name', { name: res.title })
        if (ok?.success) await this.refreshState()
      }
      // 不管写没写进 pi，都推给界面 —— 标题是给用户看的
      this.push({ ch: 'session-title', payload: { sessionId, title: res.title } })
    } catch (e) {
      // 标题失败不该影响任何事
      console.error('[agent] 标题生成失败：', e)
    } finally {
      this.titleTried.delete(sessionId)
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
