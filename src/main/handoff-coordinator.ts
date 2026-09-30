/**
 * 自动交接的协调：判资格 → 渲染提示词 → 写请求 → 轮询结果 → 解析 / 校验 → 提交事务。
 *
 * 这是会话后台调度的一部分，从应用入口移出；入口只在启动时用
 * `configureHandoffCoordinator` 接上宿主能力（运行注册表、目标 / 模式存储、推送、
 * 建目的会话等），桌面 IPC、远程控制与会话调度器都调这里的同一套规则。
 */
import type { MainPush } from '../shared/ipc'
import { readFile } from 'node:fs/promises'
import { RunnerRegistry } from './runners'
import { getSettings } from './settings'
import { handoffContinuationProblem } from '../shared/handoff-context'
import { handoffReasonText } from '../shared/handoff-notice'
import { GoalStore, writeGoalResumeSnapshotIfVacant } from './goal-service'
import { HandoffStore, HandoffRequestStore, buildHandoffRequest } from './handoff-service'
import { HandoffDiagnostics } from './handoff-diagnostics'
import { ownsHandoffOperation, EligibilityRejectLog } from '../shared/handoff-schedule'
import { HandoffTransactionStore } from './handoff-transaction-service'
import { SessionChainStore } from './session-chain-service'
import { HandoffRunner } from './handoff-runner'
import type { HandoffSessionHandle, HandoffSessionTarget } from './handoff-runner'
import { normalizeChainKey } from '../shared/session-chain'
import { HANDOFF_AUTO_COMPACT_THRESHOLD, handoffCommitEnabled, handoffSummary, parseHandoffOutput, sanitizeHandoffPackage } from '../shared/handoff'
import type { HandoffPackage } from '../shared/handoff'

import { isActiveGoalPhase, keepsGoalResumeOnModeChange } from '../shared/goal'
import { WorkModeStore, writeWorkModeSnapshot } from './work-mode-service'
import type { WorkMode, WorkModeState } from '../shared/work-mode'
import type { SessionState } from '../shared/ipc'

export interface HandoffHost {
  runners(): RunnerRegistry | null
  defaultWorkMode(): WorkMode
  goals: GoalStore
  handoffs: HandoffStore
  workModes: WorkModeStore
  sessionChains: SessionChainStore
  handoffTransactions: HandoffTransactionStore
  handoffDiag: HandoffDiagnostics
  workModeKeyFor(id: string): string
  resolveWorkMode(id: string): Promise<WorkModeState>
  pushFrom(runnerId: string, msg: MainPush): void
  push(msg: MainPush): void
  maybeArmGoalContinue(id: string): Promise<void>
  cancelGoalResume(id: string): Promise<void>
  applyGoalResume(id: string): Promise<void>
  consumeRepeatBlocks(id: string): Promise<void>
  rememberRunnerSession(
    result: { ok: boolean; id?: string; sessionId?: string },
    target: { sessionFile?: string; projectId?: string; scope?: 'global' | 'project' | 'pending'; cwd: string }
  ): Promise<void>
  pushRunners(): void
  pushRunnerSnapshot(id: string, opts?: { chainHistory?: boolean }): Promise<void>
  openHandoffSession(target: HandoffSessionTarget): Promise<HandoffSessionHandle>
  projectIdForCwd(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string | undefined
}

let host: HandoffHost

/** 入口启动时调用一次；在此之前不会有任何交接被触发（都依赖运行实例）。 */
export function configureHandoffCoordinator(next: HandoffHost): void {
  host = next
  handoffRunner = createHandoffRunner()
}

/**
 * 自动交接的开关（**默认开**，用户 2026-09-19 拍板）。
 *
 * 解析在 [shared/handoff.ts] 的 `handoffCommitEnabled`（可单测）：
 * 默认开，`YAN_HANDOFF_COMMIT=0`（`false` / `off` / `no` 同样）显式关闭。
 *
 * §7 原先的「先完成真实长任务验证再开默认值」前置已满足：`handoffcommit`（cost 1）
 * 真的跑通了建目的会话 / 写链 / 发 resume / 消费证据，崩溃恢复有单测全矩阵与磁盘核对。
 *
 * 「打开」只是**允许**交接：实际发生仍要过四条资格（够数 + 目标在推进 + 自主档 + 不忙），
 * 标准档会话不会被它带走。
 */
export const HANDOFF_COMMIT_ENABLED = handoffCommitEnabled(process.env)

/** 交接相关的用户可见提示（推给当前视图；没有活动实例就全局推）。 */
export function handoffAlert(message: string, notifyType: 'info' | 'warning' | 'error'): void {
  const msg: MainPush = {
    ch: 'notify',
    payload: { id: `handoff-${Date.now()}`, method: 'notify', notifyType, message }
  }
  const active = host.runners()?.activeRunnerId
  if (active) host.pushFrom(active, msg)
  else host.push(msg)
}

/**
 * 交接的执行器（§8 第 4–6 步）。
 *
 * 不直接 import runner / agent：全部经依赖注入，单测用假依赖就能覆盖
 * 「先停源再建目的」「链只在会话建好后写」「resumed 只认磁盘证据」三条顺序。
 */
function createHandoffRunner(): HandoffRunner {
  return new HandoffRunner({
    transactions: host.handoffTransactions,
    chains: host.sessionChains,
    stopRunner: async (runId) => (await host.runners()?.stopOne(runId, handoffPending.has(runId))) ?? false,
    openSession: (target) => host.openHandoffSession(target),
    /*
     * 交接 resume 走薄层的 `custom` 通道（实施-14 F4）：与目标续行共用同一个槽位
     * （`goal-resume/<runnerId>.json`）与同一套防护（消费幂等、先写证据再发、
     * 发送方优先 ctx 后 pi）。宿主只写快照，**不再**用 `agent.send` ——
     * 那是真用户消息，会把交接包冒充成用户说的话，也会多出一个伪逻辑回合。
     */
    send: async (runId, text, resumeId) => {
      await host.goals.load()
      if (host.goals.isPaused(host.workModeKeyFor(runId))) return { ok: false, error: '目标已暂停' }
      const written = await writeGoalResumeSnapshotIfVacant(runId, {
        operationId: resumeId,
        at: Date.now(),
        kind: 'handoff',
        summary: text
      }).catch(() => false)
      if (!written) return { ok: false, error: '续行槽位正被另一个操作占用（等它被消费后重试）' }
      return { ok: true }
    },
    readSessionText: (sessionFile) => readFile(sessionFile, 'utf8'),
    notify: handoffAlert,
    /* 后台交接不抢用户当前视图（实施-14 F3） */
    shouldActivate: (sourceRunId) => host.runners()?.activeRunnerId === sourceRunId,
    /* 目的片段建好、resume 之前：继承模式与用户级目标事实（实施-14 F3） */
    onDestinationReady: async (info) => {
      for (const pending of handoffPending.values()) {
        if (pending.request.sessionKey === normalizeChainKey(info.sourceSession)) pending.destinationRunId = info.runId
      }
      await inheritForHandoff(info)
    },
    onLinked: publishHandoffReplacement
  })
}

/** 在 `configureHandoffCoordinator` 里建好（依赖宿主的事务与链存储）。 */
export let handoffRunner: HandoffRunner

export async function publishHandoffReplacement(sourceId: string, destId: string): Promise<void> {
  const pending = handoffPending.get(sourceId)
  const source = pending?.sourceState
  const state = host.runners()?.agentOf(destId)?.getState()
  const runtime = host.runners()?.runtimeOf(destId)
  if (!source || !state || !runtime) return
  const identity = {
    sessionId: state.sessionId,
    conversationId: source.conversationId ?? source.sessionId,
    conversationFile: source.conversationFile ?? source.sessionFile
  }
  handoffIdentities.set(destId, identity)
  const active = host.runners()?.publishReplacement(sourceId, destId) ?? false
  host.push({ ch: 'handoff-rebind', payload: {
    sourceRunId: sourceId, sourceSessionId: source.sessionId, runtime,
    state: { ...state, ...identity }, active
  } })
  host.pushRunners()
  await host.rememberRunnerSession({ ok: true, id: destId, sessionId: state.sessionId }, {
    cwd: state.cwd ?? '', projectId: runtime.projectId ?? undefined,
    scope: runtime.projectId ? 'project' : 'global'
  })
  await host.pushRunnerSnapshot(destId, { chainHistory: true })
}

/*
 * §8 的交接包由**模型写**（用户 2026-09-19 拍板），宿主只给提示与校验。分工：
 *   · 宿主：判资格 → 渲染提示词 → 写请求文件 → 轮询结果 → 解析 / 校验 / 落盘；
 *   · 薄层 `handoffs.js`：在 `agent_settled` 时读请求 → 调一次 completion → 写结果文件。
 *
 * 为什么提示词在**宿主**渲染：`renderHandoffPrompt` 是 TS，扩展用不了它；
 * 让扩展自己拼一份，等于把「交接包该有哪些字段」变成两处真源。
 */
export const handoffRequests = new HandoffRequestStore()

/**
 * 阈值覆盖（测试通道）。
 *
 * 真实链路要攒够两次**真实自动压缩**才会触发交接，而那是最贵的场景之一。
 * 把阈值压到 0 就能在不改任何生产逻辑的前提下把「判资格 → 写请求 → 薄层生成 →
 * 校验落盘」整条链跑一遍（`YAN_HANDOFF_THRESHOLD=0` 只在测试里设）。
 */
export const HANDOFF_THRESHOLD_EFFECTIVE = (() => {
  const raw = Number(process.env.YAN_HANDOFF_THRESHOLD)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : HANDOFF_AUTO_COMPACT_THRESHOLD
})()

/** 等薄层写包的会话（防重复 arm，也用来停轮询）。`request` 整份留着，校验时要用它的来源字段。 */
/**
 * 等薄层写包的会话（防重复 arm，也用来停轮询）。
 *
 * ⚠️ 每一项都是**一次具体操作**的所有权（实施-14 F2 / H2）：
 * `request.operationId` 是它的身份，`interval` / `timeout` 是它的两条定时器。
 * 回调醒来时必须先核对 `operationId` 仍是当前值 —— 否则一次旧操作
 * （提前完成、被替换、被停止）留下的超时会把**新**操作清掉。
 */
export interface HandoffPendingEntry {
  request: ReturnType<typeof buildHandoffRequest>
  interval: NodeJS.Timeout
  timeout: NodeJS.Timeout
  /** 写请求那一刻的目标身份（提交前复核：用户可能已经换了目标） */
  goalId: string
  /**
   * 「结果文件里的 id 与本次生成对不上」只记一条事件（实施-14 F0）。
   * 不设这个闸的话，一份遗留结果文件会让 1 秒一次轮询刷出 90 条同样的诊断。
   */
  mismatchNoted?: boolean
  collecting?: boolean
  settled?: Promise<void>
  settle?: () => void
  cancelled?: boolean
  destinationRunId?: string
  sourceState?: SessionState
}

export const handoffPending = new Map<string, HandoffPendingEntry>()
export const handoffIdentities = new Map<string, { sessionId: string; conversationId: string; conversationFile?: string }>()

export function hasHandoffOperation(id: string): boolean {
  return handoffPending.has(id) || [...handoffPending.values()].some((op) => op.destinationRunId === id)
}


/**
 * 资格评估的节流。
 *
 * `state` 推送很勤（流起停 / 用量刷新都推），而评估要 load 三份 store + 解析模式 ——
 * 每次推送都做一遍不值得。流式期间本来就在“忙”那一步早退了（不碰 IO），
 * 真正会走到这里的只有「回合刚结束」那一两次，1 秒窗口足够。
 */
export const handoffLastCheck = new Map<string, number>()
export const HANDOFF_CHECK_INTERVAL_MS = 1_000

/**
 * 常态资格拒绝的记账去重（实施-14 F8）—— 逻辑在 `shared/handoff-schedule.ts`，
 * 这里只持有实例。没有它，每次回合收尾都会记一条「还没压够次数」，
 * 很快就把 400 条的诊断环占满。
 */
export const handoffEligibilityLog = new EligibilityRejectLog()

/** 写包是一次额外模型调用：给 90 秒，之后放弃（会话该干什么干什么，不卡用户）。 */
export const HANDOFF_WAIT_MS = 90_000
export const HANDOFF_POLL_MS = 1_000

export function handoffNotify(id: string, message: string, notifyType: 'info' | 'warning' | 'error'): void {
  host.pushFrom(id, {
    ch: 'notify',
    payload: { id: `handoff-${Date.now()}`, method: 'notify', notifyType, message }
  })
}

/**
 * 判一次资格；够格就 arm 一次生成。返回「这次真的启动了生成」。
 *
 * `reason` 只进提示词与排障（哪条路径想起交接的）—— 资格本身按 §7 的四条走，
 * 与触发路径无关（压缩后 / 目标报告后都只是「再看一眼」）。
 *
 * ⚠️ 启动成功就**冻结源续跑**（§5.2「先登记操作所有权并冻结源续跑」）：
 * 既然要换片段，源片段就不该再 arm 一条新的「接着干」——
 * 否则交接与续跑同时在跑，谁先落地都不对。冻结只针对*未发出*的那一条；
 * 交接失败 / 放弃时会用 `maybeArmGoalContinue` 把续跑放回来。
 */
/** Native agents own context recovery; old automatic handoff callers cannot arm work. */
export async function tryArmHandoff(_id: string, _reason: string): Promise<boolean> { return false }

/**
 * 放弃一次生成（超时 / 用户插话 / 水位过期 / 会话结束）：清请求与结果，别让下一次交接拿到上一份遗物。
 *
 * `operationId` 是所有权校验（H2）：**旧操作的回调不许清理新操作**。
 * 不带它时按当前操作处理（内部调用点都带）。
 */
export async function abandonHandoff(id: string, why: string, operationId?: string): Promise<void> {
  const pending = handoffPending.get(id)
  if (!pending) return
  /* 旧操作的回调不许清理新操作（实施-14 H2） */
  if (!ownsHandoffOperation(pending.request.operationId, operationId)) return
  /*
   * 超时前的最后一次收集：薄层的模型调用上限是 60 秒，碰到长输出时
   * 结果可能刚好压线写盘 —— 这一读把「只差几十毫秒」的假超时挡掉
   * （否则用户看到失败提示，而包其实已经落盘了）。
   */
  if (why === 'timeout' && pending.collecting) {
    pending.timeout = setTimeout(() => void abandonHandoff(id, why, operationId), HANDOFF_POLL_MS)
    pending.timeout.unref?.()
    return
  }
  if (why === 'timeout' && (await collectHandoffResult(id, operationId))) return
  if (handoffPending.get(id) !== pending) return
  pending.cancelled = true
  clearInterval(pending.interval)
  clearTimeout(pending.timeout)
  if (!pending.collecting) handoffPending.delete(id)
  await handoffRequests.clearResult(id).catch(() => {})
  await handoffRequests.clearRequest(id).catch(() => {})
  if (why === 'timeout') {
    console.warn(
      `[handoff] 交接包生成超时：宿主等了 ${Math.round(HANDOFF_WAIT_MS / 1000)}s 也没等到结果（请求已清）`
    )
    handoffNotify(id, '交接包生成超时，已放弃（会话不受影响）', 'warning')
  }
  host.handoffDiag.record({
    stage: 'generate',
    outcome: 'abandoned',
    reason: why,
    op: pending.request.operationId,
    handoffId: pending.request.handoffId,
    runnerId: id,
    sessionKey: pending.request.sessionKey,
    detail: { waitedMs: HANDOFF_WAIT_MS }
  })
  /*
   * 冻结过的源续跑要放回来：交接没成，这一轮还得自己往下走。
   * 只调续跑入口（不再走完整调度）—— 否则会立刻重新判资格、再 arm 一次交接，
   * 形成「失败 → 重试 → 失败」的 90 秒循环。
   */
  void host.maybeArmGoalContinue(id).catch(() => undefined)
}

/**
 * 取结果：薄层写完结果文件后，这里校验并落盘。
 *
 * 三道闸门（与 §8 的「模型写、宿主校验」一致）：
 *   ① 结果必须是**这次**生成写的（`handoffId` + `operationId` 都对）；
 *   ② 原文要能解析出 JSON 对象；
 *   ③ 清洗必须过（两栏必填、列表形状合法、**来源字段由宿主覆盖**）。
 * 任何一道不过 → 丢掉这份包并告知用户，**不把半份包写进事务**。
 *
 * 返回值：是否「收到并处理了」这次生成的结果。`abandonHandoff` 超时前会再调一次 ——
 * 薄层可能刚好在边界写完（它自己也有 60 秒的模型时限），这一读能把
 * 「只差几十毫秒」的假超时挡掉。
 */
export async function collectHandoffResult(id: string, operationId?: string): Promise<boolean> {
  const pending = handoffPending.get(id)
  if (!pending) return false
  /*
   * 所有权校验（H2）：轮询与超时两条定时器都带自己的 `operationId`。
   * 旧操作的回调（比如上一次生成遗留的 interval）不能碰这一次的现场。
   */
  if (!ownsHandoffOperation(pending.request.operationId, operationId)) return false
  if (pending.collecting || pending.cancelled) return false
  pending.collecting = true
  pending.settled = new Promise<void>((resolve) => { pending.settle = resolve })
  let handled = false
  try {
    let result
    try {
      result = await handoffRequests.readResult(id)
    } catch {
      return false
    }
    if (handoffPending.get(id) !== pending || pending.cancelled) return false
    if (!result) return false
    if (result.handoffId !== pending.request.handoffId || result.operationId !== pending.request.operationId) {
      /*
       * 对不上就是「这份结果不是这次生成写的」：留在磁盘上等下次覆盖（不删别人的文件）。
       * 只在第一次记事件 —— 轮询每秒一次，不设闸会把一份遗留结果刷成几十条。
       */
      if (!pending.mismatchNoted) {
        pending.mismatchNoted = true
        host.handoffDiag.record({
          stage: 'generate',
          outcome: 'result-mismatch',
          reason: 'result-not-for-this-operation',
          op: pending.request.operationId,
          handoffId: pending.request.handoffId,
          runnerId: id,
          sessionKey: pending.request.sessionKey,
          detail: {
            gotHandoffId: result.handoffId,
            gotOperationId: result.operationId,
            ms: result.ms
          }
        })
      }
      return false
    }

    clearInterval(pending.interval)
    clearTimeout(pending.timeout)
    handled = true
    await handoffRequests.clearResult(id).catch(() => {})
    await handoffRequests.clearRequest(id).catch(() => {})

    const base = {
      op: pending.request.operationId,
      handoffId: pending.request.handoffId,
      runnerId: id,
      sessionKey: pending.request.sessionKey
    }

    if (result.error) {
      host.handoffDiag.record({ stage: 'generate', outcome: 'failed', reason: result.error, ...base, detail: { ms: result.ms } })
      handoffNotify(id, `交接包生成失败：${result.error.slice(0, 120)}`, 'error')
      return true
    }
    const parsed = parseHandoffOutput(result.text)
    if (!parsed.ok) {
      /*
       * 「模型不按格式答」与「包太长写不完」要分开报。
       *
       * 两者在这里长得一模一样（都是解析不出 JSON），但修法完全不同：
       * 前者是提示词/模型行为问题，后者**加预算就好**（扩预算的重试已经在扩展侧做过了，
       * 还走到这里说明连扩大后的预算都不够）。报成一个笼统原因，
       * 用户与后来的人都看不出是预算问题。
       */
      const cutByLength = result.truncated === true
      host.handoffDiag.record({
        stage: 'generate',
        outcome: 'unparsable',
        reason: cutByLength ? 'truncated' : parsed.reason,
        ...base,
        /* 只留长度，不留原文 —— 模型输出可能含用户内容 */
        detail: {
          chars: result.text.length,
          ms: result.ms,
          stopReason: result.stopReason ?? null,
          attempts: result.attempts ?? 1,
          truncated: cutByLength
        }
      })
      handoffNotify(
        id,
        cutByLength
          ? `上下文交接未完成：${handoffReasonText('truncated')}，将尝试在原会话继续`
          : `上下文交接未完成：${handoffReasonText(parsed.reason)}，将尝试在原会话继续`,
        'error'
      )
      return true
    }
    const problem = handoffContinuationProblem(parsed.value)
    if (problem) {
      host.handoffDiag.record({ stage: 'generate', outcome: 'incomplete', reason: problem, ...base })
      handoffNotify(id, '交接内容缺少剩余工作或下一步，保留原会话继续', 'error')
      return true
    }
    const pkg = sanitizeHandoffPackage(parsed.value, {
      sourceSession: pending.request.sessionKey,
      sourceHead: pending.request.sourceHead,
      mode: pending.request.mode,
      model: pending.request.model
    })
    if (!pkg) {
      host.handoffDiag.record({ stage: 'generate', outcome: 'incomplete', reason: 'missing-required-fields', ...base })
      handoffNotify(id, '交接包缺必填栏（目标 / 交付物），已丢弃这份', 'error')
      return true
    }
    try {
      await host.handoffs.setPackage(pending.request.sessionKey, pkg)
    } catch (error) {
      host.handoffDiag.record({
        stage: 'generate',
        outcome: 'persist-failed',
        reason: error instanceof Error ? error.message : String(error),
        ...base
      })
      handoffNotify(id, '交接包落盘失败，已放弃（下一次压缩后再试）', 'error')
      return true
    }
    host.handoffDiag.record({ stage: 'generate', outcome: 'package-ready', ...base, detail: { ms: result.ms, attempts: result.attempts ?? 1, stopReason: result.stopReason ?? null } })
    handoffNotify(id, `交接包已生成：${handoffSummary(pkg)}`, 'info')
    /* 开关打开时才真的往下走（§7：默认不自动交接，需用户拍板） */
    if (HANDOFF_COMMIT_ENABLED) {
      /*
       * `await`（不是 `void`）：提交完成前保留 pending，调度器据此冻结续行——
       * 提交的同时再跑一次调度决策，就会出现「一边停源建目的、一边 arm 续跑」。
       */
      await commitHandoff({
        runnerId: id,
        handoffId: pending.request.handoffId,
        operationId: pending.request.operationId,
        sessionKey: pending.request.sessionKey,
        goalId: pending.goalId,
        sourceHead: pending.request.sourceHead,
        pkg
      })
    }
    return true
  } finally {
    pending.collecting = false
    if ((handled || pending.cancelled) && handoffPending.get(id) === pending) {
      handoffPending.delete(id)
      if (!pending.cancelled) await host.maybeArmGoalContinue(pending.destinationRunId ?? id).catch(() => undefined)
    }
    pending.settle?.()
  }
}

/**
 * 提交前的复核（实施-14 F2 / §5.2）。
 *
 * 为什么不能把「写包那一刻的结论」当成立：写包是一次额外模型调用（最长 90 秒），
 * 这期间用户完全可能插话、按停止、改档、换目标，或切到别的会话。
 * 拿一个过期的包去停源换段，轻则把用户新输入留在旧片段，
 * 重则停掉刚被用户接管的实例。
 *
 * 五个条件（任一不成立就放弃这一次交接，保留包与源会话）：
 *   ① 操作身份没被替换（新的生成没有顶替它）；
 *   ② 实例存在且真的空闲（安全边界）；
 *   ③ 实例仍指向源会话（没被切走）；
 *   ④ 目标仍是在推进的那一个，且档位仍允许自己跑（自主档或 pursue）——用户意图未变；
 *   ⑤ 源会话水位未前进（用户没插话）。
 */
export async function revalidateHandoff(input: {
  runnerId: string
  operationId: string
  sessionKey: string
  goalId: string
  sourceHead: string | null
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pending = handoffPending.get(input.runnerId)
  if (!pending || pending.cancelled) return { ok: false, reason: 'operation-cancelled' }
  if (pending.request.operationId !== input.operationId) return { ok: false, reason: 'operation-replaced' }
  const agent = host.runners()?.agentOf(input.runnerId)
  const state = agent?.getState()
  if (!agent || !state) return { ok: false, reason: 'runner-gone' }
  if (state.isAgentRunning || state.isStreaming) return { ok: false, reason: 'not-idle' }
  /* 源会话键：`workModeKeyFor` 读的就是实例当前段落，比对即可看出“用户切走了” */
  if (host.workModeKeyFor(input.runnerId) !== input.sessionKey) return { ok: false, reason: 'source-session-changed' }
  await host.goals.load()
  if (host.goals.isPaused(input.sessionKey)) return { ok: false, reason: 'user-paused' }
  const goal = host.goals.state(input.sessionKey)
  if (!isActiveGoalPhase(goal.phase) || (goal.goalId ?? '') !== input.goalId) {
    return { ok: false, reason: 'goal-changed' }
  }
  const mode = await host.resolveWorkMode(input.runnerId)
  if (!keepsGoalResumeOnModeChange(mode.mode, goal.pursue === true)) return { ok: false, reason: 'mode-changed' }
  let head: string | null
  try {
    head = (await agent.getMessages()).at(-1)?.id ?? null
  } catch {
    /* 拿不到历史就不断水位判（宁可放过，不因为读失败而卡住交接） */
    return { ok: true }
  }
  if ((input.sourceHead ?? null) !== head) return { ok: false, reason: 'source-watermark-moved' }
  return { ok: true }
}

/**
 * 把一份刚生成的交接包推入事务（§8 第 3–6 步）。
 *
 * 触发点与「生成」同一处（包落盘之后）：生成是资格判定的结果，而
 * 「够格」与「愿意真的换会话」是两件事 —— 后者由开关控制。
 *
 * cwd / projectId 从**源实例当时的状态**取：交接的意思是「同一个项目继续」，
 * 不是「在当前设置的项目里继续」。
 */
export async function commitHandoff(input: {
  runnerId: string
  handoffId: string
  operationId: string
  sessionKey: string
  goalId: string
  sourceHead: string | null
  pkg: HandoffPackage
}): Promise<void> {
  const agent = host.runners()?.agentOf(input.runnerId)
  const state = agent?.getState()
  if (!agent || !state) return
  const operation = handoffPending.get(input.runnerId)
  if (operation) operation.sourceState = { ...state, ...handoffIdentities.get(input.runnerId) }
  const verdict = await revalidateHandoff(input)
  if (!verdict.ok) {
    host.handoffDiag.record({
      stage: 'safety-boundary',
      outcome: 'rejected',
      reason: verdict.reason,
      op: input.operationId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey
    })
    /* 过期的包不提交：放弃这次操作（保留包，下次判定再看）并把续跑放回来 */
    await abandonHandoff(input.runnerId, verdict.reason, input.operationId)
    return
  }
  const cwd = state.cwd ?? ''
  const settings = await getSettings()
  const projectId = host.projectIdForCwd(settings, cwd)
  host.handoffDiag.record({
    stage: 'commit',
    outcome: 'started',
    op: input.handoffId,
    handoffId: input.handoffId,
    runnerId: input.runnerId,
    sessionKey: input.sessionKey,
    detail: { cwd, projectId: projectId ?? null }
  })
  try {
    const result = await handoffRunner.commit({
      handoffId: input.handoffId,
      sourceRunId: input.runnerId,
      sourceSession: input.sessionKey,
      cwd,
      ...(projectId ? { projectId } : {}),
      pkg: input.pkg,
      canContinue: () => {
        const op = handoffPending.get(input.runnerId)
        return !!op && op.request.operationId === input.operationId && !op.cancelled && !host.goals.isPaused(input.sessionKey)
      }
    })
    if (operation?.cancelled && operation.destinationRunId) {
      await host.goals.setPaused(host.workModeKeyFor(operation.destinationRunId), true)
      await host.cancelGoalResume(operation.destinationRunId)
    }
    if (!result.ok) {
      console.log(`[handoff] 交接停在 ${result.stage}：${result.error ?? ''}`)
      /*
       * `committed` 不是失败：resume 已发出但磁盘证据未到（或发送失败），
       * 下次启动恢复会按证据补记 / 重发。这个区别必须在诊断里看得出来。
       */
      host.handoffDiag.record({
        stage: result.stage === 'committed' ? 'resume' : 'commit',
        outcome: result.stage === 'committed' ? 'unconfirmed' : 'halted',
        reason: result.error ?? result.stage,
        op: input.handoffId,
        handoffId: input.handoffId,
        runnerId: input.runnerId,
        sessionKey: input.sessionKey,
        detail: { stage: result.stage, destination: result.destinationSession ?? null }
      })
      return
    }
    host.handoffDiag.record({
      stage: 'commit',
      outcome: 'ok',
      op: input.handoffId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey,
      detail: { stage: result.stage, destination: result.destinationSession ?? null }
    })
    /* 用户级状态（模式 / 目标 / 暂停）已在 `onDestinationReady` 继承过 —— 比 resume 早 */
    host.handoffDiag.record({
      stage: 'resume',
      outcome: 'resume-confirmed',
      op: input.handoffId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey,
      detail: { destination: result.destinationSession ?? null }
    })
  } catch (error) {
    console.error('[handoff] 交接执行失败：', error)
    host.handoffDiag.record({
      stage: 'commit',
      outcome: 'threw',
      reason: error instanceof Error ? error.message : String(error),
      op: input.handoffId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey
    })
  }
}

/**
 * 交接之后把**工作模式**带到目的会话（实施-05 S6 联调）。
 *
 * 为什么模式继承、而目标状态（goal）不继承：
 *   · 模式是**用户对这条会话的意图**（「这个长任务让它自己往下跑」），
 *     交接的是同一条会话的下一段 —— 掉回默认档会让自主续接（S3c）当场失效；
 *   · goal 是「这一轮做到哪」的**事实**，§8 明写不能把旧总结升级成事实，
 *     所以由模型按交接包重新登记（resume 正文里有明确要求，也有单测钉着）。
 */
/**
 * 交接后把**用户级状态**带到目的片段（实施-14 F3）。
 *
 * 时机是硬要求：由 `HandoffRunner` 在 `destination-created` 之后、**发 resume 之前**调用。
 * 旧实现在 `commit()` 返回之后才做，而且写的是**当前 active runner** 的快照 ——
 * 于是目的片段第一轮按默认档 / 空目标启动，后台交接时还会把模式写到别的实例上。
 *
 * 继承两件事：
 *   · 工作模式（用户对这条会话的意图：自主档不能被交接降级）；
 *   · 宿主级目标事实（目标 / 验收标准 / pursue / 暂停）—— 见 `GoalStore.inheritTo`。
 * 模型写的 done/remaining 不进宿主事实，由交接包按摘要交给下一个片段。
 */
export async function inheritForHandoff(info: {
  sessionFile: string
  runId: string
  sourceSession: string
}): Promise<void> {
  const destKey = normalizeChainKey(info.sessionFile)
  const sourceKey = normalizeChainKey(info.sourceSession)
  if (!destKey || !sourceKey || sourceKey === destKey) return
  let modeInherited = false
  try {
    await host.workModes.load()
    const source = host.workModes.state(sourceKey, host.defaultWorkMode())
    /* 源本来就是默认档（无记录）→ 目的不必落键，保持「默认态不写盘」的约定 */
    if (!(source.revision === 0 && source.mode === host.defaultWorkMode())) {
      modeInherited = (await host.workModes.set(destKey, source.mode)).ok
    }
  } catch {
    /* 继承失败不阻断交接：下一轮按默认档起步也能继续 */
  }
  let goalInherited = false
  try {
    goalInherited = await host.goals.inheritTo(sourceKey, destKey)
  } catch {
    /* 同上 */
  }
  /*
   * 快照必须写给**目的 runner**：薄层只认 `work-mode/<runnerId>.json` 与
   * `goal-resume/<runnerId>.json`，写给 active runner 时后台交接会串到别人身上。
   */
  try {
    const state = await host.resolveWorkMode(info.runId)
    await writeWorkModeSnapshot(info.runId, state)
    /* 目的段的续行由交接那条 resume 驱动，源片段残留的「接着干」不许跟过来 */
    await host.applyGoalResume(info.runId)
  } catch {
    /* 快照写失败时扩展会回退到默认档；不能让继承失败把交接拖死 */
  }
  host.handoffDiag.record({
    stage: 'resume',
    outcome: 'state-inherited',
    runnerId: info.runId,
    sessionKey: destKey,
    detail: { modeInherited, goalInherited, source: sourceKey }
  })
}
