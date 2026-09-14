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
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { generateTitle } from './title'
import { todoSnapshotsFromEntries } from './todo-snapshots'
import type {
  BashRun,
  CustomEntry,
  ForkPoint,
  MainPush,
  ModelInfo,
  QueueMode,
  QueueState,
  SessionState,
  SessionStats,
  SessionTodo,
  SlashCommand,
  UIMessage,
  UIToolCall,
  Usage
} from '../shared/ipc'

/** 流式文本的推送节流：60 帧够了，再多是给 IPC 白干活 */
const FLUSH_MS = 16
/**
 * 节流间隔的上限。
 *
 * 文本/输出越长，一帧要序列化、要 diff 的字节越多 —— 这时把间隔拉开比
 * 「硬撑 60fps」更划算：每次推送都是**值得的**，而不是把主线程压在
 * 全量重传上。实测（见 MessageParts.tsx 顶部）一帧的渲染预算会被
 * 几十万字的累积文本吃穿，所以让它自然降频到 10~20fps 比卡顿好。
 */
const MAX_FLUSH_MS = 120


/** 推送补丁到渲染端（主进程注入） */
type Push = (msg: MainPush) => void

/* ------------------------------------------------------------ 任务清单 */
/**
 * pi 的队列模式字段是自由字符串（协议文档只保证这两个值）。
 * 认不出就当成 undefined —— 宁可界面不显示，也不能因为一个认知外的值而崩。
 */
function normalizeQueueMode(v: unknown): QueueMode | undefined {
  return v === 'all' || v === 'one-at-a-time' ? v : undefined
}

/* AgentController */

export class AgentController extends EventEmitter {
  private rpc: PiRpc | null = null
  private push: Push
  private cwd: string
  private piBin?: string
  private browserExtension?: string
  private questionExtension?: string
  private browserEnv?: NodeJS.ProcessEnv
  /** 追加系统提示（--append-system-prompt），见构造函数注释 */
  private appendSystemPrompt?: string

  /** 权威消息列表 */
  private messages: UIMessage[] = []
  /** 正在流式的那条助手消息 */
  private streaming: {
    id: string
    text: string
    thinking: string
    thinkingMs?: number
    thinkingStartedAt?: number
    /** 正在流式思考（thinking_start 置位、thinking_end 清掉） */
    thinkingLive?: boolean
    tools: UIToolCall[]
    /** 本轮助手消息开始生成的时间 */
    startedAt?: number
    /** 首个 token 到达的时间（用于更准的速率：排除排队/首包延迟） */
    firstTokenAt?: number
    /** 累积 usage（message_update 里带的就是累积值） */
    usage?: Usage
    /**
     * 已经推给渲染端的文本长度（增量推送的游标）。
     *
     * 为什么不用「每次重发全量文本」：流式期间每帧都带整篇累积文本，
     * 一篇 50KB 的回答推 300 帧就是 15MB 的结构化克隆 + React 状态复制，
     * 越长越贵（O(N²)）。存个游标只需发新的那一段。
     * 权威对齐由 message_end / sync 的全量快照负责。
     */
    pushedText: number
    /** 同上，思考文本的游标 */
    pushedThinking: number
  } | null = null
  /** 回合级「正在干活」（含工具执行），见 setAgentRunning */
  private agentRunning = false
  /** 文本脏（有新的流式文本待推） */
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 工具输出的**增量**待推集合（callId）。
   *
   * 工具输出是最高频的路径（一条命令的 stdout 一秒几十上百 chunk），
   * 以前每个 chunk 都直接推一份完整累积输出 —— 一次长命令就是 O(N²) 字节。
   * 现在只标记脏，由共用的定时器批量取增量。
   */
  private dirtyTools = new Set<string>()
  /**
   * toolCallId → 工具对象 / 它属于哪条消息。
   *
   * 为什么要建索引：`findCall` 以前是**线性扫全部消息的 toolCalls**，
   * 而它会被每一个工具事件调用（高频）。一个 2000 条消息、上千次工具调用的
   * 会话下，这就是 O(n) × 每秒上百次。
   */
  private callIndex = new Map<string, UIToolCall>()
  private callOwner = new Map<string, string>()
  /** toolCallId → 已经推给渲染端的 output 长度（与 streaming.pushedText 同理） */
  private pushedOut = new Map<string, number>()

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
    piBin?: string
    browserExtension?: string
    questionExtension?: string
    browserEnv?: NodeJS.ProcessEnv
    /**
     * 追加到 pi 系统提示末尾的一段文本（--append-system-prompt）。
     * 目前用于「推理/回复跟随界面语言」——pi 只在启动时读它，
     * 所以语言切换时由主进程重启 agent（会话用 switch_session 恢复）。
     */
    appendSystemPrompt?: string
  }) {
    super()
    this.push = opts.push
    this.cwd = opts.cwd
    this.piBin = opts.piBin
    this.browserExtension = opts.browserExtension
    this.questionExtension = opts.questionExtension
    this.browserEnv = opts.browserEnv
    this.appendSystemPrompt = opts.appendSystemPrompt
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
        ...(this.browserExtension ? ['--extension', this.browserExtension] : []),
        // 内置提问扩展（模型可主动向用户提问；自主模式时改为自行决策）
        ...(this.questionExtension ? ['--extension', this.questionExtension] : []),
        /*
         * 测试/CI 用固定模型（YAN_TEST_MODEL = "provider/modelId"）。
         * 由 scripts/test-live.mjs 统一注入为 commandcode 的免费模型，
         * 避免每次跑真实场景都需要选定/付费；个别场景（如发图）可在 CASES 里覆盖。
         */
        ...(process.env.YAN_TEST_MODEL ? ['--model', process.env.YAN_TEST_MODEL] : []),
        // 追加系统提示（目前是「推理/回复跟随界面语言」）
        ...(this.appendSystemPrompt ? ['--append-system-prompt', this.appendSystemPrompt] : []),
        // 只在测试隔离时接管会话目录。
        // 平时不传 —— 传了 pi 就不再按 cwd 建项目子目录，
        // 会把新会话平铺到根目录，与用户已有会话分居两处。
        ...(SESSIONS_DIR_IS_OVERRIDE ? ['--session-dir', SESSIONS_DIR] : [])
        // 注意：**不传 --name**。
        // 曾经传 `--name 砚` 希望“好辨认”，结果每个新会话标题都是「砚」，
        // 在左栏里长得一模一样，等于没标题。
        // 让 pi 用首条用户消息当标题，才真正可辨认。
      ],
      env: {
        ...this.browserEnv,
        // 让内置扩展能读到桌面端设置（自主模式存在 desktop.json 里）。
        // 测试时 YAN_DATA_DIR 指向隔离目录，扩展会读到那份设置。
        YAN_DATA_DIR: YAN_DIR,
        // 便携版必须让 pi 也使用 EXE 同级的私有目录；否则它会回退到 ~/.pi。
        PI_CODING_AGENT_DIR: PI_AGENT_DIR
      }
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

    /*
     * 全量替换了消息列表 → 工具索引必须跟着重建。
     *
     * ⚠️ 不能只 clear()：此刻可能还有一条正在流的助手消息（compaction_end
     *    会调 hydrate），它的 tools 不在 messages 里而在 streaming 上 ——
     *    漏登记的话，后续 tool_execution_* 全部找不到 call，工具行就再也不更新。
     */
    this.callIndex.clear()
    this.callOwner.clear()
    this.pushedOut.clear()
    for (const msg of this.messages) this.indexCalls(msg)
    for (const call of this.streaming?.tools ?? []) {
      this.registerCall(call, this.streaming?.id)
    }

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
      /*
       * 回合级「正在干活」：从 agent_start 到 agent_settled，
       * **覆盖工具执行**。
       *
       * 为什么不能只用 isStreaming：它是「此刻有一条 assistant 消息在流」——
       * 第一段 assistant（带 toolcall）message_end 就把它清了，而工具还在跑、
       * 模型马上还要接着想/t回答。推理窗口的展开/折叠要用这个宽信号，
       * 否则「思考→执行工具」时推理会被折叠（用户报的）。
       */
      isAgentRunning: this.agentRunning,
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
            this.indexCalls(norm)
            this.push({ ch: 'msg-add', payload: norm })
          }
        } else if (m?.role === 'assistant') {
          const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
          this.streaming = {
            id,
            text: '',
            thinking: '',
            tools: [],
            startedAt: Date.now(),
            // 增量游标从 0 开始（渲染端拿到的 msg-add 里 text 也是空）
            pushedText: 0,
            pushedThinking: 0
          }
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
          this.streaming.thinkingLive = true
        } else if (kind === 'thinking_delta') {
          this.streaming.thinking += String(ev.delta ?? '')
          this.markDirty()
        } else if (kind === 'thinking_end') {
          const started = this.streaming.thinkingStartedAt
          if (started) this.streaming.thinkingMs = Date.now() - started
          this.streaming.thinkingLive = false
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
          this.registerCall(call, this.streaming.id)
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
        // 这一条消息的工具从此属于历史消息 —— 索引要落到 id 上（渲染端也会收到全量快照）
        for (const c of s.tools) this.registerCall(c, id)

        // 以 message_end 的 usage 为准（流式期间的可能是 0 或旧值）
        const finalUsage = toUsage(m.usage) ?? s.usage
        const sp = this.speedOf({ ...s, usage: finalUsage })
        const msg: UIMessage = {
          id,
          role: 'assistant',
          text: s.text,
          thinking: s.thinking || undefined,
          thinkingMs: s.thinkingMs,
          // 收尾了就不再是「正在思考」（即使是中途 abort 的）
          thinkingLive: false,
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
        /*
         * ⚠️ 这里**不能**直接 pushTool：这是最高频的事件（一条命令的 stdout
         *    一秒几十上百个 chunk），而每个 chunk 都带完整累积输出，
         *    推给渲染端就是 O(N²) 字节。只标脏，由共用定时器批量取增量。
         */
        this.markToolOutput(call.id)
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

        // panel_todos 改了会话里的 custom entry → 任务清单要重读
        if (call.name === 'panel_todos') {
          void this.refreshTodos()
        }
        break
      }

      /* ---- 会话级 ---- */
      case 'agent_start':
        this.markStreaming(true)
        this.setAgentRunning(true)
        break

      case 'agent_settled':
        this.markStreaming(false)
        this.setAgentRunning(false)
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
        /*
         * 与工具输出走**同一条增量通道**（同一套节流）。
         *
         * 以前这里每帧重发 command + toolCalls 数组（含完整累积输出），
         * 一条跑十几分钟的命令（构建/测试）会把它推成 O(N²) 字节 ——
         * 而命令文本与 bash 状态在 msg-add 时已经发过了，
         * 最终结果由 finishBash 发全量快照对齐。
         */
        const call = this.findCall(this.bash.msgId)
        if (call) call.output = this.bash.output
        this.markToolOutput(this.bash.msgId)
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

  /**
   * 登记一个工具（连同它的宿主消息）—— callIndex / callOwner 的**唯一**写入口。
   *
   * 不登记的话 `findCall` 就找不到它 → 工具行永远停在「正在运行」。
   */
  private registerCall(call: UIToolCall, msgId?: string): void {
    this.callIndex.set(call.id, call)
    const owner = msgId ?? this.callOwner.get(call.id)
    if (owner) this.callOwner.set(call.id, owner)
  }

  /** 一条消息里的全部工具都登记（hydrate / 历史消息） */
  private indexCalls(msg: UIMessage): void {
    for (const c of msg.toolCalls ?? []) this.registerCall(c, msg.id)
  }

  private findCall(id: string): UIToolCall | undefined {
    if (!id) return undefined
    return this.callIndex.get(id)
  }

  /** 这个工具属于哪条消息 */
  private ownerOf(call: UIToolCall): string | undefined {
    return this.callOwner.get(call.id) ?? this.streaming?.id
  }

  private findOrCreateCall(id: string, name: string, args: unknown): UIToolCall {
    const existing = this.findCall(id)
    if (existing) return existing

    const call: UIToolCall = { id, name, args, status: 'running', startedAt: Date.now() }
    if (this.streaming) {
      this.streaming.tools.push(call)
      this.registerCall(call, this.streaming.id)
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
      this.registerCall(call, msg.id)
    }
    return call
  }

  /** 工具补丁：**全量**推一个工具（状态 / 参数 / 最终结果变化时用） */
  private pushTool(call: UIToolCall): void {
    const msgId = this.ownerOf(call)
    if (!msgId) return
    /* 游标必须跟上：否则下一次增量会把已经发过的内容再发一遍 */
    this.pushedOut.set(call.id, call.output?.length ?? 0)
    /* 全量已经是最新的了 —— 待推的增量作废，否则会重复追加一遍 */
    this.dirtyTools.delete(call.id)
    this.push({ ch: 'tool', payload: { msgId, call: { ...call } } })
  }

  /**
   * 工具输出变了 —— 只标脏，由共用定时器批量取增量。
   *
   * 这是工具输出的**高频路径**（每个 chunk 一次）。
   */
  private markToolOutput(callId: string): void {
    if (!callId) return
    this.dirtyTools.add(callId)
    this.scheduleFlush()
  }

  /** 把标脏的工具输出**增量**推出去 */
  private flushTools(): void {
    if (!this.dirtyTools.size) return
    const ids = [...this.dirtyTools]
    this.dirtyTools.clear()

    for (const id of ids) {
      const call = this.callIndex.get(id)
      if (!call) {
        this.pushedOut.delete(id)
        continue
      }
      const pushed = this.pushedOut.get(id) ?? 0
      const out = call.output ?? ''
      if (out.length <= pushed) continue
      const msgId = this.ownerOf(call)
      if (!msgId) continue
      this.pushedOut.set(id, out.length)
      /*
       * ⚠️ 故意**不带全量 output**：那正是要避免的开销。
       *    渲染端按 `outputDelta` 追加（见 store 的 `'tool'` 分支）。
       *    这里把 output 显式置为 undefined，语义是「这一帧没有全量快照」；
       *    渲染端拼接时用的是**它自己的**旧 output + delta。
       */
      this.push({
        ch: 'tool',
        payload: {
          msgId,
          call: { ...call, output: undefined },
          outputDelta: out.slice(pushed)
        }
      })
    }
  }

  /** 流式文本节流：累积到下一帧再推，避免每个 delta 一次 IPC */
  private markDirty(): void {
    this.dirty = true
    this.scheduleFlush()
  }

  /**
   * 共用定时器：文本 / 工具输出 / bash 输出都走它。
   *
   * 为什么不各用一个定时器：三类更新常常同时到来（模型一边说话一边跑工具），
   * 分开就会在同一帧里推三次 IPC、触发三次 React 更新（另两次是白干）。
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
      this.flushTools()
    }, this.flushDelay())
  }

  /**
   * 节流间隔：随着累积文本/输出变长而拉大（上限 MAX_FLUSH_MS）。
   *
   * 理由见 MAX_FLUSH_MS：一帧的成本与已累积的文本量成正比，
   * 长回答/长输出时降频比卡顿好。
   */
  private flushDelay(): number {
    const len = (this.streaming?.text.length ?? 0) + (this.bash?.output.length ?? 0)
    return Math.min(MAX_FLUSH_MS, Math.max(FLUSH_MS, Math.round(len / 2000)))
  }

  /**
   * 把流式文本推给渲染端 —— **只发增量**（textDelta / thinkingDelta）。
   *
   * 全量版本的推送仍然存在（`message_end` / 中止 / sync），那是权威对齐。
   * 这里只负责「又长了几个字」。
   */
  private flushNow(): void {
    if (!this.dirty || !this.streaming) return
    this.dirty = false
    const s = this.streaming

    const textDelta = s.text.length > s.pushedText ? s.text.slice(s.pushedText) : ''
    const thinkingDelta =
      s.thinking.length > s.pushedThinking ? s.thinking.slice(s.pushedThinking) : ''
    s.pushedText = s.text.length
    s.pushedThinking = s.thinking.length

    const sp = this.speedOf(s)
    this.push({
      ch: 'msg-update',
      payload: {
        id: s.id,
        patch: {
          ...(textDelta ? { textDelta } : null),
          ...(thinkingDelta ? { thinkingDelta } : null),
          thinkingMs: s.thinkingMs,
          thinkingLive: s.thinkingLive,
          /*
           * ⚠️ 工具数组**不在这里重发**：它有自己的增量通道（`ch:'tool'`）。
           *    以前每帧都带着全部工具的完整 output，工具多/输出长的回合里
           *    每帧就是几百 KB 的结构化克隆。
           */
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

  /*
   * 这里曾经有一个 `flushBash()`：每帧把 command + toolCalls（含完整累积输出）
   * 重新推一遍。直执行 bash 的输出现在是工具增量通道的一部分
   * （见 `bash_execution_update` → `markToolOutput`），所以它被删掉了 ——
   * 留着会多出一条与增量协议并行的全量路径，两边迟早说不到一块去。
   */

  /**
   * 回合级「正在干活」。与 markStreaming 的区别：
   *   · isStreaming  = 此刻**有一条 assistant 消息在流**（工具执行期间为 false）；
   *   · agentRunning = 整个 agent 回合在跑（agent_start → agent_settled），
   *                    **覆盖工具执行**与中途的再思考。
   * 推理窗口的展开/折叠跟宽的那个走。
   */
  private setAgentRunning(v: boolean): void {
    if (this.agentRunning === v) return
    this.agentRunning = v
    if (!this.state) return
    this.state = { ...this.state, isAgentRunning: v }
    this.push({ ch: 'state', payload: this.state })
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
    // 智能体正在处理时必须指定投递行为，否则 pi 直接报错。
    // 默认**排队**（followUp）：等这一轮跑完再投递，不打断它。
    // 想立刻插入当前这轮，用队列行上的「插队」按钮（走 steerQueued）。
    //
    // ⚠️ 判据必须是**回合级**的 `agentRunning`，不能只看 `isStreaming`。
    //    `isStreaming` 只在「有一条 assistant 消息正在流」时为真：
    //    工具执行期间它是 false（每条 assistant 消息 message_end 就清掉了），
    //    但 pi 内部的 isStreaming 仍是 true —— 于是用户在工具执行时发消息，
    //    我们没带 streamingBehavior，pi 直接抛
    //    「Agent is already processing. Specify streamingBehavior...」（用户报的错）。
    if (this.agentRunning || this.state?.isStreaming) payload.streamingBehavior = 'followUp'

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

  /**
   * 把一条排队的消息「插队」提升为 steering（在当前这轮就听它的）。
   *
   * pi 没有「移除队列里某一条」的 RPC，只有 `clear_queue`（一次清空）。
   * 所以只能：先取出全部排队 → 把目标之外的内容按原类型重排 → 再把目标 steer。
   * 这里有固有的竞态（清空与重建之间 pi 可能已经投递了某条），
   * 所以失败不能吞：返回错误，由界面写进日志（用户要求「所有报错进日志」）。
   */
  async steerQueued(text: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.rpc!.command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
      if (!res.success) return { ok: false, error: res.error }
      const steering = res.data?.steering ?? []
      const followUp = res.data?.followUp ?? []

      // 只在 follow-up 队列里移除**一条**匹配项（可能有重复文案）
      let removedFromFollow = false
      const restFollow = followUp.filter((m) => {
        if (!removedFromFollow && m === text) {
          removedFromFollow = true
          return false
        }
        return true
      })
      // 若 follow-up 里没有，再从 steering 里移除一条
      let removedFromSteer = false
      const restSteer = removedFromFollow
        ? steering
        : steering.filter((m) => {
            if (!removedFromSteer && m === text) {
              removedFromSteer = true
              return false
            }
            return true
          })

      // 先重建其余排队（保持原有先后）
      for (const m of restSteer) await this.rpc!.command('steer', { message: m })
      for (const m of restFollow) await this.rpc!.command('follow_up', { message: m })
      // 再把目标提升为 steering
      const promoted = await this.rpc!.command('steer', { message: text })
      return promoted.success ? { ok: true } : { ok: false, error: promoted.error }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
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
        thinkingLive: false,
        toolCalls: s.tools.length ? s.tools : undefined,
        timestamp: Date.now()
      }
      this.messages.push(msg)
      for (const c of s.tools) this.registerCall(c, s.id)
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
    this.setAgentRunning(false)
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
    this.indexCalls(msg)
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
    /*
     * 这里要**主动清掉该工具的增量游标与待推标记**：
     * 下面推的是全量快照，若还留着一个待推增量，定时器到点后会再追加一次
     * —— 而那份增量是基于旧长度算的，结果就是输出里多一段重复的尾巴。
     */
    this.pushedOut.set(msgId, output.length)
    this.dirtyTools.delete(msgId)
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
    this.setAgentRunning(false)
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
    this.setAgentRunning(false)
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
    return this.cycleModelBy(1)
  }

  /**
   * 反向循环模型（桌面端 Ctrl+Shift+P，对齐 pi TUI 的“上一个模型”）。
   *
   * 为什么自己算而不用 pi 的命令：pi 0.85.1 的 RPC 只有 `cycle_model`
   * （固定向前），没有反向命令。这里复用 `get_available_models` +
   * `set_model` 手动走上一项，语义与界面显示的列表一致。
   */
  async cycleModelBack(): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.cycleModelBy(-1)
  }

  /** `dir = 1` 下一个，`dir = -1` 上一个 */
  private async cycleModelBy(dir: 1 | -1): Promise<{ ok: boolean; error?: string; to?: string }> {
    const models = await this.listModels()
    if (models.length < 2) return { ok: false, error: '只有一个可用模型' }

    const cur = this.state?.model
    const i = models.findIndex((m) => m.provider === cur?.provider && m.id === cur?.id)
    // 当前模型不在列表里（刚切过来 / 列表变了）→ 从第一个开始
    const next = models[i < 0 ? 0 : (i + dir + models.length) % models.length]

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

    const users = this.messages.filter(
      (m) => m.role === 'user' && (m.text.trim() || m.images?.length)
    )
    if (users.length === 0) return

    // 样本：第一句 + 最近一句。只给第一句的话，
    // 一个聊到第四轮的会话标题会一直停在第一句的话题上。
    // 纯图片消息没有文字：用占位符，否则 samples 为空 → 标题永远生成不出来
    // （用户报的「首条消息带图就没标题」）。
    const sampleOf = (m: UIMessage): string =>
      m.text.trim() || (m.images?.length ? `[图片 ×${m.images.length}]` : '')
    const samples = [sampleOf(users[0]), sampleOf(users[users.length - 1])].filter(Boolean)

    // 首条消息的图片一并交给归纳进程 —— 模型能看着图起标题。
    // 只带 1 张：标题生成是个短请求，塞太多图又慢又贵。
    const titleImages = users[0].images?.slice(0, 1).map((im) => ({
      data: im.data,
      mimeType: im.mimeType
    }))

    this.titleTried.add(st.sessionId)
    const sessionId = st.sessionId

    try {
      const res = await generateTitle({
        sessionId,
        samples,
        images: titleImages,
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
    this.flushTimer = null
    this.streaming = null
    this.bash = null
    this.dirty = false
    this.dirtyTools.clear()
    this.callIndex.clear()
    this.callOwner.clear()
    this.pushedOut.clear()
    await this.rpc?.close()
    this.rpc = null
    this.messages = []
  }
}

export type { BashRun, ForkPoint, SlashCommand }
