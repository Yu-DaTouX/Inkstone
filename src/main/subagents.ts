/**
 * 每个子任务使用独立 pi RPC 进程，复用事件规范化与有界转录。
 * 默认当前文件夹；只读工具和 Git worktree 均显式选择。
 * 子进程只有自己的危险审批通道，不继承父会话的宿主能力令牌。
 * 并发、超时、取消与用量按子运行记录，结果通过父会话身份回传。
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { SubagentHistory } from './subagent-history'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import type { SubagentEndReason, SubagentRun, UIMessage } from '../shared/ipc'
import { normalizeMessage, toUsage, type PiMessage } from './normalize'
import { accumulateUsage, ingestUsageSnapshot, normalizeSubagentContextUsage, type UsageSnapshots } from '../shared/subagent-usage'
import {
  briefPrompt,
  parseSubagentBrief,
  summarizeSubagentRun,
  type SubagentBrief
} from '../shared/subagent-brief'
import { PiRpc, resolvePi } from './protocol'
import { CapabilityServer } from './capability-server'
import { nativePiToolsSupported } from '../shared/agent-context'
import { modelErrorNotice } from '../shared/model-errors'
import { redactDiagnosticText } from '../shared/handoff-diagnostics'
import { subagentModelError, subagentPiArgs } from '../shared/subagent-pi-launch'
import { confirmRegisteredModel } from './subagents/registered-model'
import {
  applyPatch,
  cleanupWorkspace,
  collectDiff,
  prepareWorkspace,
  type PreparedWorkspace
} from './subagent-isolation'

const MAX_CONCURRENT = 10
/** 停滞或显式总期限到限后，先请求收尾，宽限内未结束才停止。 */
const STALL_TIMEOUT_MS = 10 * 60 * 1000
const GRACE_MS = 75 * 1000
/** 有工具调用在执行时（如整轮测试）静默是正常的，停滞期限放宽到这个倍数，仍保留对卡死命令的兜底。 */
const TOOL_RUNNING_STALL_FACTOR = 6
const PROGRESS_EVENTS = new Set(['agent_start', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'auto_compaction_start', 'auto_compaction_end',
  /* 重试等待也算「有进展」：否则原生退避期间会被停滞计时器当卡死。 */
  'agent_end', 'auto_retry_start', 'auto_retry_end'])

/**
 * 停滞超时、可选总期限与收尾宽限的实际取值。
 *
 * `YAN_SUBAGENT_TIMEOUT_MS` / `YAN_SUBAGENT_IDLE_MS` / `YAN_SUBAGENT_GRACE_MS` 只为测试能真跑
 * 超时分支，避免回归测试等待完整任务时限。
 */
function envMs(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}
function limitsFor(brief: SubagentBrief): { totalMs?: number; idleMs: number; graceMs: number } {
  const total = envMs('YAN_SUBAGENT_TIMEOUT_MS') ?? (brief.timeoutMinutes ? brief.timeoutMinutes * 60_000 : undefined)
  return { totalMs: total, idleMs: envMs('YAN_SUBAGENT_IDLE_MS') ?? STALL_TIMEOUT_MS, graceMs: envMs('YAN_SUBAGENT_GRACE_MS') ?? GRACE_MS }
}

/** 时长的可读写法：报**实际上限**，测试把它压到几百毫秒时不能还写「10 分钟」 */
function spanText(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`
  if (ms >= 1_000) return `${Math.round(ms / 1000)} 秒`
  return `${ms} 毫秒`
}
const totalTimeoutText = (ms: number): string => `运行超时（超过 ${spanText(ms)}）`
const stallTimeoutText = (ms: number): string => `停滞超时（超过 ${spanText(ms)} 未收到模型输出或工具事件）`

/** 到点后发给子代理的收尾指令 */
function wrapUpMessage(text: string): string {
  return `【宿主提示】${text}。不要再调用任何工具，立刻用已有的资料交出结论：先说已确认的结论，再说明哪些部分没来得及核实。`
}
/** 转录最多保留多少条 */
const MAX_TRANSCRIPT = 200

/**
 * 退出诊断的有界上限：stderr 只留最后若干行、单行截断。
 * 子进程日志可能很长，也可能带凭证形状，不能整份塞进运行快照。
 */
const MAX_STDERR_LINES = 20
const MAX_STDERR_LINE_CHARS = 400

/**
 * 本地统一脱敏：在共享形状清洗之前，先处理诊断文本里常见的**有标签**凭证形状。
 *
 * 覆盖 stderr 与启动错误里实际出现过的几类：
 *   · URL userinfo（`https://user:pass@host`）与查询参数密钥；
 *   · JSON / JS 对象字段（`{"api_key":"…"}`、`{'token': '…'}`、`apiKey: '…'`）；
 *   · HTTP 头与无引号赋值（`X-API-Key: …`、`Authorization=…`）；
 *   · `Basic` / `Bearer` 后的凭据串。
 *
 * 这是本模块自己的诊断边界，不改共享 handoff 模块的规则。它只能识别这些
 * 有标签的形状，不能保证识别任意无标签随机字符串。
 */
function redactCredentialShapes(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1[redacted]@')
    .replace(
      /([?&])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|token|key|secret|password|passwd|credential|authorization|auth)=[^&\s"']+/gi,
      '$1[redacted]'
    )
    .replace(
      /*
       * 先匹配闭合引号；再兜底「引号没闭合」的截断/尾行文本，保守脱敏到行尾，
       * 免得 flush 出去的半截 credential 原样落进诊断。
       */
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|auth|token|secret|password|passwd|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*$|'(?:\\.|[^'\\])*$)/gi,
      '$1[redacted]'
    )
    .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '[redacted]')
    .replace(/\b(authorization\s*[:=]\s*)[^\s,;"']+/gi, '$1[redacted]')
    .replace(
      /(\b(?:x-api-key|api[-_]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential)\b\s*[:=]\s*)[^\s,;"'&?]+/gi,
      '$1[redacted]'
    )
}

/** 一段诊断文本 → 按本地规则脱敏并截断的短文本；空文本返回 undefined。 */
export function redactLocalDiagnostic(text: string, max = MAX_STDERR_LINE_CHARS): string | undefined {
  return redactDiagnosticText(redactCredentialShapes(text), max) ?? undefined
}

/**
 * stderr 一行 → 可放进运行诊断的短文本（已脱敏）。
 *
 * 先处理 URL、JSON 字段、HTTP 头与 Basic/Bearer 这些本地形状，
 * 再走共享的凭证清洗与截断；空白行返回 undefined，调用方据此不占一行。
 */
export function sanitizeStderrLine(line: string): string | undefined {
  return redactLocalDiagnostic(line, MAX_STDERR_LINE_CHARS)
}

/** 把退出事实与脱敏后的 stderr 尾部拼成一句给用户看的原因（有界）。 */
export function describeProcessExit(
  info: { code?: number | null; signal?: string | null; spawnError?: string },
  stderrTail: readonly string[]
): string {
  const facts: string[] = []
  if (info.spawnError) {
    facts.push(`无法启动 pi：${redactLocalDiagnostic(info.spawnError, 300) ?? info.spawnError}`)
  } else {
    const bits: string[] = []
    if (info.code !== undefined) bits.push(`code=${info.code ?? 'null'}`)
    if (info.signal !== undefined) bits.push(`signal=${info.signal ?? 'null'}`)
    if (bits.length) facts.push(`pi 子进程提前退出（${bits.join('，')}）`)
  }
  const tail = stderrTail.length ? `；stderr：${stderrTail.join(' | ')}` : ''
  return `${facts.join('；') || 'pi 子进程提前退出'}${tail}`
}
/** 只合并流式消息快照；生命周期、工具与最终消息仍即时推送。 */
const STREAM_PUSH_MS = 33
/**
 * 子代理真正用到的 pi 客户端能力。
 *
 * 抽成接口是为了让单测注入假实现：并发槽位、退出清理这些策略的验证
 * 不该依赖真的 spawn 一个 pi 进程（慢、要凭证、还会花额度）。
 */
export interface SubagentRpc {
  readonly running: boolean
  on(event: string, listener: (...args: never[]) => void): unknown
  spawn(): void
  command(
    type: string,
    payload?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<{ success: boolean; error?: string; data?: unknown }>
  close(): Promise<void>
}

interface Run extends SubagentRun {
  rpc: SubagentRpc
  /** 当前排定的看门计时器（到点检查空闲 / 总上限，或收尾宽限） */
  timer: NodeJS.Timeout
  /** 每个运行最多挂一个流式推送，避免逐 token 序列化整份转录。 */
  pushTimer?: NodeJS.Timeout
  /** 最近一次收到 pi 进展事件的时刻。 */
  lastProgressAt: number
  /** 已开始、尚未结束的工具调用 id；只统计带 toolCallId 的事件。 */
  runningTools: Set<string>
  totalMs?: number
  idleMs: number
  graceMs: number
  /** pi 原生 `agent_settled` 到达后才为 true；`agent_end` 不再终结这一轮 */
  settled: boolean
  /** 已观察到的原生自动重试次数（事件字段不可靠时保持 undefined，不编默认值） */
  retryAttempt?: number
  /** 已观察到的原生重试上限；只在 pi 给出时记录 */
  retryMaxAttempts?: number
  workspace: PreparedWorkspace
  finalizing?: Promise<void>
  /** 结束事件的转录收尾与进程关闭；退出时必须等它完成再清工作区。 */
  settling?: Promise<void>
  /** worktree 已经归档或确认无需保留（退出清理据此避免重复 git 操作） */
  worktreeDone?: boolean
  /** 已经回调过 onFinished（每个运行只通知一次） */
  notified?: boolean
  /**
   * 转录消息的序号，只在**真的落一条新消息**时 +1。
   *
   * 不能再用 `transcript.length`：toolResult 是回填（不 push），
   * 用它做序号会错位，同一条流式回复就会被拆成多条、最终文本也会被盖掉。
   */
  msgSeq: number
  /** 正在流式的那条消息（message_start 打开、message_end 关闭） */
  streamingId?: string
  /**
   * 这一轮最后一个 `stopReason`（pi 把「模型返回错误」只放在这里）。
   * 子代理以前不看它，于是模型失败会被 settled 当成「已完成」（实测 2026-09-19）。
   */
  stopReason?: string
  /** H-10b：按消息 id 保存最后一份 usage 快照，重放/流式增量不会重复相加 */
  usageSnapshots: UsageSnapshots
  /** 原生快照请求按事件更新；迟到的旧请求不能覆盖新快照。 */
  contextRevision?: number
  contextRefresh?: Promise<void>
  /**
   * 派活时写清的输入（T15-1）。
   *
   * 存在 run 上而不是只拼进 prompt，是因为「结果对不对」要拿它来判断：
   * 主 agent 汇总时得知道当初要的交付物是什么。
   */
  brief: SubagentBrief
  /** 有界保存、已脱敏的 stderr 尾部；进程早退时用它还原真实原因 */
  stderrTail: string[]
  /** 进程退出事实（退出码 / 信号 / 启动失败）；只在第一次收口时写入 */
  exitInfo?: { code: number | null; signal: string | null; spawnError?: string }
}

export interface SubagentApprovalOrigin { sessionId?: string; runId?: string; subagentId?: string }

export interface SubagentOptions {
  /** 父会话当前工作目录；默认在此执行，worktree 模式才建立独立目录。 */
  cwd: string
  piBin?: string
  parentSessionId?: string
  parentRunId?: string
  parentMessageId?: string
  projectId?: string
  /** 退出 / 重启时的可恢复补丁目录。 */
  archiveDir?: string
  confirmDanger?(params: Record<string, unknown>, cwd: string, origin?: SubagentApprovalOrigin): Promise<boolean>
  resolveModelApi?(label: string, origin: { sessionId?: string; runId?: string }): Promise<string | undefined>
  /** 传给子进程的扩展（默认不传：子代理不需要浏览器/提问扩展） */
  extensions?: string[]
  /** 追加系统提示（例如「你是子代理，目标明确、少寒暄」） */
  appendSystemPrompt?: string
  /** 运行状态变化时回调（主进程转成 push） */
  onChange: (run: SubagentRun) => void
  /**
   * 流式增量：`run` 的 `transcript` **只含自 `transcriptFrom` 起的消息**，其余字段与 `onChange` 同形。
   * 渲染端按 `prev.transcript.slice(0, transcriptFrom)` 拼接。不传时退化为整条推送（`onChange`）。
   */
  onPatch?: (payload: { id: string; run: SubagentRun; transcriptFrom: number }) => void
  onRemove?: (id: string) => void
  /** 一次运行收口（差异与审阅状态已定）后回调一次；用来通知父会话 */
  onFinished?: (run: SubagentRun) => void
  /**
   * 只读原始事件旁路（例如把只读评审子运行按 runId 投影成 R 运行）。
   * 不改变事件处理、投影或控制；抛错也不会打断子代理的事件流。
   */
  onEvent?: (runId: string, evt: Record<string, unknown>) => void
  /** 造 pi 客户端（默认真的 PiRpc；单测注入假实现） */
  createRpc?: (opts: { cwd: string; piBin?: string; args: string[] }) => SubagentRpc
  /** 按所选方式准备工作目录；单测可注入准备过程。 */
  prepare?: (rootCwd: string, id: string, isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd') => Promise<PreparedWorkspace>
}

export class SubagentController {
  private runs = new Map<string, Run>()
  /**
   * 上一次推给渲染端的转录「形状」（长度 + 首尾消息 id）。
   * 只用来判断下一次能不能只发增量：形状对不上（被 200 条上限截断、换了一份转录）就退回整条推送。
   */
  private pushedTranscript = new Map<string, { length: number; firstId: string; lastId: string }>()
  /**
   * 正在准备隔离工作区、还没有进入 `runs` 的启动请求数。
   * 它们同样是"占用中"的槽位，见 `runningCount`。
   */
  private preparing = 0
  private opts: SubagentOptions
  private history: SubagentHistory

  constructor(opts: SubagentOptions) {
    this.opts = opts
    this.history = new SubagentHistory(opts.archiveDir ?? join(YAN_DIR, 'subagents'))
  }

  /** 只恢复纯历史，不创建 RPC、占并发槽或通知父会话。 */
  async loadHistory(): Promise<void> {
    await this.history.load()
  }

  /**
   * 子代理属于启动它的父会话。切换查看对象不会改已有 run 的归属，
   * 但下一次 `/subagent` 应使用新的当前会话 / cwd。
   */
  setContext(context: { cwd: string; parentSessionId?: string; parentRunId?: string; parentMessageId?: string; projectId?: string }): void {
    this.opts = { ...this.opts, ...context }
  }

  /** 对外只暴露纯数据（不能把 PiRpc 实例推给渲染端） */
  private snapshot(run: Run): SubagentRun {
    return {
      id: run.id,
      task: run.task,
      cwd: run.cwd,
      parentSessionId: run.parentSessionId,
      parentRunId: run.parentRunId,
      parentMessageId: run.parentMessageId,
      projectId: run.projectId,
      isolation: run.isolation,
      resultPath: run.resultPath,
      model: run.model,
      thinkingLevel: run.thinkingLevel,
      contextUsage: run.contextUsage,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      endReason: run.endReason,
      toolCalls: run.toolCalls,
      wrapUp: run.wrapUp,
      latestActivity: run.latestActivity,
      progressWarning: run.progressWarning,
      transcript: run.transcript,
      diff: run.diff,
      review: run.review,
      error: run.error,
      usage: run.usage,
      brief: run.brief,
      /*
       * 汇总每次都重算：它与转录必须同时前进（转录是有界的，开销可忽）。
       * `at` 用结束时刻而不是当前时间，免得每次推送的 result 都变。
       */
      result: summarizeSubagentRun(
        {
          transcript: run.transcript,
          diffPaths: run.diff?.paths,
          resultPath: run.resultPath,
          error: run.error,
          status: run.status
        },
        run.endedAt ?? run.startedAt
      )
    }
  }

  private emit(run: Run): void {
    clearTimeout(run.pushTimer)
    run.pushTimer = undefined
    this.opts.onChange(this.snapshot(run))
    this.rememberPushedTranscript(run)
  }

  /** 记下这一次推送的转录形状（见 `pushedTranscript`） */
  private rememberPushedTranscript(run: Run): void {
    const transcript = run.transcript
    if (!transcript.length) {
      this.pushedTranscript.delete(run.id)
      return
    }
    this.pushedTranscript.set(run.id, {
      length: transcript.length,
      firstId: transcript[0].id,
      lastId: transcript[transcript.length - 1].id
    })
  }

  /**
   * 流式期间的推送：上一次那一段还是这一次的前缀时只发增量。
   *
   * 为什么需要：转录最多 200 条，而这条路径约 30 次/秒；每次整条发出去，
   * 等于把整份转录（含工具输出）每秒做几十次结构化克隆过 IPC。
   * 形状对不上就退回 `emit`（整条），正确性优先。
   */
  private emitDelta(run: Run): void {
    const previous = this.pushedTranscript.get(run.id)
    const transcript = run.transcript
    const sameBase =
      previous !== undefined &&
      previous.length > 0 &&
      previous.length <= transcript.length &&
      transcript[0]?.id === previous.firstId &&
      transcript[previous.length - 1]?.id === previous.lastId
    if (!sameBase || !this.opts.onPatch) {
      this.emit(run)
      return
    }
    clearTimeout(run.pushTimer)
    run.pushTimer = undefined
    /* 从「上一次的最后一条」开始：那一条可能还在流式更新，要带上重发 */
    const transcriptFrom = previous.length - 1
    this.rememberPushedTranscript(run)
    this.opts.onPatch({ id: run.id, run: { ...this.snapshot(run), transcript: transcript.slice(transcriptFrom) }, transcriptFrom })
  }

  private emitStream(run: Run): void {
    if (run.pushTimer) return
    run.pushTimer = setTimeout(() => {
      run.pushTimer = undefined
      // 清除记录后不能由迟到的计时器把它重新推回界面。
      if (this.runs.get(run.id) === run) this.emitDelta(run)
    }, STREAM_PUSH_MS)
  }

  list(): SubagentRun[] {
    const historical = this.history.list().filter(({ run }) => !this.runs.has(run.id)).map(({ run }) => run)
    return [...historical, ...[...this.runs.values()].map((r) => this.snapshot(r))].sort((a, b) => a.startedAt - b.startedAt)
  }

  get(id: string): SubagentRun | undefined {
    const run = this.runs.get(id)
    return run ? this.snapshot(run) : this.history.get(id)?.run
  }

  /** 保守保护父会话；不复制转录，结束/清除与通知之间也不会提前回收父进程。 */
  hasParentRun(sessionId: string | undefined, runId: string): boolean {
    const matches = (run: { parentSessionId?: string; parentRunId?: string }): boolean =>
      (!!sessionId && run.parentSessionId === sessionId) || run.parentRunId === runId
    return [...this.runs.values()].some(matches) || this.history.list().some(({ run }) => matches(run))
  }

  get runningCount(): number {
    const live = [...this.runs.values()].filter((r) => r.status === 'running' || r.status === 'starting').length
    return live + this.preparing
  }

  /** 跑清掉**已结束**的记录（运行中的不动） */
  async clearFinished(): Promise<void> {
    for (const run of this.list()) {
      if (run.status === 'running' || run.status === 'starting') continue
      /* 未审阅的 worktree 不能被“清除已结束”悄悄丢掉。 */
      if (run.review === 'pending' || run.review === 'conflict') continue
      const rootCwd = this.runs.get(run.id)?.workspace.rootCwd ?? this.history.get(run.id)?.rootCwd ?? run.cwd
      // 只记隐藏，不删除调用记录、原生会话或补丁；重启后不能重新冒出来。
      await this.history.hide(run, rootCwd)
      const live = this.runs.get(run.id)
      clearTimeout(live?.pushTimer)
      this.runs.delete(run.id)
      this.pushedTranscript.delete(run.id)
      this.opts.onRemove?.(run.id)
    }
  }

  async start(
    task: string,
    model?: string,
    isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd' = 'shared-cwd',
    briefInput?: unknown
  ): Promise<{ ok: boolean; error?: string; run?: SubagentRun }> {
    const text = task.trim()
    if (!text) return { ok: false, error: '任务描述为空' }
    const modelError = subagentModelError(model ?? process.env.YAN_TEST_MODEL, isolation === 'controlled-cwd')
    if (modelError) return { ok: false, error: modelError }
    if (this.runningCount >= MAX_CONCURRENT) {
      return { ok: false, error: `同时最多 ${MAX_CONCURRENT} 个子代理，先等一个结束或停掉它` }
    }
    /*
     * 输入先成形再占槽：一份读不通的 brief 不应该占掉一个并发位，
     * 也不应该让子代理带着半截说明跑起来。
     */
    const parsed = parseSubagentBrief(briefInput, text)
    if (!parsed.ok) return { ok: false, error: parsed.error }

    /*
     * 槽位必须在第一个 `await` 之前预占（D1）。准备 worktree 要跑几条
     * git 命令（几十毫秒起），期间别的 `start` 会看到"没人占位"，
     * 于是三个并发请求能一起越过上限。
     *
     * 上下文也在这里整体快照（D3）：`setContext` 可能在准备期间被调用
     * （用户切了父会话），逐字段读 `this.opts` 会让 cwd 与
     * parentSessionId 分属两代。
     */
    const ctx = this.opts
    this.preparing += 1
    let reserved = true
    const releasePreparing = () => {
      if (!reserved) return
      reserved = false
      this.preparing -= 1
    }
    try {
      return await this.launch(ctx, text, model, isolation, parsed.brief, releasePreparing)
    } finally {
      releasePreparing()
    }
  }

  private async launch(
    ctx: SubagentOptions,
    text: string,
    model: string | undefined,
    isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd',
    brief: SubagentBrief,
    releasePreparing: () => void
  ): Promise<{ ok: boolean; error?: string; run?: SubagentRun }> {
    const id = `sub-${randomBytes(4).toString('hex')}`
    let workspace: PreparedWorkspace
    try {
      const prepare = ctx.prepare ?? prepareWorkspace
      workspace = await prepare(ctx.cwd, id, isolation)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    let rpc: SubagentRpc
    try {
      rpc = await this.createRpc(ctx, workspace.cwd, model, isolation, id)
    } catch (error) {
      await cleanupWorkspace(workspace)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    const run: Run = {
      id,
      task: text,
      cwd: workspace.cwd,
      parentSessionId: ctx.parentSessionId,
      parentRunId: ctx.parentRunId,
      parentMessageId: ctx.parentMessageId,
      projectId: ctx.projectId,
      isolation: workspace.isolation,
      model,
      status: 'starting',
      startedAt: Date.now(),
      latestActivity: '启动中…',
      transcript: [],
      review: 'none',
      usageSnapshots: {},
      brief,
      stderrTail: [],
      rpc,
      workspace,
      settled: false,
      msgSeq: 0,
      toolCalls: 0,
      lastProgressAt: Date.now(),
      runningTools: new Set(),
      /* 上限在**创建时就固定**（而不是等回调里再读 env）：测试提前清掉覆盖值时，提示会写成另一个数。 */
      ...limitsFor(brief),
      /* 占位，下面立刻排定 */
      timer: setTimeout(() => undefined, 0)
    }
    clearTimeout(run.timer)
    this.armWatch(run)

    rpc.on('event', (evt: Record<string, unknown>) => this.handleEvent(run, evt))
    /*
     * 有界保留脱敏后的 stderr 尾部；进程自己退或启动失败时，用它还原真实原因，
     * 而不是把所有早退都压成「启动期间已停止」。
     */
    rpc.on('stderr', (line: string) => {
      const safe = sanitizeStderrLine(line)
      if (!safe) return
      run.stderrTail.push(safe)
      if (run.stderrTail.length > MAX_STDERR_LINES) run.stderrTail.shift()
    })
    rpc.on('spawn-error', (err: Error) => {
      const raw = err instanceof Error ? err.message : String(err)
      // 存前脱敏：原始启动错误不能落进快照/历史/IPC，规则与 stderr 一致。
      run.exitInfo = { code: null, signal: null, spawnError: redactLocalDiagnostic(raw, 300) ?? '未知启动错误' }
      this.handleProcessGone(run)
    })
    rpc.on('exit', (code: number | null, signal: string | null) => {
      run.exitInfo = { ...(run.exitInfo ?? {}), code, signal }
      this.handleProcessGone(run)
    })

    this.runs.set(id, run)
    releasePreparing()
    await this.writeMetadata(run)
    this.emit(run)

    try {
      // 保存起始快照时也可能收到停止；不能在已收口后重新拉起子进程。
      if (run.status !== 'starting') return this.startupAbort(run)
      rpc.spawn()
      /* 等 pi 起来（扩展加载 + RPC 就绪） */
      const ready = await this.waitReady(rpc, 20_000)
      /* 等待期间用户可能已经停掉它：不能再把 cancelled 覆盖回 running，更不能继续派活。 */
      if (run.status !== 'starting') return this.startupAbort(run)
      if (!ready.ok) {
        await this.fail(id, '子代理启动超时', 'startup')
        return { ok: false, error: this.runs.get(id)?.error ?? '子代理启动超时' }
      }
      /* 指定了模型却被 pi 悄悄换成别的（找不到、未登录等）：直接失败，不让任务在错误的模型上跑。 */
      if (model && ready.model && modelMismatch(model, ready.model)) {
        const message = `指定的模型 ${model} 没有生效（pi 实际使用 ${ready.model}），请核对模型名与登录状态后重试，不要改用其他模型`
        await this.fail(id, message, 'startup')
        return { ok: false, error: message }
      }
      if (model && ready.model) {
        const expectedApi = await ctx.resolveModelApi?.(ready.model, { sessionId: ctx.parentSessionId, runId: ctx.parentRunId })
        if (run.status !== 'starting') return this.startupAbort(run)
        const selectionError = await confirmRegisteredModel(rpc, ready.model, { readOnly: isolation === 'controlled-cwd', expectedApi })
        if (run.status !== 'starting') return this.startupAbort(run)
        if (selectionError) {
          await this.fail(id, selectionError, 'startup')
          return { ok: false, error: selectionError }
        }
      }
      /* 未显式指定模型时记下 pi 实际选用的那个，界面才能如实显示。 */
      if (ready.model) run.model = ready.model
      if (ready.thinkingLevel) run.thinkingLevel = ready.thinkingLevel
      run.status = 'running'
      run.latestActivity = '已启动'
      await this.writeMetadata(run)
      if (run.status !== 'running') return this.startupAbort(run)
      this.emit(run)

      const res = await rpc.command('prompt', { message: briefPrompt(brief, text) })
      if (!res.success) {
        await this.fail(id, res.error ?? '启动任务失败')
        return { ok: false, error: res.error ?? '启动任务失败' }
      }
      return { ok: true, run: this.snapshot(run) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      /*
       * 子进程已经先退出时，`handleProcessGone` 已经写下带退出码/stderr 的真实原因；
       * 不要把这份诊断再用通用的“pi 未运行 / 已退出”盖掉。
       */
      const realReason = run.status === 'error' && run.endReason === 'exited' ? run.error : undefined
      if (!realReason) await this.fail(id, message)
      return { ok: false, error: realReason ?? message }
    }
  }

  /** 拼子进程参数并造客户端（默认 `PiRpc`，单测可注入假实现） */
  private async createRpc(
    ctx: SubagentOptions,
    cwd: string,
    model: string | undefined,
    isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd',
    id: string
  ): Promise<SubagentRpc> {
    let version: string | undefined
    try { const probe = resolvePi({ override: ctx.piBin }); if (probe.home) version = JSON.parse(readFileSync(join(probe.home, 'package.json'), 'utf8')).version } catch { /* 未知版本保留兼容边界。 */ }
    const args = subagentPiArgs({ sessionDir: join(ctx.archiveDir ?? join(YAN_DIR, 'subagents'), 'sessions', id), native: nativePiToolsSupported(version), readOnly: isolation === 'controlled-cwd', model: model ?? process.env.YAN_TEST_MODEL, systemPrompt: ctx.appendSystemPrompt, extensions: ctx.extensions })
    if (ctx.createRpc) return ctx.createRpc({ cwd, piBin: ctx.piBin, args })
    /*
     * 子代理必须和主 agent 用同一个 pi 私有目录。主 agent 显式传了
     * `PI_CODING_AGENT_DIR`（见 agent.ts），子代理漏了这一步，pi 就会回退到
     * `~/.pi/agent`：便携版 / `YAN_PI_DIR` 隔离时凭证、models.json、会话目录
     * 全都错位（测试会读真实凭证而不是隔离副本）。这里补齐同一份目录。
     */
    // 子运行只有独立的危险审批端点，不继承父会话的完整能力令牌。
    const approval = new CapabilityServer({
      opsDir: join(ctx.archiveDir ?? join(YAN_DIR, 'subagents'), 'approvals', id),
      onlyCommands: ['danger.confirm'],
      handlers: { run: async (_command, params) => ({ summary: {
        kind: 'danger-confirm', allowed: await ctx.confirmDanger?.(params, cwd, { sessionId: ctx.parentSessionId, runId: ctx.parentRunId, subagentId: id }) ?? false
      } }) }
    })
    try {
      const endpoint = await approval.start({ sessionId: id, projectId: ctx.projectId ?? id })
      const rpc = new PiRpc({
        cwd, piBin: ctx.piBin, args,
        env: { PI_CODING_AGENT_DIR: PI_AGENT_DIR, YAN_DATA_DIR: YAN_DIR,
          YAN_CLI_URL: endpoint.url, YAN_CLI_TOKEN: endpoint.token,
          YAN_SESSION_ID: id, YAN_PROJECT_ID: ctx.projectId ?? id }
      })
      rpc.on('exit', () => approval.stop())
      const close = rpc.close.bind(rpc)
      rpc.close = async () => { approval.stop(); await close() }
      return rpc
    } catch (error) {
      approval.stop()
      throw error
    }
  }

  /** 停止一个运行（方案 8.3：停止是明确动作，不是关掉预览） */
  async stop(id: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(id)
    if (!run) return this.history.get(id) ? { ok: true } : { ok: false, error: '找不到这个子代理' }
    if (run.status !== 'running' && run.status !== 'starting') return { ok: true }
    await this.stopRun(run, false)
    return { ok: true }
  }

  private async stopRun(run: Run, cleanupReview: boolean): Promise<void> {
    // 先声明停止意图，abort/close触发的退出回调不能再当作异常失败。
    run.status = 'cancelled'
    run.endReason = 'stopped'
    run.error = undefined
    try {
      await run.rpc.command('abort')
    } catch {
      /* abort 失败也要把进程收掉 */
    }
    clearTimeout(run.timer)
    await run.rpc.close()
    run.status = 'cancelled'
    run.endReason = 'stopped'
    run.wrapUp = undefined
    run.endedAt = Date.now()
    run.latestActivity = '已停止'
    this.emit(run)
    await this.finalize(run, cleanupReview)
  }

  /**
   * 退出 / 重启时必须等待所有 pi 子进程和 worktree 收口。
   * 有未审阅修改的任务会先落一份补丁归档，再删除临时 worktree，避免
   * 退出留下孤儿进程或孤儿目录，同时保留可追溯结果。
   */
  async stopAll(): Promise<void> {
    const runs = [...this.runs.values()]
    for (const run of runs) {
      if (run.status === 'running' || run.status === 'starting') await this.stopRun(run, true)
      else {
        if (run.settling) await run.settling
        else await run.rpc.close()
        await this.finalize(run, true)
      }
    }
  }

  /**
   * 进程自己退出或启动失败：留下真实的退出码 / 信号 / stderr 原因。
   *
   * 只在 `running` / `starting` 时收口；重复的 exit 与 spawn-error、以及迟到的
   * exit 都不能覆盖 cancelled / completed / timeout 等已经定下的终态。
   */
  private handleProcessGone(run: Run): void {
    if (run.status !== 'running' && run.status !== 'starting') return
    clearTimeout(run.timer)
    run.status = 'error'
    run.endReason = 'exited'
    run.wrapUp = undefined
    run.error = run.error ?? describeProcessExit(run.exitInfo ?? {}, run.stderrTail)
    run.endedAt = Date.now()
    this.emit(run)
    void this.finalize(run, false)
  }

  /**
   * 启动期间进程已经收口时的返回原因。
   *
   * 早退会被 `handleProcessGone` 记成带退出码与 stderr 的 `error`，这里优先把
   * 那份真实原因交出去；只有用户确实停掉（cancelled）才说「启动期间已停止」。
   */
  private startupAbort(run: Run): { ok: false; error: string } {
    return { ok: false, error: run.status === 'error' && run.error ? run.error : '子代理在启动期间已停止' }
  }

  private async fail(id: string, message: string, reason: SubagentEndReason = 'failed'): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    clearTimeout(run.timer)
    await run.rpc.close()
    const cancelled = run.status === 'cancelled'
    run.status = cancelled ? 'cancelled' : 'error'
    run.endReason = cancelled ? 'stopped' : reason
    run.wrapUp = undefined
    run.progressWarning = undefined
    if (cancelled) {
      run.error = undefined
      run.latestActivity = '已停止'
    } else {
      run.error = reason === 'startup' && run.stderrTail.length ? `${message}；stderr：${run.stderrTail.join(' | ')}` : message
      run.latestActivity = message
    }
    run.endedAt = Date.now()
    this.emit(run)
    await this.finalize(run, false)
  }

  /**
   * 结束后读取隔离 worktree 的摘要。普通结束保留 worktree 给用户审阅；
   * 退出/重启则把补丁保留在 YAN_DIR/subagents 后清掉 worktree。
   *
   * ⚠️ 已结束的任务在退出时还会被 `stopAll` 再调一次（`cleanupReview=true`），
   * 而此时 `run.finalizing` 已经缓存 —— 直接返回它就等于退出时永远不清理
   * 那些"跑完但没审阅"的临时 worktree（D2）。所以缓存之后要**补一次**
   * 退出归档。
   */
  private async finalize(run: Run, cleanupReview: boolean): Promise<void> {
    if (!run.finalizing) run.finalizing = this.finalizeOnce(run, cleanupReview)
    await run.finalizing
    if (cleanupReview) await this.archiveOnExit(run)
  }

  private async finalizeOnce(run: Run, cleanupReview: boolean): Promise<void> {
    try {
      const archiveDir = this.opts.archiveDir ?? join(YAN_DIR, 'subagents')
      const collected = await collectDiff(run.workspace, archiveDir, run.id)
      run.diff = collected.summary
      const changed = collected.summary.files > 0

      if (run.isolation === 'worktree' && changed) {
        if (cleanupReview) {
          if (!collected.patchPath) throw new Error('未能保存改动补丁，已保留工作区')
          run.review = 'archived'
          run.resultPath = collected.patchPath ?? run.workspace.worktreePath
          await cleanupWorkspace(run.workspace)
          run.worktreeDone = true
        } else {
          run.review = 'pending'
          run.resultPath = run.workspace.worktreePath
        }
      } else {
        run.review = 'none'
        run.resultPath = collected.patchPath
        await cleanupWorkspace(run.workspace)
        run.worktreeDone = true
      }

      await this.writeMetadata(run, collected.patchPath)
    } catch (error) {
      /* 差异读取失败时保留 worktree，不把用户改动当成“无改动”清掉。 */
      run.review = run.isolation === 'worktree' ? 'conflict' : 'none'
      run.error = run.error ?? `读取子代理差异失败：${error instanceof Error ? error.message : String(error)}`
      run.resultPath = run.workspace.worktreePath
      await this.writeMetadata(run)
    }
    this.emit(run)
    if (!run.notified) {
      run.notified = true
      try {
        this.opts.onFinished?.(this.snapshot(run))
      } catch {
        /* 通知失败不能拖垮收口 */
      }
    }
  }

  /**
   * 退出收口：把仍留在磁盘上的未审阅 worktree 落成补丁再删除。
   * 已归档 / 已合并 / 已放弃 / 无隔离的任务是空操作。
   */
  private async archiveOnExit(run: Run): Promise<void> {
    if (run.worktreeDone) return

    if (run.isolation === 'worktree' && (run.review === 'pending' || run.review === 'conflict')) {
      try {
        const archiveDir = this.opts.archiveDir ?? join(YAN_DIR, 'subagents')
        const collected = await collectDiff(run.workspace, archiveDir, run.id)
        if (collected.summary.files > 0 && !collected.patchPath) throw new Error('未能保存改动补丁')
        run.diff = collected.summary
        run.review = 'archived'
        run.resultPath = collected.patchPath ?? run.workspace.worktreePath
        await this.writeMetadata(run, collected.patchPath)
      } catch (error) {
        /*
         * 连差异都读不出来就**不删 worktree**：宁可退出后留一个临时目录，
         * 也不能把用户还没看过的改动清干净。
         */
        run.error = run.error ?? `退出归档失败，已保留工作区：${error instanceof Error ? error.message : String(error)}`
        this.emit(run)
        return
      }
    }

    await cleanupWorkspace(run.workspace)
    run.worktreeDone = true
    this.emit(run)
  }

  private async writeMetadata(run: Run, patchPath?: string): Promise<void> {
    try {
      await this.history.save(this.snapshot(run), run.workspace.rootCwd, {
        limits: { totalMs: run.totalMs, stallTimeoutMs: run.idleMs, graceMs: run.graceMs },
        patchPath: patchPath ?? run.diff?.patchPath
      })
    } catch (error) {
      /* 落盘失败不拖垮进程收口，但保留诊断，不能静默宣称历史已保存。 */
      console.warn('[subagent] 保存历史失败', error)
    }
  }

  async merge(id: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(id)
    if (!run) return this.reviewHistory(id, 'merged')
    if (run.status === 'running' || run.status === 'starting') return { ok: false, error: '子代理仍在运行，结束后才能合并' }
    if (run.review === 'merged') return { ok: true }
    if (run.review !== 'pending' && run.review !== 'conflict') {
      return { ok: false, error: '该任务没有待合并的改动' }
    }
    const patchPath = run.diff?.patchPath
    if (!patchPath || !run.diff?.files) {
      return { ok: false, error: '没有可合并的补丁，已保留工作区供检查' }
    }

    const res = await applyPatch(run.workspace.rootCwd, patchPath)
    if (!res.ok) {
      run.review = 'conflict'
      run.error = res.error
      await this.writeMetadata(run, patchPath)
      this.emit(run)
      return res
    }

    run.review = 'merged'
    run.resultPath = patchPath
    run.error = undefined
    await cleanupWorkspace(run.workspace)
    /* 已清理过就别让退出流程再动一次同一个 worktree。 */
    run.worktreeDone = true
    await this.writeMetadata(run, patchPath)
    this.emit(run)
    return { ok: true }
  }

  async discard(id: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(id)
    if (!run) return this.reviewHistory(id, 'discarded')
    if (run.status === 'running' || run.status === 'starting') return { ok: false, error: '子代理仍在运行，先停止它' }
    run.review = 'discarded'
    /* 补丁归档保留，但隔离 worktree 明确删除；主工作树不受影响。 */
    run.resultPath = run.diff?.patchPath
    await cleanupWorkspace(run.workspace)
    run.worktreeDone = true
    await this.writeMetadata(run, run.diff?.patchPath)
    this.emit(run)
    return { ok: true }
  }

  /** 历史审阅只操作已保存补丁，不能把旧 cwd 当成当前进程或清理其目录。 */
  private async reviewHistory(id: string, review: 'merged' | 'discarded'): Promise<{ ok: boolean; error?: string }> {
    const record = this.history.get(id)
    if (!record) return { ok: false, error: '找不到这个子代理' }
    const run = { ...record.run }
    if (run.review === review) return { ok: true }
    if (review === 'merged') {
      if (!['pending', 'conflict', 'archived'].includes(run.review ?? '') || !run.diff?.files || !run.diff.patchPath) {
        return { ok: false, error: '历史任务没有可合并的补丁' }
      }
      const result = await applyPatch(record.rootCwd, run.diff.patchPath)
      if (!result.ok) return result
    }
    run.review = review
    await this.history.save(run, record.rootCwd)
    this.opts.onChange(run)
    return { ok: true }
  }

  /** 当前生效的停滞期限：工具执行期间放宽，其余时间用基础值。 */
  private stallLimit(run: Run): number {
    return run.runningTools.size ? run.idleMs * TOOL_RUNNING_STALL_FACTOR : run.idleMs
  }

  /** 进展续期停滞时钟；显式总期限独立计时，收尾计时不再续期。 */
  private armWatch(run: Run): void {
    if (run.wrapUp || (run.status !== 'running' && run.status !== 'starting')) return
    clearTimeout(run.timer)
    const at = Math.min(run.totalMs ? run.startedAt + run.totalMs : Infinity, run.lastProgressAt + this.stallLimit(run))
    run.timer = setTimeout(() => this.onWatch(run), Math.max(10, at - Date.now()))
  }

  private onWatch(run: Run): void {
    if (run.wrapUp || (run.status !== 'running' && run.status !== 'starting')) return
    const now = Date.now()
    if (run.totalMs && now >= run.startedAt + run.totalMs) void this.wrapUp(run, totalTimeoutText(run.totalMs))
    else if (now >= run.lastProgressAt + this.stallLimit(run)) void this.wrapUp(run, stallTimeoutText(this.stallLimit(run)))
    else this.armWatch(run)
  }

  /**
   * 超时先让它收尾交结论，宽限内仍没结束才硬停。
   *
   * 硬停时已经产出的助手文本仍会进摘要（见 `summarizeSubagentRun`），不会因为超时丢掉。
   * 启动阶段没有可收尾的东西，直接判失败。
   */
  private async wrapUp(run: Run, text: string): Promise<void> {
    if (run.wrapUp || run.settled) return
    if (run.status !== 'running') {
      await this.fail(run.id, text, 'timeout')
      return
    }
    run.wrapUp = { reason: 'timeout', since: Date.now() }
    run.progressWarning = text
    run.latestActivity = `${text}，正在收尾…`
    this.emit(run)
    clearTimeout(run.timer)
    run.timer = setTimeout(() => void this.fail(run.id, text, 'timeout'), run.graceMs)
    try {
      const res = await run.rpc.command('steer', { message: wrapUpMessage(text) }, { timeoutMs: 5000 })
      if (!res.success) await this.fail(run.id, text, 'timeout')
    } catch {
      await this.fail(run.id, text, 'timeout')
    }
  }

  private async waitReady(
    rpc: SubagentRpc,
    timeoutMs: number
  ): Promise<{ ok: boolean; model?: string; thinkingLevel?: string }> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (!rpc.running) return { ok: false }
      try {
        const res = await rpc.command('get_state', undefined, { timeoutMs: 2000 })
        if (res.success) {
          const data = res.data as { model?: unknown; thinkingLevel?: unknown } | undefined
          return {
            ok: true,
            model: modelLabel(data?.model),
            thinkingLevel: typeof data?.thinkingLevel === 'string' && data.thinkingLevel ? data.thinkingLevel : undefined
          }
        }
      } catch {
        /* 还没起来，继续等 */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return { ok: false }
  }

  /** 每条助手消息结束后读取 pi 原生上下文，不作周期轮询，也不阻塞模型事件。 */
  private refreshContext(run: Run): void {
    const revision = (run.contextRevision ?? 0) + 1
    run.contextRevision = revision
    run.contextRefresh = (async () => {
      try {
        const result = await run.rpc.command('get_session_stats', undefined, { timeoutMs: 2000 })
        if (!result.success || run.contextRevision !== revision) return
        const data = result.data as { contextUsage?: unknown } | undefined
        const usage = normalizeSubagentContextUsage(data?.contextUsage)
        if (!usage) return
        run.contextUsage = usage
        this.emit(run)
      } catch {
        /* 旧 pi 没报告或进程已退出：字段保持未知/最后一次原生快照，不估算。 */
      }
    })()
  }

  /** 已经收口（settled / 取消 / 失败）的运行不再接受迟到的重试与终态事件。 */
  private closedForEvents(run: Run): boolean {
    return run.settled || run.status === 'cancelled' || run.status === 'error'
  }

  private handleEvent(run: Run, evt: Record<string, unknown>): void {
    /* 只读旁路：评审运行的 R 号投影订阅原始事件；失败不影响子代理行为。 */
    if (this.opts.onEvent) {
      try {
        this.opts.onEvent(run.id, evt)
      } catch {
        /* 只读订阅不能打断事件处理 */
      }
    }
    const type = String(evt.type ?? '')
    if (PROGRESS_EVENTS.has(type)) {
      run.lastProgressAt = Date.now()
    }
    /* 临时调试开关：看 pi 到底推了哪些事件（YAN_DEBUG_SUBAGENT=1）。
       Windows 上 Electron 是 GUI 子系统，console.log 不进 stdout，所以落临时文件。 */
    if (process.env.YAN_DEBUG_SUBAGENT) {
      try {
        appendFileSync(
          join(tmpdir(), 'yan-subagent-events.log'),
          `${run.id} ${type} ${JSON.stringify(evt).slice(0, 600)}\n`,
          'utf8'
        )
      } catch {
        /* 调试用，失败无所谓 */
      }
    }
    if (type === 'message_start' || type === 'message_update' || type === 'message_end') {
      const raw = evt.message as PiMessage | undefined
      if (!raw) return

      /*
       * 先记住这一轮的结束原因。
       *
       * pi 不会给「模型失败」发一个单独的 error 事件：回合照常走到
       * `agent_settled`，错误只体现在 assistant 消息的 `stopReason` 上。
       * 不记住它，settled 就无法分辨「真答完了」与「模型报错了」
       *（实测：坏模型名下子代理显示「已完成」、`error=null`）。
       */
      if (raw.role === 'assistant' && raw.stopReason) {
        run.stopReason = raw.stopReason
        if (raw.stopReason === 'error') run.error = modelErrorNotice(raw.errorMessage)
      }

      /*
       * `toolResult` 不是新消息，而是对已有工具调用的**回填**（也不占用序号）。
       * 主会话的历史回放（normalizeHistory）就是这么做的；子代理这边原先
       * 直接 push，于是同一个调用在详情面板里显示成两条（一条默认 ok、
       * 一条 error），真实结果反而看不出来 —— 实测：只读子代理的 write
       * 被白名单封死，面板上却有一个绿色的 write。
       */
      if (raw.role === 'toolResult') {
        const result = normalizeMessage(raw, run.msgSeq)?.toolCalls?.[0]
        const target = result
          ? run.transcript.find((m: UIMessage) => m.toolCalls?.some((c) => c.id === result.id))
          : undefined
        const call = target?.toolCalls?.find((c) => c.id === result?.id)
        if (result && call) {
          call.status = result.status
          call.output = result.output
          if (result.cancelled) call.cancelled = true
          run.latestActivity = `${call.name}${result.status === 'error' ? ' 失败' : ' 完成'}`
          this.emit(run)
          return
        }
      }

      /* 开一条新消息才递增序号；流式 update/end 复用同一个序号 */
      if (type === 'message_start' || run.streamingId === undefined) {
        run.msgSeq += 1
        run.streamingId = `m${run.msgSeq}`
      }
      const msg = normalizeMessage(raw, run.msgSeq)
      if (!msg) return

      const idx = run.transcript.findIndex((m: UIMessage) => m.id === msg.id)
      if (idx >= 0) run.transcript[idx] = msg
      else run.transcript.push(msg)
      /* H-10b：按消息 id 收 usage 快照；同一 id 只留最后一份（流式→final 不重复） */
      const usage = toUsage(raw.usage)
      if (usage) {
        run.usageSnapshots = ingestUsageSnapshot(run.usageSnapshots, msg.id, usage)
        run.usage = accumulateUsage(run.usageSnapshots)
      }
      if (type === 'message_end') {
        run.streamingId = undefined
        if (raw.role === 'assistant') this.refreshContext(run)
      }
      if (run.transcript.length > MAX_TRANSCRIPT) {
        run.transcript.splice(0, run.transcript.length - MAX_TRANSCRIPT)
      }
      run.latestActivity = activityOf(msg)
      if (type === 'message_update' && raw.role === 'assistant') this.emitStream(run)
      else this.emit(run)
      return
    }

    if (type === 'tool_execution_end' && typeof evt.toolCallId === 'string') run.runningTools.delete(evt.toolCallId)
    if (type === 'tool_execution_start') {
      if (typeof evt.toolCallId === 'string') run.runningTools.add(evt.toolCallId)
      run.toolCalls = (run.toolCalls ?? 0) + 1
      if (!run.wrapUp) run.latestActivity = `运行 ${String(evt.toolName ?? '工具')}`
      this.emit(run)
      return
    }

    /*
     * `agent_end` 不是终局：pi 可能在自动重试前先发它，`willRetry:true` 时同一
     * 逻辑回合还会继续。宿主只认 pi 1.2 的原生 `agent_settled` 收口，不用
     * `agent_end` 抢关（否则会把正在重试的运行提前 close 掉）。旧 pi 若不发
     * `agent_settled`，运行由既有停滞/总时限兜底，不再以 legacy 名义保留这条
     * 危险分支。
     */
    if (type === 'agent_end') {
      if (this.closedForEvents(run)) return
      /* 只更新活动与计时；不 settled、不 close。 */
      if (evt.willRetry === true) {
        run.latestActivity = '模型请求失败，等待自动重试…'
        this.emit(run)
      }
      return
    }

    /* 原生自动重试纳入进展与只读活动：只显示真实拿到的 attempt，不编造默认次数。 */
    if (type === 'auto_retry_start') {
      if (this.closedForEvents(run)) return
      const attempt = finiteCount(evt.attempt)
      const maxAttempts = finiteCount(evt.maxAttempts)
      /* 每次重试开始只信任本事件携带的计数：缺失/无效一律清旧值，不拿上一轮历史数填。 */
      run.retryAttempt = attempt
      run.retryMaxAttempts = maxAttempts
      run.latestActivity = retryActivity(attempt, maxAttempts)
      this.emit(run)
      return
    }

    if (type === 'auto_retry_end') {
      if (this.closedForEvents(run)) return
      if (evt.success === false) {
        /*
         * 原生重试已结束且失败：保留模型报错，并把失败落到 stopReason 上，
         * 让随后的 `agent_settled` 如实收成 error。没有可靠字段就只说状态。
         */
        run.stopReason = 'error'
        run.error = run.error ?? modelErrorNotice(evt.finalError ?? evt.error)
        run.latestActivity = run.retryAttempt !== undefined
          ? `自动重试失败（已观察到第 ${run.retryAttempt} 次）`
          : '自动重试失败'
      } else if (evt.success === true) {
        /* 重试成功：暂态的模型失败要清掉，别让它跟随到终态。 */
        run.error = undefined
        run.stopReason = undefined
        run.latestActivity = '自动重试成功，继续'
      } else {
        /* success 缺失或非布尔：结果未知——不清错、不假成功、不收口，只如实记录状态。 */
        run.latestActivity = '自动重试结束（结果未知）'
      }
      this.emit(run)
      return
    }

    if (type === 'agent_settled') {
      /* 取消 / 已失败 / 已结束的运行不再被迟到事件重写；重复 settled 只收口一次。 */
      if (this.closedForEvents(run)) return
      run.settled = true
      clearTimeout(run.timer)
      /*
       * 模型自己失败也要如实落成 `error`（L03 尾巴）。
       *
       * 判据是 `stopReason === 'error'`，而不是「转录里有没有文本」：
       * 失败回合的 assistant 消息往往为空文本，拿空文本判会把空回复
       * 误判成失败；反过来只看 settled 则把失败当成功。
       */
      const modelFailed = run.status !== 'cancelled' && run.stopReason === 'error'
      const wrapped = run.status !== 'cancelled' && !modelFailed ? run.wrapUp : undefined
      run.status = run.status === 'cancelled' ? 'cancelled' : modelFailed ? 'error' : 'done'
      run.endReason = run.status === 'cancelled' ? 'stopped' : modelFailed ? 'model-error' : (wrapped?.reason ?? 'completed')
      run.wrapUp = undefined
      run.progressWarning = undefined
      run.endedAt = Date.now()
      if (modelFailed) run.error = run.error ?? modelErrorNotice(undefined)
      run.latestActivity = modelFailed
        ? '模型返回错误'
        : wrapped ? '超时，已收尾' : '已完成'
      this.emit(run)
      /*
       * 跑完的子代理进程必须收掉（D16）。
       *
       * pi 的 rpc 模式在 `agent_settled` 之后**不会自己退出**（还在等下一
       * 条命令）。原先这里只 finalize、不 close，后果有两个，都是实测到的：
       *   · 每跑完一个子任务就泄漏一个 pi 子进程，退出时 `stopAll` 又只对
       *     `running` 的调 `stopRun`，于是孤儿进程一直活到机器重启；
       *   · 进程的 cwd 就是隔离 worktree，Windows 上删不掉被用作工作目录
       *     的目录 —— `git worktree remove` 静默失败，临时目录残留。
       *
       * 但也不能一收到 settled 就 close：实测 settled 时 assistant 消息还是
       * 空的，模型的最终回复随后才到 —— 立即 close 会把尾巴一起切掉
       *（子代理场景的“转录里有回复文本”就是这么挂的）。所以先等转录安静。
       */
      run.settling = (async () => {
        await this.waitTranscriptQuiet(run)
        await run.contextRefresh
        try {
          await run.rpc.close()
        } catch {
          /* 已经退了就算了 */
        }
        await this.finalize(run, false)
      })()
    }
  }

  /**
   * 等这一轮的尾部事件推完。
   *
   * 判据是“转录连续一段时间没有变化”（而不是固定 sleep）：pi 的
   * `agent_settled` 不等于消息已经推完，但推完到安静之间的间隔很短，
   * 而且不同模型/工具数差别很大。带上限，不会把退出卡住。
   */
  private async waitTranscriptQuiet(run: Run, quietMs = 600, maxMs = 5000): Promise<void> {
    const snapshot = (): string =>
      JSON.stringify(
        run.transcript.map((m) => [
          m.id,
          m.text.length,
          m.toolCalls?.map((c) => [c.name, c.status, c.output?.length ?? 0]) ?? []
        ])
      )
    let last = snapshot()
    let changedAt = Date.now()
    const started = Date.now()
    while (Date.now() - started < maxMs) {
      await new Promise((r) => setTimeout(r, 150))
      const now = snapshot()
      if (now !== last) {
        last = now
        changedAt = Date.now()
        continue
      }
      if (Date.now() - changedAt >= quietMs) return
    }
  }
}

/** pi `get_state` 里的 model 对象 → `provider/id`（与 `--model` 的写法一致） */
function modelLabel(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { provider, id } = raw as { provider?: unknown; id?: unknown }
  if (typeof id !== 'string' || !id) return undefined
  return typeof provider === 'string' && provider ? `${provider}/${id}` : id
}

/** `--model` 写成 `provider/id`（可带 `:思考档位`）时才比较；通配或省略 provider 的写法交给 pi 解析。 */
function modelMismatch(requested: string, actual: string): boolean {
  const want = requested.replace(/:(off|minimal|low|medium|high|xhigh)$/i, '').trim()
  if (!want.includes('/') || want.includes('*')) return false
  return want.toLowerCase() !== actual.toLowerCase()
}

/** 事件里的次数只有在是正整数时才可信；字符串/小数/NaN 一律 undefined，不 coerce、不编默认值。 */
function finiteCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

/* 重试中的只读活动文案：没有可靠的 attempt 就只说明状态；max<attempt 的矛盾组合不展示伪总数。 */
function retryActivity(attempt: number | undefined, maxAttempts: number | undefined): string {
  if (attempt === undefined) return '模型请求失败，正在自动重试…'
  return maxAttempts === undefined || maxAttempts < attempt
    ? `模型请求失败，正在自动重试（第 ${attempt} 次）`
    : `模型请求失败，正在自动重试（第 ${attempt}/${maxAttempts} 次）`
}

/** 列表里显示的那一行活动 */
function activityOf(msg: UIMessage): string {
  if (msg.role === 'assistant') {
    const first = msg.text.split('\n').map((x) => x.trim()).find(Boolean)
    if (first) return first.slice(0, 80)
    if (msg.toolCalls?.length) return `调用 ${msg.toolCalls[msg.toolCalls.length - 1].name}`
    if (msg.thinking) return '推理中…'
    return '生成中…'
  }
  return msg.text.split('\n').find(Boolean)?.slice(0, 80) ?? '处理中…'
}
