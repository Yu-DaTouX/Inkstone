/**
 * 工作模式、目标与交接的 IPC 适配（`yan:*WorkMode`、`yan:*Goal*`、`yan:*Handoff`）。
 *
 * 读写都针对当前实例所在的会话；界面提交带 `expectedRevision`，不一致就拒绝并回传当前值。
 * 状态与判定在 goal-coordinator / handoff-coordinator，这里只做入参校验与转发。
 */
import type { IpcRegistrar } from './registrar'
import { defaultWorkMode, workModeKeyFor, resolveWorkMode, pushWorkMode, pushGoal, cancelGoalResume, goals } from '../goal-coordinator'
import { HANDOFF_COMMIT_ENABLED, HANDOFF_THRESHOLD_EFFECTIVE, handoffPending, handoffLastCheck, abandonHandoff } from '../handoff-coordinator'
import { eventsForSession } from '../../shared/handoff-diagnostics'
import { normalizeChainKey } from '../../shared/session-chain'
import { keepsGoalResumeOnModeChange, normalizePursuedBrief } from '../../shared/goal'
import { writeWorkModeSnapshot } from '../work-mode-service'
import { normalizeWorkMode } from '../../shared/work-mode'
import type { WorkMode, WorkModeState } from '../../shared/work-mode'
import type { RunnerRegistry } from '../runners'
import type { WorkModeStore } from '../work-mode-service'
import type { HandoffStore } from '../handoff-service'
import type { HandoffTransactionStore } from '../handoff-transaction-service'
import type { SessionChainStore } from '../session-chain-service'
import type { HandoffDiagnostics } from '../handoff-diagnostics'
import type { MainPush } from '../../shared/ipc'

export interface GoalIpcDeps {
  registry(): RunnerRegistry | null
  workModes: WorkModeStore
  handoffs: HandoffStore
  handoffTransactions: HandoffTransactionStore
  sessionChains: SessionChainStore
  handoffDiag: HandoffDiagnostics
  pushFrom(runnerId: string, msg: MainPush): void
  /** 会话的「下一步动作」串行决定（见 session-work-scheduler.ts） */
  scheduleSessionWork(id: string, reason: string): Promise<void>
}

export function registerGoalIpc(ipc: IpcRegistrar, deps: GoalIpcDeps): void {
  const { handle } = ipc
  const { registry, workModes, handoffs, handoffTransactions, sessionChains, handoffDiag, pushFrom, scheduleSessionWork } = deps
  /*
   * 工作模式（实施-05）。
   *
   * 读写都针对**当前实例所在的会话**（不是全局设置）：A 会话切自主不得
   * 改变 B 会话的提问行为。界面提交时带 `expectedRevision`，不一致就拒绝
   * 并回传当前值 —— 界面据此恢复显示，不会出现「UI 已自主而扩展仍标准」。
   */
  handle('yan:getWorkMode', async () => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { mode: defaultWorkMode(), revision: 0 } satisfies WorkModeState
    return resolveWorkMode(id)
  })
  /**
   * 当前会话的目标状态（实施-05 S3，只读）。
   *
   * 与模式同一个键（会话文件路径）：目标也是**按会话**的 ——
   * 切会话后界面看到的是那个会话自己的进度，不是刚离开那个。
   */
  handle('yan:getGoal', async () => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { goal: goals.state(''), mode: { mode: defaultWorkMode(), revision: 0 } }
    await goals.load()
    return { goal: goals.state(workModeKeyFor(id)), mode: await resolveWorkMode(id) }
  })

  /** 设定当前会话是否在计划就绪后暂停，等待用户审阅。 */
  handle('yan:setGoalReadyApproval', async (mode: unknown, expectedGoalRevision: unknown) => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { ok: false as const, error: 'no_session' as const, goal: goals.state('') }
    if (mode !== 'automatic' && mode !== 'review') {
      return { ok: false as const, error: 'bad_mode' as const, goal: goals.state(workModeKeyFor(id)) }
    }
    const workMode = await resolveWorkMode(id)
    if (workMode.mode !== 'clarify') {
      return { ok: false as const, error: 'clarify_required' as const, goal: goals.state(workModeKeyFor(id)) }
    }
    await goals.load()
    const res = await goals.setReadyApprovalMode(
      workModeKeyFor(id),
      mode,
      typeof expectedGoalRevision === 'number' ? expectedGoalRevision : Number.NaN
    )
    if (!res.ok) return { ok: false as const, error: res.code, goal: res.goal }
    await pushGoal(id)
    return { ok: true as const, goal: res.goal }
  })

  /** 按钮操作绑定当前 runner，目标与模式版本都由宿主重新核对。 */
  handle('yan:approveGoalReady', async (input: unknown) => {
    const request = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const id = registry()?.activeRunner()?.id
    if (!id) return { ok: false as const, error: 'no_session' as const, goal: goals.state('') }
    if (request.runnerId !== id) {
      return { ok: false as const, error: 'stale_runner' as const, goal: goals.state(workModeKeyFor(id)) }
    }
    await goals.load()
    const key = workModeKeyFor(id)
    const currentGoal = goals.state(key)
    const transitionId = typeof request.transitionId === 'string' ? request.transitionId : ''
    const expectedGoalRevision = typeof request.goalRevision === 'number' ? request.goalRevision : Number.NaN
    const expectedModeRevision = typeof request.modeRevision === 'number' ? request.modeRevision : Number.NaN
    if (!currentGoal.pendingReady) {
      const replay = await goals.approveReadyReview(key, {
        transitionId,
        goalRevision: expectedGoalRevision,
        modeRevision: expectedModeRevision
      })
      return replay.ok
        ? { ok: true as const, replayed: true, goal: replay.goal }
        : { ok: false as const, error: replay.code, goal: replay.goal }
    }
    const currentMode = await resolveWorkMode(id)
    if (currentMode.mode !== 'clarify' || currentMode.revision !== expectedModeRevision) {
      return { ok: false as const, error: 'stale_mode' as const, goal: currentGoal }
    }
    if (currentGoal.revision !== expectedGoalRevision) {
      return { ok: false as const, error: 'stale_goal' as const, goal: currentGoal }
    }

    /* 先用模式 revision CAS，目标提交失败时再尝试恢复原模式。 */
    const switched = await workModes.set(key, 'standard', currentMode.revision)
    if (!switched.ok) {
      await pushWorkMode(id)
      return { ok: false as const, error: switched.error ?? 'stale_mode', goal: currentGoal }
    }
    const approved = await goals.approveReadyReview(key, {
      transitionId,
      goalRevision: expectedGoalRevision,
      modeRevision: expectedModeRevision
    })
    if (!approved.ok) {
      const restored = await workModes.set(key, 'clarify', switched.state.revision)
      await pushWorkMode(id)
      await pushGoal(id)
      return { ok: false as const, error: restored.ok ? approved.code : 'approval_rollback_failed', goal: approved.goal }
    }
    await pushWorkMode(id)
    await pushGoal(id)
    if (approved.replayed) return { ok: true as const, replayed: true, goal: approved.goal }

    /* 按钮就是用户的“批准并开始”指令；发给绑定 runner，避免切会话后串发。 */
    const started = await registry()?.agentOf(id)?.send('请按刚才批准的计划开始执行。', undefined, 'followUp')
    return {
      ok: true as const,
      replayed: false,
      started: started?.ok === true,
      startError: started?.error,
      goal: approved.goal
    }
  })

  handle('yan:modifyGoalReady', async (input: unknown) => {
    const request = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const id = registry()?.activeRunner()?.id
    if (!id) return { ok: false as const, error: 'no_session' as const, goal: goals.state('') }
    if (request.runnerId !== id) {
      return { ok: false as const, error: 'stale_runner' as const, goal: goals.state(workModeKeyFor(id)) }
    }
    const currentMode = await resolveWorkMode(id)
    if (currentMode.mode !== 'clarify' || currentMode.revision !== request.modeRevision) {
      return { ok: false as const, error: 'stale_mode' as const, goal: goals.state(workModeKeyFor(id)) }
    }
    await goals.load()
    const res = await goals.modifyReadyReview(workModeKeyFor(id), {
      transitionId: typeof request.transitionId === 'string' ? request.transitionId : '',
      goalRevision: typeof request.goalRevision === 'number' ? request.goalRevision : Number.NaN
    })
    if (!res.ok) return { ok: false as const, error: res.code, goal: res.goal }
    await pushGoal(id)
    return { ok: true as const, goal: res.goal }
  })

  /**
   * 用户设定持续目标（`+` 菜单 → 目标）：目标 + 可衡量的成果。
   *
   * 身份只取宿主绑定的当前会话键（与 `yan:getGoal` 同一表达式）：请求里带
   * 别的会话 id 一律不看 —— 否则渲染端一个笔误就能把目标写到别的会话上。
   *
   * 这里**不**预写续行：用户接着还要把这条消息发出去，续行会在那一轮收尾时
   * 由 `maybeArmGoalContinue` 统一 arm（早 arm 会多跑一轮空转）。
   */
  handle('yan:setGoal', async (brief: unknown) => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { ok: false as const, error: 'no_session' as const }
    /*
     * 表单 / IPC / 读盘共用同一归一化（G-1）：
     * 必填的「目标 + 可衡量的成果」缺任一则拒收（允许缺等于造一个无法验收的目标），
     * 交付物 / 范围 / 约束是可选补充，只 trim、空即不落字段。
     */
    const normalized = normalizePursuedBrief(brief)
    if (!normalized) return { ok: false as const, error: 'incomplete' as const }
    await goals.load()
    const goal = await goals.startPursued(workModeKeyFor(id), normalized)
    await pushGoal(id)
    return { ok: true as const, goal }
  })
  /*
   * 交接状态（实施-05 S5b-2）——**只读**。
   *
   * 写入通道只有一条：宿主自己（薄层只产原文，校验与落盘都在主进程）。
   * 界面（与探针）要看的是「压了几次、包写了没有、这一次在不在生成中」——
   * 没有这个入口，带模型的真实取证就只能靠读文件，
   * 而「包已经写好」这件事在界面上永远是看不见的（§9 的 UI 与观测）。
   */
  handle('yan:getHandoff', async () => {
    await handoffDiag.load()
    const id = registry()?.activeRunner()?.id
    if (!id) {
      return {
        sessionKey: '',
        tally: null,
        segmentTally: null,
        chainSegments: 0,
        package: null,
        pending: false,
        threshold: HANDOFF_THRESHOLD_EFFECTIVE,
        transaction: null,
        events: handoffDiag.recent(40),
        autoCommit: HANDOFF_COMMIT_ENABLED
      }
    }
    const key = workModeKeyFor(id)
    await handoffs.load()
    await handoffTransactions.load()
    /*
     * 交接之后当前实例跑在**目的段**上，而计数与包是按**源段**（片段键）存的。
     * 前端口径是「一条会话」，所以这里沿链回到首段去取 —— 否则交接一完成，
     * 界面上的「已压 N 次 / 包写好了没有」当场归零（看上去像功能坏了）。
     */
    await sessionChains.load()
    const chain = sessionChains.chainOf(key)
    const head = chain?.segments?.[0]?.sessionFile ?? key
    const entry = handoffs.state(head)
    const tx = handoffTransactions.latestForSession(key)
    /*
     * 诊断流水是**全局**的：不过滤就会把别的会话的整理失败也渲染到这条会话里
     *（用户 2026-09-23 报「这个提示在每个对话内都显示」）。
     * 一条会话 = 一条链，所以按链上的键筛（交接后的旧段仍属于它）；
     * 先筛再取最近 40 条 —— 反过来会被别处的噪音把本条挤掉。
     */
    const chainKeys = new Set<string>([key])
    for (const segment of chain?.segments ?? []) chainKeys.add(segment.sessionFile)
    const events = eventsForSession(handoffDiag.recent(), { keys: chainKeys, runnerId: id }).slice(-40)
    return {
      sessionKey: key,
      tally: entry.tally,
      /* 阈值看的是**本片段**又压了几次；`tally` 是链首的历史口径（实施-14 F5） */
      segmentTally: handoffs.state(key).tally,
      chainSegments: chain?.segments.length ?? 1,
      package: entry.package,
      pending: handoffPending.has(id),
      threshold: HANDOFF_THRESHOLD_EFFECTIVE,
      transaction: tx
        ? {
            handoffId: tx.handoffId,
            stage: tx.stage,
            /*
             * 归一化后回传：与 `sessionKey` 同一口径。
             * pi 给的会话文件路径在 Windows 上是反斜杠，直接回传会让前端
             * 「当前段 === 目的段」永远不相等（看上去像视图没切过去）。
             */
            destinationSession: normalizeChainKey(tx.destinationSession),
            receipts: tx.receipts ?? {},
            steps: tx.steps.slice(-4),
            resumeAttempts: tx.resumeAttempts
          }
        : null,
      /* 最近的过程事件（实施-14 F0）：界面 / 探针据此区分「没资格 / 没生成 / 没提交 / 没确认」 */
      events,
      autoCommit: HANDOFF_COMMIT_ENABLED
    }
  })
  /*
   * 人工确认「续接确实已经在跑」（实施-15 A-3）。
   *
   * 为什么需要这个出口：`resumed` 一直靠「会话文件里有标记」判，而标记只能证明
   * **已投递**（那段正文是本地拼的）。用户去看了一眼目的会话、确认模型真在跑了
   * 之后，需要一个**不重发**的了结 —— 否则 `resumeAttempts` 到 2 以后就只剩干等。
   *
   * 只允许在「已经发过」之后确认：没发过就跳过发送直接标完成是假的。
   */
  handle('yan:confirmHandoff', async (handoffId: string) => {
    await handoffTransactions.load()
    const tx = handoffTransactions.snapshot().transactions[String(handoffId ?? '')]
    if (!tx) return { ok: false, error: 'not-found' }
    if (typeof tx.receipts?.sentAt !== 'number') return { ok: false, error: 'not-sent' }
    const done = await handoffTransactions.step(tx.handoffId, 'resumed', 'manual-confirmed')
    handoffDiag.record({
      stage: 'commit',
      outcome: 'manual-confirmed',
      reason: 'user-verified',
      runnerId: registry()?.activeRunner()?.id ?? '',
      sessionKey: tx.sourceSession
    })
    return { ok: done.advanced || done.tx?.stage === 'resumed' }
  })

  /*
   * 用户点「重试」（实施-14 F5）：清掉残留的生成现场，再走一遍单一调度。
   * 它不是「强行交接」—— 资格不够时照旧如实拒绝，只在诊断里多一条 `manual-retry`。
   */
  handle('yan:retryHandoff', async () => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { ok: false, error: 'pi 未运行' }
    await handoffDiag.load()
    handoffDiag.record({
      stage: 'generate',
      outcome: 'manual-retry',
      runnerId: id,
      sessionKey: workModeKeyFor(id)
    })
    /* 清掉可能残留的现场（没有就不做） */
    await abandonHandoff(id, 'manual-retry')
    /* 资格评估有 1 秒节流；用户明确要求重试，就让它现在真的判一次 */
    handoffLastCheck.delete(id)
    void scheduleSessionWork(id, 'manual-retry')
    return { ok: true }
  })
  handle('yan:setWorkMode', async (mode: WorkMode, expectedRevision?: number) => {
    const id = registry()?.activeRunner()?.id
    if (!id) {
      return { ok: false, state: { mode: normalizeWorkMode(mode), revision: 0 }, error: 'pi 未运行' }
    }
    await workModes.load()
    const res = await workModes.set(workModeKeyFor(id), mode, expectedRevision)
    /*
     * 档位是用户对这条会话的明确意图（实施-14 A3）：
     *   · 新档仍然会「接着干」→ 保留未消费的续行（自主档，或 pursue 目标 —— 与档位正交）；
     *   · 其余情况（切到标准 / 计划）→ 作废未消费续行。
     * 旧实现只在 `mode !== 'standard'` 时清，于是**切回标准档**时自主档留下的
     * 续行仍然有效，下一轮它自己又跑起来。
     * ⚠️ 就绪转移不走这里（宿主内部直接调 `workModes.set`），所以不会误伤自己。
     */
    if (res.ok) {
      await goals.load()
      const key = workModeKeyFor(id)
      let goal = goals.state(key)
      if (mode !== 'clarify' && goal.pendingReady) {
        await goals.cancelReadyReview(key)
        goal = goals.state(key)
      }
      const pursue = goal.pursue === true
      /* 改档是明确动作：解除“用户按过停止”留下的暂停（A2） */
      await goals.setPaused(key, false).catch(() => {})
      const stillRuns = keepsGoalResumeOnModeChange(mode, pursue)
      if (!stillRuns) {
        await cancelGoalResume(id).catch(() => {})
        handoffDiag.record({
          stage: 'goal-continue',
          outcome: 'cancelled',
          reason: 'work-mode-changed',
          runnerId: id,
          sessionKey: key,
          detail: { mode, pursue }
        })
      }
    }
    /* 失败也要写 + 推：界面要拿当前值恢复，扩展也不能继续读旧值 */
    await goals.load()
    const planApprovalPending = goals.state(workModeKeyFor(id)).pendingReady !== null
    await writeWorkModeSnapshot(id, { ...res.state, planApprovalPending }).catch(() => {})
    pushFrom(id, { ch: 'work-mode', payload: res.state })
    if (res.ok && mode !== 'clarify') await pushGoal(id)
    return res
  })
}
