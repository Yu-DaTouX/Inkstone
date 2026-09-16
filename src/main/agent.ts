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
import { consumeQueuedItem } from './queue-items'
import { clearStaleRunning, EMPTY_COMPACTION_STATE, reduceCompaction, type CompactionState } from './compaction'
import { activeContextPolicy } from './context-policy'
import {
  contextBudget,
  contextPolicyStep,
  INITIAL_POLICY_STATE,
  type ContextPolicyState,
  type ContextTrigger
} from '../shared/context-policy'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { mergeCommandDescriptors } from './command-registry'
import { generateTitle, manualTitleOf } from './title'
import { readSessionMessages } from './session-reader'
import { todoSnapshotsFromEntries } from './todo-snapshots'
import { titleSampleImages, titleSamples } from '../shared/title-samples'
import { beginTreeSnapshot, endTreeSnapshot, isShellTool, isWriteTool, snapshotAfter, snapshotBefore, writePathOf } from './snapshots'
import {
  capabilitySnapshot,
  modelKeyOf,
  normalizeModelInfo,
  normalizeThinkingLevels,
  resolveThinkingLevels
} from '../shared/model-capabilities'
import type {
  BashRun,
  ContextBudget,
  ContextPolicy,
  ContextPolicyView,
  CustomEntry,
  ForkPoint,
  MainPush,
  ModelInfo,
  QueueItem,
  QueueMode,
  QueueState,
  SessionState,
  SessionStats,
  SessionTodo,
  SlashCommand,
  ResponseDetail,
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
  private responseDetailExtension?: string
  /** 界面语言扩展（每轮注入一句语言要求，见 resources/pi-extensions/language.js） */
  private languageExtension?: string
  /** 当前设置的回复档位；在 agent_start 时快照，不随回合中途改设置漂移。 */
  private getResponseDetail?: () => ResponseDetail
  private browserEnv?: NodeJS.ProcessEnv
  /** 模型/思考能力变更串行化，避免快速点击时旧响应覆盖新状态。 */
  private capabilityChangeTail: Promise<void> = Promise.resolve()

  /** 权威消息列表 */
  private messages: UIMessage[] = []
  /** switch_session / new_session 的 RPC 过渡期不向 UI 泄漏旧会话事件。 */
  private suppressPush = false
  /** 正在流式的那条助手消息 */
  private streaming: {
    id: string
    text: string
    thinking: string
    thinkingMs?: number
    thinkingStartedAt?: number
    /** 正在流式思考（thinking_start 置位、thinking_end 清掉） */
    thinkingLive?: boolean
    /** 整轮固定的回复详细程度；中途改设置不能影响同一轮。 */
    responseDetail: ResponseDetail
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
  private turnResponseDetail: ResponseDetail = 'unknown'
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
  /**
   * 压缩的可观测状态（N21-2）。
   *
   * 为什么与 `state` 分开存：`setStateFrom` 每次都用 pi 的 get_state **整份重建**
   * `this.state`（这条路上已经踩过 D11 —— 档位被每条推送清空），所以压缩记录
   * 必须活在这之外，否则一收到 state 推送就归零。
   */
  private compactionState: CompactionState = EMPTY_COMPACTION_STATE
  /**
   * 上下文策略状态（N21-3）：上膛标记 + 上次策略压缩的时间（冷却）。
   * 与 compactionState 一样活在 `state` 重建之外，否则每条 state 推送都会把它冲掉。
   */
  private policyState: ContextPolicyState = INITIAL_POLICY_STATE
  /**
   * 砚刚刚为哪条线发起了压缩。
   *
   * 为什么需要：pi 对砚发起的 `compact()` 一律报 `reason: 'manual'`，
   * 界面上会写成「手动」——用户明明没点那个按钮。发起方只有砚自己知道，
   * 所以在这里记一笔，等压缩事件到达时盖到那条记录上（见 setCompaction）。
   *
   * 为什么要带 `baseline`：`compaction_start` / `compaction_end` 的到达顺序、
   * 以及 `get_state` 的自愈都可能让“正在压缩”那条临时记录消失（实测：成功的
   * 那次压缩没有可用的开始记录，只有结束记录）。所以不能只靠开始事件盖章，
   * 而要能认出**哪条结束记录是本次调用产生的** —— 用“上一条记录的 endedAt”
   * 当基准就够了。
   */
  private policyOrigin: { stage: ContextTrigger; baseline: number | null } | null = null
  /** 正在走策略触发流程（防止两次 stats 刷新同时判定过线） */
  private policyTriggering = false
  private uiSeen = new Set<string>()
  /**
   * 正在等用户回答的扩展请求（N12）。
   *
   * 与上面的 uiSeen 不同：uiSeen 是「这个请求见过了」的去重集合，
   * 应答后仍然留在里面；这个集合只装**还没答复**的，
   * 用来给「后台会话正在等输入」这个状态提供依据。
   */
  private pendingUi = new Set<string>()

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
    /** 回复详细程度扩展（方案 3.1）：按档位注入系统提示 */
    responseDetailExtension?: string
    /**
     * 界面语言扩展：在 before_agent_start 里读 desktop.json，每轮注入
     * 一句「推理与回复用什么语言」。
     *
     * 为什么不做成 `--append-system-prompt`：那是**进程启动时**固定的，
     * 切语言就必须重建 pi 实例（会掐掉后台会话、界面还会短暂失去当前会话
     * 的历史）。扩展注入是每轮读设置，切语言下一轮生效。
     */
    languageExtension?: string
    /** 读取当前有效档位；每个 agent_start 只调用一次。 */
    getResponseDetail?: () => ResponseDetail
    browserEnv?: NodeJS.ProcessEnv
  }) {
    super()
    const emit = opts.push
    this.push = (msg) => {
      if (!this.suppressPush) emit(msg)
    }
    this.cwd = opts.cwd
    this.piBin = opts.piBin
    this.browserExtension = opts.browserExtension
    this.questionExtension = opts.questionExtension
    this.responseDetailExtension = opts.responseDetailExtension
    this.languageExtension = opts.languageExtension
    this.getResponseDetail = opts.getResponseDetail
    this.browserEnv = opts.browserEnv
  }

  get running(): boolean {
    return this.rpc?.running ?? false
  }

  private currentResponseDetail(): ResponseDetail {
    const value = this.getResponseDetail?.()
    return value === 'brief' || value === 'standard' || value === 'detailed' ? value : 'unknown'
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

  /**
   * pi 的 queue_update 只有文本数组。Yan 在主进程补稳定 id，渲染端的
   * 撤回/插队都只携带这个 id，重复文本也不会因为数组位置变化而误删。
   */
  private queueState: QueueState = { steering: [], followUp: [] }
  private queueSequence = 0
  /** clear_queue + 重排必须串行，避免两次撤回互相覆盖恢复结果。 */
  private queueOperations: Promise<void> = Promise.resolve()

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

    this.resetQueue()
    this.setConn('starting')

    const rpc = new PiRpc({
      cwd: this.cwd,
      piBin: this.piBin,
      args: [
        ...(this.browserExtension ? ['--extension', this.browserExtension] : []),
        // 内置提问扩展（模型可主动向用户提问；自主模式时改为自行决策）
        ...(this.questionExtension ? ['--extension', this.questionExtension] : []),
        // 回复详细程度（简洁 / 标准 / 详细）：standard 档不注入任何东西
        ...(this.responseDetailExtension ? ['--extension', this.responseDetailExtension] : []),
        // 界面语言 → 推理/回复语言：每轮读设置注入一句（不再用启动参数）
        ...(this.languageExtension ? ['--extension', this.languageExtension] : []),
        /*
         * 测试/CI 用固定模型（YAN_TEST_MODEL = "provider/modelId"）。
         * 由 scripts/test-live.mjs 统一注入为 commandcode 的免费模型，
         * 避免每次跑真实场景都需要选定/付费；个别场景（如发图）可在 CASES 里覆盖。
         */
        ...(process.env.YAN_TEST_MODEL ? ['--model', process.env.YAN_TEST_MODEL] : []),
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

    /*
     * 首次连接时主动问一次档位：pi 的 get_state 不提供它，而 store.reloadModels
     * 只会在渲染端某些时机跑；少了这一步，界面上档位会停在 unknown
     * （“上游未提供思考档位信息”）直到用户手动切一次模型。
     */
    void this.listThinkingLevels().catch(() => undefined)

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
    /*
     * 先要 `get_state`：下面读文件需要知道当前会话文件（也先把运行时身份
     * 对齐，再推消息快照）。
     */
    const state = await this.rpc!.command('get_state').catch(() => null)
    if (state?.success) this.setStateFrom(state.data as Record<string, unknown>)
    const sessionFile = this.state?.sessionFile

    /*
     * 历史来源：**磁盘上的完整历史优先**。
     *
     * pi 的 `get_messages` 只给「当前上下文」—— 压缩过的会话在界面上就只剩
     * 压缩后那一段（实测：磁盘 858 条 → 界面 86 条，首条用户消息也不在了）。
     * 界面上的「会话历史」应当与用户能看到的会话文件一致，所以这里直接用它；
     * `get_messages` 只在读不到文件时兜底（刚建、还没落盘的新会话）。
     * 这也是切换会话时 peek（同样走文件）与 sync 一致的原因 —— 不再先铺全量、
     * 再被权威快照压短（用户报的「切换会话历史丢失」）。
     */
    const fromFile = sessionFile ? await readSessionMessages(sessionFile).catch(() => null) : null
    if (fromFile?.messages.length) {
      this.messages = fromFile.messages
    } else {
      const msgs = await this.rpc!.command('get_messages').catch(() => null)
      const raw = (msgs?.data as { messages?: unknown[] } | undefined)?.messages
      this.messages = Array.isArray(raw) ? normalizeHistory(raw) : []
    }

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
    const stats = await this.rpc!.command('get_session_stats').catch(() => null)
    if (stats?.success) this.push({ ch: 'stats', payload: this.statsForCurrentModel(stats.data as SessionStats) })

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

  /**
   * 当前有效的上下文策略与工作集预算（N21-3，**唯一来源**）。
   *
   * 为什么把「界面用的数」与「做决定用的数」算在一处：它们必须是同一个数。
   * 这一块已经出过两次「界面数字 ≠ 实际生效值」的错（D21 项目级设置被忽略、
   * D22 用户级设置读错文件），不能再让渲染端自己再算一遍。
   *
   * 总开关就是那个已有的「自动压缩」开关（pi 的 `compaction.enabled`）：
   * 它关掉时砚也不自作主张地压 —— 用户关的就是“别自动动我的上下文”。
   * 注意 pi 自己那条自动压缩线仍然在（砚不写 pi 的设置文件），
   * 所以这个开关的语义仍然是“pi 要不要自动压缩”，只是多了一个更早的砚决策点。
   */
  private effectivePolicy(): { policy: ContextPolicy; budget: ContextBudget | null } {
    const base = activeContextPolicy()
    const policy: ContextPolicy =
      base.enabled && this.state?.autoCompactionEnabled !== false ? base : { ...base, enabled: false }
    return { policy, budget: contextBudget(this.state?.model?.contextWindow ?? 0, policy) }
  }

  /** 推给界面的策略视图（窗口未知或策略关时为 undefined —— 界面退回物理窗口视角） */
  private contextPolicyView(): ContextPolicyView | undefined {
    const { policy, budget } = this.effectivePolicy()
    if (!policy.enabled || !budget) return undefined
    return { enabled: true, kinds: policy.kinds, budget }
  }

  private setStateFrom(data: Record<string, unknown>): void {
    const model = normalizeModelInfo(data.model)
    /*
     * 压缩记录的自愈（见 clearStaleRunning）：pi 说「没在压缩」时，
     * 残留的 running 记录必须清掉 —— 否则 `compaction_end` 一旦没到，
     * 界面就永久显示“正在压缩”（与 D19 同一类 bug）。
     * 注意在构造 this.state **之前**做，否则这一帧推出去的还是旧记录。
     */
    this.compactionState = clearStaleRunning(this.compactionState, !!data.isCompacting)
    /*
     * 档位不能只看本条快照：pi 的 get_state 不含 availableThinkingLevels，
     * 权威结果由 listThinkingLevels() 写入（详见 resolveThinkingLevels 注释）。
     */
    const previous = this.state
    const levels = resolveThinkingLevels(
      data,
      previous
        ? {
            levels: previous.availableThinkingLevels,
            status: previous.thinkingLevelsStatus ?? 'unknown',
            modelKey: modelKeyOf(previous.model)
          }
        : undefined,
      modelKeyOf(model)
    )
    const availableThinkingLevels = levels.values
    this.state = {
      sessionId: String(data.sessionId ?? ''),
      sessionFile: data.sessionFile ? String(data.sessionFile) : undefined,
      sessionName: data.sessionName ? String(data.sessionName) : undefined,
      model: model ?? undefined,
      thinkingLevel: String(data.thinkingLevel ?? 'off'),
      availableThinkingLevels,
      thinkingLevelsStatus: levels.status,
      capabilities: capabilitySnapshot(model, availableThinkingLevels, levels.status),
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
      compaction: this.compactionState.running ?? undefined,
      lastCompaction: this.compactionState.last ?? undefined,
      messageCount: Number(data.messageCount ?? 0),
      pendingMessageCount: Number(data.pendingMessageCount ?? 0),
      cwd: this.cwd,
      autoCompactionEnabled:
        data.autoCompactionEnabled === undefined ? undefined : !!data.autoCompactionEnabled,
      steeringMode: normalizeQueueMode(data.steeringMode),
      followUpMode: normalizeQueueMode(data.followUpMode)
    }
    /*
     * 工作集视图要在 `this.state` 落定**之后**算：它依赖本帧刚到的
     * `autoCompactionEnabled` 与模型窗口。
     */
    const policyView = this.contextPolicyView()
    if (policyView) this.state = { ...this.state, contextPolicy: policyView }
    this.push({ ch: 'state', payload: this.state })
  }

  /**
   * 一次上下文策略判定（N21-3）。
   *
   * 触发时机只有一处：**回合结束**（`agent_settled` → `refreshStats({ allowPolicyTrigger: true })`）。
   * 两个理由：① 不在流式输出或工具执行的中途动上下文 —— 那会把正在写的回合从中间截断；
   * ② 也不能跟着“任何一次用量刷新”跑 —— 切到一个很大的旧会话也会刷新用量，
   * 那会变成“用户只是想看一眼，却被按头压了一次”（实测踩过，见 refreshStats 的注释）。
   *
   * 命中的两条线都是砚自己的：工作集上限（`compact`）与物理兜底（`emergency`，
   * 取 `min(90% 窗口, 窗口 − 输出预留)` —— 兜底不能吃掉留给回答的空间，见方案 §12.1）。
   * pi 原生那条 `窗口 − reserveTokens` 自动压缩**保持不动**，两者都失灵时由它兜底。
   */
  private async evaluateContextPolicy(tokens: number | null): Promise<void> {
    const { policy, budget } = this.effectivePolicy()
    const busy =
      !!this.state?.isStreaming || !!this.state?.isCompacting || !!this.state?.isAgentRunning
    const decided = contextPolicyStep({ state: this.policyState, tokens, budget, policy, busy })
    this.policyState = decided.state
    if (!decided.trigger || this.policyTriggering) return

    this.policyTriggering = true
    /* 基准＝调用之前已有的最后一条记录：用来认出“这次调用产生的那条” */
    this.policyOrigin = { stage: decided.trigger, baseline: this.compactionState.last?.endedAt ?? null }
    try {
      const res = await this.compact({ fromPolicy: decided.trigger })
      if (!res.ok) {
        /* 连请求都没发出去（RPC 挂了）：清掉来源标记，别把下一次压缩误标成策略发起 */
        this.policyOrigin = null
        console.error('[agent] 工作集压缩失败：', res.error)
      }
    } finally {
      this.policyTriggering = false
    }
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
            /*
             * 插话真的被消费了（D9）。
             *
             * pi 只在队列**变化**时推 `queue_update`；它把排队项变成一条真正的
             * user 消息时不一定再推一次，于是界面会一直挂着「排队中」。
             * 这里以**消息真的出现**为准：按原文从快照里摘掉一条。
             */
            this.consumeQueued(norm.text)
          }
        } else if (m?.role === 'assistant') {
          const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
          this.streaming = {
            id,
            text: '',
            thinking: '',
            responseDetail: this.turnResponseDetail,
            tools: [],
            startedAt: Date.now(),
            // 增量游标从 0 开始（渲染端拿到的 msg-add 里 text 也是空）
            pushedText: 0,
            pushedThinking: 0
          }
          this.push({
            ch: 'msg-add',
            payload: { id, role: 'assistant', text: '', responseDetail: this.turnResponseDetail, timestamp: Date.now() }
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
          responseDetail: s.responseDetail,
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
        /*
         * 写入类工具：**在文件被改之前**留一份执行前快照（方案 5.3）。
         * 同步读（限 2MB）：异步会有「工具已写完、before 才读到新内容」的竞态。
         */
        if (isWriteTool(call.name)) {
          const path = writePathOf(call.args)
          if (path) snapshotBefore(call.id, path)
        } else if (isShellTool(call.name)) {
          /*
           * shell / 第三方工具（L05）：参数里没有“要改哪个文件”，
           * 所以对整个工作目录拍一份前后快照，事后算目录级差异。
           * 同一目录并发时快照会标 concurrent —— 那种情况宁可显示“无法归属”。
           */
          beginTreeSnapshot(call.id, this.cwd, this.state?.sessionId)
        }
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
        /* 被取消不算失败（方案 4.1）：单独标记，界面不染红 */
        const cancelled = (evt as { cancelled?: boolean }).cancelled === true
        call.cancelled = cancelled || undefined
        call.status = evt.isError && !cancelled ? 'error' : 'ok'
        call.output = (result?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
        call.details = result?.details
        call.endedAt = Date.now()
        /* 写入类工具：执行后快照 → 真实的行级差异与增删行数 */
        if (isWriteTool(call.name)) {
          const diff = snapshotAfter(call.id)
          if (diff) {
            const base =
              call.details && typeof call.details === 'object' && !Array.isArray(call.details)
                ? (call.details as Record<string, unknown>)
                : {}
            call.details = { ...base, fileDiff: diff }
          }
        } else if (isShellTool(call.name)) {
          /* 目录级差异只有在**真的有变化**或**归属存疑**时才挂上去：
             一条 `ls` 不该在界面上多出一张“0 个改动”的卡片。 */
          const changes = endTreeSnapshot(call.id)
          if (changes && (changes.files.length > 0 || changes.unknown)) {
            const base =
              call.details && typeof call.details === 'object' && !Array.isArray(call.details)
                ? (call.details as Record<string, unknown>)
                : {}
            call.details = { ...base, workspaceChanges: changes }
          }
        }
        this.pushTool(call)

        // panel_todos 改了会话里的 custom entry → 任务清单要重读
        if (call.name === 'panel_todos') {
          void this.refreshTodos()
        }
        break
      }

      /* ---- 会话级 ---- */
      case 'agent_start':
        this.turnResponseDetail = this.currentResponseDetail()
        this.markStreaming(true)
        this.setAgentRunning(true)
        break

      case 'agent_settled':
        this.markStreaming(false)
        this.setAgentRunning(false)
        void this.refreshState()
        /* 回合结束是唯一允许按工作集动手的时机（这次刷新顺带做判定） */
        void this.refreshStats({ allowPolicyTrigger: true })
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
        this.publishQueue(
          Array.isArray(evt.steering) ? (evt.steering as string[]) : [],
          Array.isArray(evt.followUp) ? (evt.followUp as string[]) : []
        )
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
        this.setCompaction(this.compactionState, evt)
        /*
         * 顺序很重要：先落状态再 refreshState。
         * 只要 pi 的 `isCompacting` 为 true，`clearStaleRunning` 就不会把
         * 刚写进去的 running 记录当成残留清掉（自愈见 setStateFrom）。
         */
        this.markStreaming(true)
        void this.refreshState()
        break

      case 'compaction_end':
        this.setCompaction(this.compactionState, evt)
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
        /* pi 自己换了模型（非用户点击）时档位必须重新问一次 —— get_state 里没有它。 */
        void this.listThinkingLevels()
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

  /**
   * 压缩事件 → 状态 → 渲染端（N21-2）。
   *
   * 归一化（含“结束了但没有 status 字段”的兼容）全在 `main/compaction.ts`，
   * 这里只负责落盘与推送 —— 事件不是压缩类时 `reduceCompaction` 返回 null，
   * 这时**不要**推状态（state 推送很贵，而且没必要让界面重画）。
   */
  private setCompaction(cur: CompactionState, evt: Record<string, unknown>): void {
    let next = reduceCompaction(cur, evt)
    if (!next) return
    /*
     * 补上真正的发起方（N21-3）。两个判据都要，这是关键：
     *   · `running` 新出现 → 本次调用开的那一次，盖它；
     *   · `last` 是新对象且 `endedAt` 不同于基准 → 本次调用产生的结束记录，盖它。
     * 第二条不能省：实测成功的压缩只有结束记录（“正在压缩”已被
     * `isCompacting=false` 的自愈清掉），只盖 running 会丢章。
     * 也不能只看 last：开始事件到达时 last 还是**上一次**的结果，盖它就是撒谎。
     */
    const origin = this.policyOrigin
    if (origin) {
      const stamp = { triggeredBy: 'policy' as const, policyStage: origin.stage }
      const started = !!next.running && next.running !== cur.running
      const ended = !!next.last && next.last !== cur.last && next.last.endedAt !== origin.baseline
      if (started) next = { ...next, running: { ...next.running!, ...stamp } }
      else if (ended) next = { ...next, last: { ...next.last!, ...stamp } }
      /* 本次调用已经落定（成功或失败都算）：来源标记不再属于下一笔 */
      if (ended && !next.running) this.policyOrigin = null
    }
    this.compactionState = next
    if (!this.state) return
    this.state = {
      ...this.state,
      compaction: next.running ?? undefined,
      lastCompaction: next.last ?? undefined
    }
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
    if (id) this.pendingUi.add(id)
    /*
     * `sensitive` 是**请求方声明**的安全分类（方案第 6 节）：
     * 只有它为 true 时才走模态确认（焦点圈定），其余都走非模态问题面板。
     * 不从问题措辞里推断 —— 那既不可靠也容易被绕过。
     */
    this.push({
      ch: 'ui-request',
      payload: { id, method, sensitive: req.sensitive === true, ...req } as never
    })
  }

  /** 渲染端回答案（由 IPC 调） */
  respondUi(res: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    if (res.id) this.pendingUi.delete(res.id)
    this.rpc?.respondUi(res as Record<string, unknown>)
  }

  /* ------------------------------------------------------------- 队列身份 */

  /**
   * 把 pi 的字符串数组与上一次快照按“同文本、原顺序”匹配，尽量保留 id；
   * 新出现的文本才分配新 id。重复文本因此仍然有两个不同的可操作对象。
   */
  private queueItems(raw: string[], previous: QueueItem[]): QueueItem[] {
    const buckets = new Map<string, QueueItem[]>()
    for (const item of previous) {
      const bucket = buckets.get(item.text) ?? []
      bucket.push(item)
      buckets.set(item.text, bucket)
    }
    return raw.map((text) => {
      const bucket = buckets.get(text)
      const kept = bucket?.shift()
      if (kept) return kept
      this.queueSequence += 1
      return { id: `q-${this.queueSequence.toString(36)}`, text }
    })
  }

  /** 更新本地队列身份并推给渲染端。 */
  private publishQueue(steering: string[], followUp: string[]): QueueState {
    const next: QueueState = {
      steering: this.queueItems(steering, this.queueState.steering),
      followUp: this.queueItems(followUp, this.queueState.followUp)
    }
    return this.publishQueueItems(next)
  }

  private publishQueueItems(next: QueueState): QueueState {
    this.queueState = next
    this.push({ ch: 'queue', payload: next })
    return next
  }

  /**
   * 从队列快照里摘掉一条“已经被消费”的项（D9）。
   *
   * 先 steering 后 followUp：同一个回合里 steering 会先被插进当前对话，
   * followUp 要等回合结束。两边都可能出现相同文本（用户反复发同一句），
   * 所以只摘**第一条**匹配（FIFO），剩下的等后续消息再到。
   */
  private consumeQueued(text: string): void {
    /* 判定规则在 queue-items.ts（纯函数，有单测）；这里只管把结果推出去 */
    const next = consumeQueuedItem(this.queueState, text)
    if (next) this.publishQueueItems(next)
  }

  private resetQueue(emit = false): void {
    this.queueState = { steering: [], followUp: [] }
    if (emit) this.push({ ch: 'queue', payload: this.queueState })
  }

  private queueItemOf(id: string): { kind: 'steering' | 'followUp'; item: QueueItem } | undefined {
    if (!id) return undefined
    const steering = this.queueState.steering.find((item) => item.id === id)
    if (steering) return { kind: 'steering', item: steering }
    const followUp = this.queueState.followUp.find((item) => item.id === id)
    return followUp ? { kind: 'followUp', item: followUp } : undefined
  }

  /** 所有基于 clear_queue 的操作共享一个串行闸门。 */
  private queueRun<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queueOperations
    const current = previous.then(work, work)
    this.queueOperations = current.then(() => undefined, () => undefined)
    return current
  }

  private async refillQueue(steering: string[], followUp: string[]): Promise<void> {
    for (const text of steering) {
      const res = await this.rpc!.command('steer', { message: text })
      if (!res.success) throw new Error(res.error || '恢复插话队列失败')
    }
    for (const text of followUp) {
      const res = await this.rpc!.command('follow_up', { message: text })
      if (!res.success) throw new Error(res.error || '恢复排队队列失败')
    }
  }

  /**
   * 清空后重排失败时尽力恢复原始队列。调用方会把恢复失败明确带给用户，
   * 不把“命令发出去了”伪装成成功。
   */
  private async restoreQueue(raw: { steering: string[]; followUp: string[] }): Promise<string | undefined> {
    try {
      const cleared = await this.rpc!.command('clear_queue')
      if (!cleared.success) return cleared.error || '清空队列失败，无法恢复原顺序'
      await this.refillQueue(raw.steering, raw.followUp)
      this.publishQueue(raw.steering, raw.followUp)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
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
  async steerQueued(queueId: string): Promise<{ ok: boolean; error?: string }> {
    return this.queueRun(async () => {
      const target = this.queueItemOf(queueId)
      if (!target) return { ok: false, error: '这条排队消息已被接收或撤回，无法插队' }

      try {
        const res = await this.rpc!.command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
        if (!res.success) return { ok: false, error: res.error }
        const raw = { steering: res.data?.steering ?? [], followUp: res.data?.followUp ?? [] }
        const current = this.publishQueue(raw.steering, raw.followUp)
        const liveTarget = current[target.kind].find((item) => item.id === queueId)
        if (!liveTarget) {
          const recovery = await this.restoreQueue(raw)
          return {
            ok: false,
            error: recovery
              ? `消息已被接收；恢复队列失败：${recovery}`
              : '消息已被 pi 接收，无法再插队'
          }
        }

        const restSteer = current.steering.filter((item) => item.id !== queueId).map((item) => item.text)
        const restFollow = current.followUp.filter((item) => item.id !== queueId).map((item) => item.text)
        try {
          await this.refillQueue(restSteer, restFollow)
          const promoted = await this.rpc!.command('steer', { message: liveTarget.text })
          if (!promoted.success) throw new Error(promoted.error || '插队失败')
          this.publishQueueItems({
            steering: [...current.steering.filter((item) => item.id !== queueId), liveTarget],
            followUp: current.followUp.filter((item) => item.id !== queueId)
          })
          return { ok: true }
        } catch (error) {
          const recovery = await this.restoreQueue(raw)
          return {
            ok: false,
            error: recovery
              ? `插队失败，且恢复原队列失败：${recovery}`
              : `插队失败，已恢复原队列：${error instanceof Error ? error.message : String(error)}`
          }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  /**
   * 撤回一条尚未被 pi 接收的消息。撤回成功返回原文，渲染端把它交回草稿；
   * 目标在 clear_queue 的瞬间已经消失时先恢复其它条目，再明确报告不可撤回。
   */
  async removeQueued(queueId: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    return this.queueRun(async () => {
      const target = this.queueItemOf(queueId)
      if (!target) return { ok: false, error: '这条排队消息已被接收或撤回，无法撤回' }

      try {
        const res = await this.rpc!.command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
        if (!res.success) return { ok: false, error: res.error }
        const raw = { steering: res.data?.steering ?? [], followUp: res.data?.followUp ?? [] }
        const current = this.publishQueue(raw.steering, raw.followUp)
        const liveTarget = current[target.kind].find((item) => item.id === queueId)
        if (!liveTarget) {
          const recovery = await this.restoreQueue(raw)
          return {
            ok: false,
            error: recovery
              ? `消息已被接收；恢复队列失败：${recovery}`
              : '消息已被 pi 接收，无法撤回'
          }
        }

        const restSteer = current.steering.filter((item) => item.id !== queueId).map((item) => item.text)
        const restFollow = current.followUp.filter((item) => item.id !== queueId).map((item) => item.text)
        try {
          await this.refillQueue(restSteer, restFollow)
          this.publishQueueItems({
            steering: current.steering.filter((item) => item.id !== queueId),
            followUp: current.followUp.filter((item) => item.id !== queueId)
          })
          return { ok: true, text: liveTarget.text }
        } catch (error) {
          const recovery = await this.restoreQueue(raw)
          return {
            ok: false,
            error: recovery
              ? `撤回失败，且恢复原队列失败：${recovery}`
              : `撤回失败，已恢复原队列：${error instanceof Error ? error.message : String(error)}`
          }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
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
      /*
       * 不管 clear_queue 有没有带回文本，本地快照都得跟着清（D9）。
       *
       * 为什么：pi 只在队列变化时推 `queue_update`，而它把排队项拿去当普通
       * 消息消费时不一定推 —— 于是中止之后左栏/输入框上方还会挂着“排队中”，
       * 用户会以为自己那几句话还在排队。到底有没有被消费，`cleared` 是权威；
       * 快照只是展示，中止后应与 pi 对齐。
       */
      this.resetQueue(true)
    } catch {
      /* clear_queue 失败不阻碍中止；快照留给下一条 queue_update 自己对齐 */
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
    this.publishQueue([], [])
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
    /* 直执行 shell 同样算“变更归属”（L05）：它与模型调的 bash 走的都是
       同一颗 pi，改的是同一个工作目录 —— 没有理由只有模型跑的命令能审阅。 */
    beginTreeSnapshot(msgId, this.cwd, this.state?.sessionId)

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
     * 先取目录差异：`endTreeSnapshot` 顺带把这次快照注销掉，
     * 不管后面提前返回还是抛错，都不能把活跃快照留成泄漏。
     */
    const changes = endTreeSnapshot(msgId)
    const details: Record<string, unknown> = {}
    if (truncated) {
      details.truncated = truncated
      details.fullOutputPath = fullOutputPath
    }
    if (changes && (changes.files.length > 0 || changes.unknown)) details.workspaceChanges = changes
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
              details: Object.keys(details).length ? details : undefined,
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

  /**
   * 有**直执行** shell 在跑（L05 发现）。
   *
   * 为什么单拉一个方法：`getState()` 里的 isAgentRunning / isStreaming 都不
   * 包括直执行 bash（它不经过模型）。但这条命令正在改工作目录 ——
   * 复用/顶掉这个实例会出现两个问题：用户在新会话里发不出命令
   *（“已有一条命令在跑”），而且两个实例同 cwd 并行改文件正是 L03 要防的事。
   */
  hasRunningBash(): boolean {
    return this.bash !== null
  }

  /* ---------------------------------------------------------- 会话管理 */

  async newSession(): Promise<{ ok: boolean; error?: string }> {
    this.suppressPush = true
    try {
      const res = await this.rpc!.command('new_session')
      if (!res.success) return { ok: false, error: res.error }
      if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
        return { ok: false, error: '会话切换被扩展取消' }
      }
      this.uiSeen.clear()
      this.pendingUi.clear()
      this.setAgentRunning(false)
      this.resetQueue()
      /*
       * 压缩记录是**本次运行**的事实，换会话就作废：留着会把它挂到另一个会话
       * 头上（A 的「阈值触发 · 已完成」出现在 B 的详情里）。
       */
      this.compactionState = EMPTY_COMPACTION_STATE
      /* 上膛/冷却同样是本次运行的状态：换会话后按新会话的用量重新判定 */
      this.policyState = INITIAL_POLICY_STATE
      this.policyOrigin = null
      this.suppressPush = false
      await this.hydrate()
      return { ok: true }
    } finally {
      this.suppressPush = false
    }
  }

  async switchSession(path: string): Promise<{ ok: boolean; error?: string }> {
    this.suppressPush = true
    try {
      const res = await this.rpc!.command('switch_session', { sessionPath: path })
      if (!res.success) return { ok: false, error: res.error }
      if ((res.data as { cancelled?: boolean } | undefined)?.cancelled) {
        return { ok: false, error: '会话切换被扩展取消' }
      }
      this.uiSeen.clear()
      this.pendingUi.clear()
      this.setAgentRunning(false)
      this.resetQueue()
      /* 同上：压缩记录不跨会话 */
      this.compactionState = EMPTY_COMPACTION_STATE
      this.policyState = INITIAL_POLICY_STATE
      this.policyOrigin = null
      this.suppressPush = false
      await this.hydrate()
      return { ok: true }
    } finally {
      this.suppressPush = false
    }
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

  /** 只重生成标题，不切换会话、不发送一条可见对话消息。 */
  async regenerateTitle(): Promise<{ ok: boolean; title?: string; error?: string }> {
    const sessionId = this.state?.sessionId
    if (!sessionId) return { ok: false, error: '当前还没有可重生成标题的会话' }
    if (this.titleTried.has(sessionId)) return { ok: false, error: '标题正在生成，请稍候' }
    /*
     * **同步**占位，不能等到 maybeGenerateTitle 里再加：下面查手动名是异步的，
     * 两个并发调用会在那个 await 窗口里**同时**通过上面的 has 检查，各自跑一次
     * 归纳请求。实测第二次通常拿到空结果 → 用户看到「标题生成失败，已保留原标题」，
     * 而第一次的候选其实已经出来了（N11 探针第 3 节就是守这个）。
     * 这里占位、finally 释放；maybeGenerateTitle 用 lockHeld 跳过它自己的加锁。
     */
    this.titleTried.add(sessionId)
    try {
      const manual = await manualTitleOf(sessionId)
      const title = await this.maybeGenerateTitle({ force: true, candidate: !!manual, lockHeld: true })
      return title ? { ok: true, title } : { ok: false, error: '标题生成失败，已保留原标题' }
    } finally {
      this.titleTried.delete(sessionId)
    }
  }

  async fork(entryId: string): Promise<{ ok: boolean; error?: string; text?: string }> {
    const res = await this.rpc!.command<{ text?: string; cancelled?: boolean }>('fork', { entryId })
    if (!res.success) return { ok: false, error: res.error }
    if (res.data?.cancelled) return { ok: false, error: '分叉被扩展取消' }
    this.uiSeen.clear()
    this.pendingUi.clear()
    await this.hydrate()
    return { ok: true, text: res.data?.text }
  }

  async clone(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command<{ cancelled?: boolean }>('clone')
    if (!res.success) return { ok: false, error: res.error }
    if (res.data?.cancelled) return { ok: false, error: '复制被扩展取消' }
    this.uiSeen.clear()
    this.pendingUi.clear()
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

  async compact(opts: { fromPolicy?: ContextTrigger } = {}): Promise<{ ok: boolean; error?: string }> {
    /*
     * 用户手动压缩要把来源标记清掉 —— 否则上一次策略触发留下的标记
     * 会把他自己点的那次标成「工作集」。
     */
    if (!opts.fromPolicy) this.policyOrigin = null
    const res = await this.rpc!.command('compact')
    return res.success ? { ok: true } : { ok: false, error: res.error }
  }

  /* ---------------------------------------------------------- 模型 / 开关 */

  private enqueueCapabilityChange<T>(work: () => Promise<T>): Promise<T> {
    const next = this.capabilityChangeTail.then(work, work)
    this.capabilityChangeTail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async applyModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.rpc!.command('set_model', { provider, modelId })
    if (!res.success) return { ok: false, error: res.error }
    await this.refreshState()
    /* 模型可能没有任何思考档位；空数组也是权威结果，不能保留旧值。 */
    await this.listThinkingLevels()
    /* 新模型的上下文窗口与 token 统计必须一起刷新。 */
    await this.refreshStats()
    return { ok: true }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.rpc!.command<{ models?: ModelInfo[] }>('get_available_models')
    if (!res.success) return []
    return (res.data?.models ?? [])
      .map((model) => normalizeModelInfo(model))
      .filter((model): model is ModelInfo => model !== undefined)
  }

  async setModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueCapabilityChange(() => this.applyModel(provider, modelId))
  }

  async setThinking(level: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueCapabilityChange(async () => {
      const res = await this.rpc!.command('set_thinking_level', { level })
      if (res.success) await this.refreshState()
      return res.success ? { ok: true } : { ok: false, error: res.error }
    })
  }

  async listThinkingLevels(): Promise<string[]> {
    const res = await this.rpc!.command<{ levels?: string[] }>('get_available_thinking_levels')
    const normalized = normalizeThinkingLevels(res.data?.levels, res.success)
    const levels = normalized.values
    if (this.state) {
      this.state = {
        ...this.state,
        availableThinkingLevels: levels,
        thinkingLevelsStatus: normalized.status,
        capabilities: capabilitySnapshot(this.state.model, levels, normalized.status)
      }
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
    return this.enqueueCapabilityChange(() => this.cycleModelNow(dir))
  }

  private async cycleModelNow(dir: 1 | -1): Promise<{ ok: boolean; error?: string; to?: string }> {
    const models = await this.listModels()
    if (models.length < 2) return { ok: false, error: '只有一个可用模型' }

    const cur = this.state?.model
    const i = models.findIndex((m) => m.provider === cur?.provider && m.id === cur?.id)
    // 当前模型不在列表里（刚切过来 / 列表变了）→ 从第一个开始
    const next = models[i < 0 ? 0 : (i + dir + models.length) % models.length]

    const changed = await this.applyModel(next.provider, next.id)
    return changed.ok ? { ok: true, to: next.name } : changed
  }

  /** 循环切下一档思考强度（TUI 的 Shift+Tab）。同样按界面所示档位走。 */
  async cycleThinking(): Promise<{ ok: boolean; error?: string; to?: string }> {
    return this.enqueueCapabilityChange(async () => {
      const levels = await this.listThinkingLevels()
      if (levels.length < 2) return { ok: false, error: '当前模型不支持思考' }

      const cur = this.state?.thinkingLevel ?? 'off'
      const i = levels.indexOf(cur)
      const next = levels[i < 0 ? 0 : (i + 1) % levels.length]

      const res = await this.rpc!.command('set_thinking_level', { level: next })
      if (!res.success) return { ok: false, error: res.error }

      await this.refreshState()
      return { ok: true, to: next }
    })
  }

  /** 最后一条助手消息的纯文本（复制用） */
  async lastAssistantText(): Promise<string | null> {
    const res = await this.rpc!.command<{ text?: string | null }>('get_last_assistant_text')
    if (!res.success) return null
    return res.data?.text ?? null
  }

  async listCommands(): Promise<SlashCommand[]> {
    if (!this.rpc) return mergeCommandDescriptors([])
    try {
      const res = await this.rpc.command<{ commands?: unknown[] }>('get_commands')
      return mergeCommandDescriptors(res.success ? res.data?.commands : [])
    } catch {
      /* pi 退出或尚未握手时，Yan 本地命令仍应可发现。 */
      return mergeCommandDescriptors([])
    }
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

  async refreshStats(opts: { allowPolicyTrigger?: boolean } = {}): Promise<SessionStats | null> {
    try {
      const res = await this.rpc?.command<SessionStats>('get_session_stats')
      if (res?.success && res.data) {
        const stats = this.statsForCurrentModel(res.data)
        this.push({ ch: 'stats', payload: stats })
        /*
         * 工作集判定**只允许在回合结束那条路上跑**（见 evaluateContextPolicy）。
         *
         * 为什么不能用“每次刷新用量”当触发点：切到（或只是读一下）一个很大的旧会话
         * 也会刷新用量 —— 实测那个会话已经 276k tokens（超过 262k 窗口），
         * 于是切过去的瞬间就发起压缩、实例变“忙”，紧接着「新对话」被拒
         * （同一 cwd 已有运行中的会话）。用户只是想看一眼那个会话，不该被动刀。
         */
        if (opts.allowPolicyTrigger) {
          const tokens = stats.contextUsage?.tokens
          void this.evaluateContextPolicy(typeof tokens === 'number' ? tokens : null)
        }
        return stats
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
  private async maybeGenerateTitle(
    opts: { force?: boolean; candidate?: boolean; lockHeld?: boolean } = {}
  ): Promise<string | null> {
    const st = this.state
    if (!st) return null
    /* lockHeld：调用方（regenerateTitle）已经在 await 之前占好位，别再判一次 */
    if (!opts.lockHeld && this.titleTried.has(st.sessionId)) return null

    const users = this.messages.filter(
      (m) => m.role === 'user' && (m.text.trim() || m.images?.length)
    )
    if (users.length === 0) return null

    /*
     * 样本 = 第一句 + 最近一句（纯逻辑在 shared/title-samples.ts，
     * 与「从 JSONL 里读」的那条路径共用同一套规则）。
     * 纯图片消息用占位符，否则 samples 为空 → 标题永远生成不出来
     *（用户报的「首条消息带图就没标题」）。
     */
    const samples = titleSamples(users)
    /* 首条消息的图片一并交给归纳进程 —— 模型能看着图起标题（最多一张：短请求别塞太多图） */
    const titleImages = titleSampleImages(users)

    if (!opts.lockHeld) this.titleTried.add(st.sessionId)
    const sessionId = st.sessionId

    try {
      const res = await generateTitle({
        sessionId,
        samples,
        images: titleImages,
        cwd: this.cwd,
        piBin: this.piBin,
        force: opts.force,
        allowManual: opts.candidate,
        persist: !opts.candidate
      })
      if (!res?.title) return null

      if (opts.candidate) return res.title

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
      return res.title
    } catch (e) {
      // 标题失败不该影响任何事
      console.error('[agent] 标题生成失败：', e)
      return null
    } finally {
      if (!opts.lockHeld) this.titleTried.delete(sessionId)
    }
  }

  getState(): SessionState | null {
    return this.state
  }

  /**
   * 给 token 统计加上模型身份。
   *
   * pi 的旧版本只返回数字，不返回“这组数字属于哪个模型”。在模型切换
   * 或快速切会话时，renderer 不能安全地把旧 contextWindow 当成新能力；
   * 主进程在拿到当前 state 后补上身份，未知 token 则保持 null。
   */
  private statsForCurrentModel(stats: SessionStats): SessionStats {
    const modelKey = modelKeyOf(this.state?.model)
    if (!stats.contextUsage) return stats
    return {
      ...stats,
      contextUsage: {
        ...stats.contextUsage,
        ...(modelKey ? { modelKey } : {}),
        availability: typeof stats.contextUsage.tokens === 'number' ? 'known' : 'unknown',
        estimated: false
      }
    }
  }

  /** 还在等用户回答的请求数（N12：后台会话的状态槽用它） */
  getPendingUiCount(): number {
    return this.pendingUi.size
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
    this.pendingUi.clear()
    await this.rpc?.close()
    this.rpc = null
    this.messages = []
    this.resetQueue()
  }
}

export type { BashRun, ForkPoint, SlashCommand }
