/**
 * 当前回合的计时与元数据：起点（墙钟与单调）、归属的 assistant 消息、终止原因、
 * 输出 token、run 标识，以及按事件顺序追加到回合计时日志（turn-timings）的记录。
 *
 * 状态由 AgentController 的事件处理推进；这里只保存与落盘，不读 pi 事件。
 */
import type { UIMessage } from '../shared/ipc'
import { YAN_DIR } from './paths'
import { toolWaitSpans } from '../shared/turns'
import { appendTurnTiming, timingKey, TURN_TIMING_VERSION } from './turn-timing-store'
import type { ResponseDetail, TurnTerminalReason } from '../shared/ipc'

export class TurnTimingTracker {
  /** 当前 agent 回合的宿主起点；与单条 assistant 消息的首 token 时间分开。 */
  startedAt?: number
  /**
   * 当前回合的**单调**起点（`performance.now()`）。
   *
   * 为什么不用 `Date.now()`：墙钟会被系统对时 / 手动调整改掉，算出负数或
   * 凭空的几十秒。整轮用时只用于展示与落盘，用单调差值才稳定（H-6）。
   */
  startedMono?: number
  /** 这一轮归属的 assistant 消息 id，按出现顺序；终止时写进元数据日志。 */
  messageIds: string[] = []
  /** 本轮终止原因；默认完成，abort / 模型错误各自覆盖。 */
  terminal: TurnTerminalReason = 'completed'
  /** 本轮最后一次算出的用时（单调口径），落盘时用。 */
  elapsedMs?: number
  /**
   * 本轮模型报出的**输出** token 数（A-2 预算要用）。
   *
   * 取各次消息的最大值而不是相加：provider 报的是**累积值**
   *（同一条流里后到的覆盖面更大），相加会算重。
   * 一个逻辑回合下多个 run（自动继续）各落一条记录，读回时相加（见 mergeTurnRecords）。
   */
  outputTokens?: number
  /** 本轮是否已经写过至少一条元数据记录（中间写一次、终止时再更新一次）。 */
  persisted = false
  /** 同一 runner 的中途快照与终止快照按事件顺序追加，避免慢写的中途记录盖过收尾。 */
  writeTail: Promise<void> = Promise.resolve()
  /**
   * 当前 **run** 的标识（实施-11 H-6b）。
   *
   * 为什么需要与 `logicalTurnId` 分开：一个逻辑回合（= 一次用户请求 + 自动继续）
   * 会跑多次 pi 的 agent 回合。同一个 run 内的中途快照与终止快照**是同一段工作**
   * （后者覆盖前者），而不同 run 是串起来的另一段工作（用时**相加**）。
   * 读回时靠这个字段区分「覆盖」与「累加」，不能只看 logicalTurnId。
   */
  runSeq = 0
  runId?: string
  responseDetail: ResponseDetail = 'unknown'

  /**
   * 写一条回合计时记录。`final` 为 false 时是中途快照（同一 run 只写一次）；
   * 为 true 时是终止记录，并清空本轮的消息、用时、输出与终止原因。
   */
  async persist(final: boolean, sessionFile: string | undefined, messages: UIMessage[]): Promise<void> {
    /*
     * 分桶 key 用会话**文件名**，不用 `this.state.sessionId` —— pi 的 get_state
     * 在部分版本里不给 sessionId，用它会让记录静默写不出来（实测踩过）。
     */
    const bucket = timingKey(sessionFile)
    const elapsedMs = this.elapsedMs
    const sourceIds = [...this.messageIds]
    const terminalReason = this.terminal
    if (final) {
      this.messageIds = []
      this.elapsedMs = undefined
      this.outputTokens = undefined
      this.terminal = 'completed'
    }
    if (!bucket || elapsedMs === undefined || sourceIds.length === 0) return
    if (!final && this.persisted) return
    /*
     * 锚定用户消息：两侧的用户消息 id 都是 `normalizeMessage` 生成的 `m<idx>`。
     * 临时 assistant id 在重读历史时对不上，不能拿它当锤。
     */
    const anchorId = [...messages]
      .reverse()
      .find((m) => m.role === 'user' && /^m\d+$/.test(m.id))?.id
    /*
     * 逻辑回合身份（H-6b）：优先用**用户消息 id**。
     * 同一次请求触发的自动继续会开新的 pi agent 回合（新 runId），
     * 但用户消息没变 —— 用 anchorId 才能把它们归成同一个逻辑回合，
     * 而不是每次 agent_end 就冻结出一个新回合。分叉 / 压缩换过历史
     * 导致锚对不上时，回退到首条 assistant id（旧行为，仍然自洽）。
     */
    const logicalTurnId = anchorId ?? sourceIds[0]
    /* 工具等待分段（H-6b）：从本轮消息的工具调用派生，并行分支不重复计。 */
    const waitSpans = toolWaitSpans(
      messages
        .filter((m) => sourceIds.includes(m.id))
        .flatMap((m) => m.toolCalls ?? [])
    )
    const endedAt = Date.now()
    const record = {
      v: TURN_TIMING_VERSION,
      logicalTurnId,
      /* run id 让读回时能区分「同一段工作的两次快照」与「自动继续的另一段」。 */
      ...(this.runId ? { runId: this.runId } : {}),
      /* 墙钟起点是反推的（用时本身是单调口径），只用于展示这一轮什么时候开始 */
      startedAt: endedAt - elapsedMs,
      endedAt,
      elapsedMs,
      terminalReason,
      /*
       * H-6b：中途快照带 `final: false`。应用在飞行中被拿掉时盘上只剩它，
       * 读回就能把这一轮认成「被中断」而不是「正常完成」。
       */
      final,
      ...(anchorId ? { anchorId } : {}),
      sourceIds,
      ...(waitSpans.length ? { waitSpans } : {}),
      ...(this.outputTokens ? { outputTokens: this.outputTokens } : {}),
      monotonicMs: elapsedMs
    }
    const write = this.writeTail.then(() => appendTurnTiming(YAN_DIR, bucket, record))
    this.writeTail = write.then(
      () => undefined,
      () => undefined
    )
    if (await write) this.persisted = true
  }
}
