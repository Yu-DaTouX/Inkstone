/**
 * 会话级任务状态与目标续跑调度：工作模式、活动档案、目标与续行快照，
 * 以及自主档「回合收尾后自动接着推进目标」的判定与发起。
 *
 * 状态按会话文件路径作键（`workModeKeyFor`），桌面 IPC、`yan goal` 能力服务、
 * 交接协调与会话调度器都读写同一份；入口在启动前用 `configureGoalCoordinator`
 * 接上运行注册表、各存储与推送。
 */
import type { RunnerRegistry } from './runners'
import { readTurnTimings, timingKey } from './turn-timing-store'
import { hasHandoffOperation } from './handoff-coordinator'
import { GoalStore, goalResumeContinuationWasConsumed, writeGoalResumeSnapshot } from './goal-service'
import { AUTONOMOUS_CONTINUE_LIMIT, isActiveGoalPhase } from '../shared/goal'
import type { BudgetUsage } from '../shared/goal'
import { YAN_DIR } from './paths'
import { normalizeSessionFileKey, pendingWorkModeKey, writeWorkModeSnapshot } from './work-mode-service'
import { pendingAgentProfileKey, writeAgentProfileSnapshot } from './agent-profile-store'
import { DEFAULT_AGENT_PROFILE } from '../shared/agent-profile'
import type { AgentProfileState } from '../shared/agent-profile'
import type { AssembleContextRequest } from './context-assembler'
import { currentTaskPlan } from './task-plan-store'
import { DEFAULT_WORK_MODE } from '../shared/work-mode'
import type { WorkMode, WorkModeState } from '../shared/work-mode'
import type { WorkModeStore } from './work-mode-service'
import type { AgentProfileStore } from './agent-profile-store'
import type { SpaceStore } from './space-store'
import type { ContextAssembler } from './context-assembler'
import type { HandoffDiagnostics } from './handoff-diagnostics'
import type { MainPush } from '../shared/ipc'

export interface GoalHost {
  runners(): RunnerRegistry | null
  workModes: WorkModeStore
  agentProfiles: AgentProfileStore
  spaces: SpaceStore
  contextAssembler: ContextAssembler
  handoffDiag: HandoffDiagnostics
  pushFrom(runnerId: string, msg: MainPush): void
}

let host: GoalHost

/** 入口启动时调用一次；在此之前不会有会话读写这些状态。 */
export function configureGoalCoordinator(next: GoalHost): void {
  host = next
}

/** 设置里的默认工作模式变化时（启动 / 改设置）同步到这里。 */
export function setDefaultWorkMode(mode: WorkMode): void {
  agentDefaultWorkMode = mode
}

export function defaultWorkMode(): WorkMode {
  return agentDefaultWorkMode
}

/**
 * 新会话的默认工作模式（`desktop.json.defaultWorkMode`）。
 *
 * 缓存一份的理由与 `agentResponseDetail` 相同：读取路径里不能到处 await
 * `getSettings()`；两个写入点（启动 / 改设置）会同步它。
 */
let agentDefaultWorkMode: WorkMode = DEFAULT_WORK_MODE

/**
 * 运行实例当前该读哪个键。
 *
 * ⚠️ 优先**会话文件路径**，不用 `state.sessionId`：实测切走再切回同一份
 * 会话文件时，pi 报回的 sessionId 会变（文件还是那个文件）—— 用 sessionId 作
 * 键会让用户刚设的模式在切换后当场丢回默认值（真实链路抽到的，见探针第 5 节）。
 * 文件路径在 pi 给出之前用 `pending:<runnerId>` 占位，拿到后再迁移。
 */
/**
 * 目标到目前为止的用量（A-2）。
 *
 * 口径写在这里，免得以后被当成「总共花了多少」：
 *   · 只算**目标开始之后**的回合（`GoalStore.startOf`）——同一个会话可以先后
 *     做多个目标；
 *   · 只累加模型真报出来的 output token（H-6b 的 `usage.output`）；输入侧没有
 *     可靠来源，**不估算、不编数字**；
 *   · 一条 usage 都没有 → `tokens: null`，界面显示“未知”而不是 0。
 *
 * 拿不到会话文件时返回 `undefined` —— 装配方明确说“我无法判定”，
 * 而不是给一个看着像 0 的数字（0 会让预算永不触发）。
 */
export async function goalBudgetUsage(id: string, startedAt: number): Promise<BudgetUsage | undefined> {
  const sessionFile = host.runners()?.agentOf(id)?.getState()?.sessionFile
  const bucket = timingKey(sessionFile)
  if (!bucket) return undefined
  const records = await readTurnTimings(YAN_DIR, bucket).catch(() => [])
  if (!records.length) return undefined
  const since = startedAt > 0 ? startedAt : 0
  /*
   * 只算**目标开始之后**的回合，并且只累加 provider 真的报了的 output token（H-6b 已落盘）。
   * 一条都没报 → `tokens: null`（未知），让界面显示未知、判定也不因此停。
   */
  const inGoal = records.filter((r) => (r.startedAt ?? 0) >= since)
  const reported = inGoal.filter((r) => typeof r.outputTokens === 'number')
  return {
    tokens: reported.length ? reported.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0) : null,
    elapsedMs: since > 0 ? Date.now() - since : 0
  }
}

export function workModeKeyFor(id: string): string {
  const file = normalizeSessionFileKey(host.runners()?.agentOf(id)?.getState()?.sessionFile)
  return file ?? pendingWorkModeKey(id)
}

/**
 * 解析一个运行实例当前会话的模式，并顺手把 pending 键迁到稳定键。
 *
 * 迁移放在这里而不是「会话建立事件」里：稳定键何时出现由 pi 决定，
 * 而读模式的所有调用点都已经拿到过实例 —— 在这里做能保证「第一次读」
 * 就一定是对的键，不会出现“刚答完的会话又被当成新会话”。
 */
export async function resolveWorkMode(id: string): Promise<WorkModeState> {
  await host.workModes.load()
  const stable = normalizeSessionFileKey(host.runners()?.agentOf(id)?.getState()?.sessionFile)
  const pendingKey = pendingWorkModeKey(id)
  if (!stable) return host.workModes.state(pendingKey, agentDefaultWorkMode)
  if (host.workModes.snapshot().entries[pendingKey]) await host.workModes.adopt(pendingKey, stable)
  return host.workModes.state(stable, agentDefaultWorkMode)
}

/**
 * 把该实例的当前模式写给模型侧并推给界面。
 *
 * 两个出口一次做完，否则会出现「界面已自主而扩展仍标准」：
 *   · `work-mode/<runnerId>.json` —— 薄层扩展只认 `YAN_SESSION_ID`（= runner id），
 *     文件缺失 / 读不到时它回退到旧 `autonomous` 或标准模式；
 *   · `work-mode` 推送 —— 带 `runtime` 封套，后台会话切模式不会串到当前视图。
 */
export async function pushWorkMode(id: string): Promise<WorkModeState> {
  const state = await resolveWorkMode(id)
  await goals.load()
  const planApprovalPending = goals.state(workModeKeyFor(id)).pendingReady !== null
  await writeWorkModeSnapshot(id, { ...state, planApprovalPending }).catch(() => {})
  host.pushFrom(id, { ch: 'work-mode', payload: state })
  return state
}

/** 新会话的默认活动档案：仍然是代码助手，已有行为不变。 */
export const agentDefaultProfile = DEFAULT_AGENT_PROFILE

/** 该实例的档案键（与 `workModeKeyFor` 同一口径；键必须一致，否则切会话会串）。 */
export function agentProfileKeyFor(id: string): string {
  const file = normalizeSessionFileKey(host.runners()?.agentOf(id)?.getState()?.sessionFile)
  return file ?? pendingAgentProfileKey(id)
}

/** 读该实例的档案，并把 pending 键迁到稳定键（与 `resolveWorkMode` 同一时机）。 */
export async function resolveAgentProfile(id: string): Promise<AgentProfileState> {
  await host.agentProfiles.load()
  const stable = normalizeSessionFileKey(host.runners()?.agentOf(id)?.getState()?.sessionFile)
  const pendingKey = pendingAgentProfileKey(id)
  if (!stable) return host.agentProfiles.state(pendingKey, agentDefaultProfile)
  if (host.agentProfiles.state(pendingKey, agentDefaultProfile).revision > 0) {
    await host.agentProfiles.adopt(pendingKey, stable)
  }
  return host.agentProfiles.state(stable, agentDefaultProfile)
}

/**
 * 把该实例的档案写给模型侧并推给界面。
 *
 * 与 `pushWorkMode` 同一个理由：薄层扩展只能从 `agent-profile/<runnerId>.json`
 * 知道自己的角色，两份出口不能分家（否则会出现「界面显示导师、模型仍是代码助手」）。
 */
export async function pushAgentProfile(id: string): Promise<AgentProfileState> {
  const state = await resolveAgentProfile(id)
  await writeAgentProfileSnapshot(id, state).catch(() => {})
  host.pushFrom(id, { ch: 'agent-profile', payload: state })
  await refreshSessionContext(id, state)
  return state
}

/**
 * 刷新这个会话本轮注入的上下文分区（实施-25 P05 / T05-3）。
 *
 * 挂在 `pushAgentProfile` 后：切会话 / 新建 / 启动 / 改档案都经这一处，
 * 上下文与档案用同一个交接时机（否则会出现「界面改了活动、注入的还是上一个」）。
 * 写盘失败由 assembler 内部吞掉 —— 上下文是增强，不该拦着一轮对话。
 *
 * **偏好分区刻意不填**：语言与详细程度已有各自的薄层扩展在每轮读设置注入，
 * 在这里再带一份就是第二个真源（P01 已经为角色文本定过同一条边界）。
 */
export async function refreshSessionContext(id: string, state: AgentProfileState): Promise<void> {
  await host.contextAssembler.assembleAndWrite(id, await buildContextRequest(id, state))
}

/**
 * 构造这个会话本轮的装配请求（T05-3）。
 *
 * `coding` 档案返回**空请求**（不注入任何内容）—— 与「coding 不注入角色」
 * 同一条边界：非 daily 会话保持 pi 原生行为。同时这次空装配会覆盖上一轮快照，
 * 避免从 daily 切回 coding 后残留日常的来源片段。
 */
export async function buildContextRequest(id: string, state: AgentProfileState): Promise<AssembleContextRequest> {
  if (state.profile !== 'daily') return { activity: state.activity }

  const sessionId = host.runners()?.agentOf(id)?.getState()?.sessionId

  let task: string | undefined
  try {
    await goals.load()
    const goal = goals.state(workModeKeyFor(id))
    const parts: string[] = []
    if (goal.brief?.goal) parts.push(`目标：${goal.brief.goal}`)
    if (goal.brief?.outcome) parts.push(`达成判据：${goal.brief.outcome}`)
    if (goal.brief?.deliverable) parts.push(`交付物：${goal.brief.deliverable}`)
    if (goal.blocker) parts.push(`当前阻碍：${goal.blocker}`)
    if (sessionId) {
      const plan = await currentTaskPlan(sessionId).catch(() => null)
      const open = (plan?.state.todos ?? []).filter((t) => !t.done)
      if (open.length) parts.push(`待办：${open.slice(0, 5).map((t) => t.text).join('；')}`)
    }
    if (parts.length) task = parts.join('\n')
  } catch {
    /* 目标 / 任务读不到就不带这两段，不影响这一轮 */
  }

  let space: string | undefined
  try {
    if (state.spaceId) {
      await host.spaces.load()
      const found = host.spaces.find(state.spaceId)
      if (found) space = found.description ? `${found.name}：${found.description}` : found.name
    }
  } catch {
    /* 空间读不到同理 */
  }

  return {
    activity: state.activity,
    ...(sessionId ? { sessionId } : {}),
    ...(task ? { task } : {}),
    ...(space ? { space } : {})
  }
}

/** 把该实例当前会话的目标 / 计划事实快照推给右栏。 */
export async function pushGoal(id: string): Promise<void> {
  await goals.load()
  const state = goals.state(workModeKeyFor(id))
  const mode = await resolveWorkMode(id)
  await writeWorkModeSnapshot(id, { ...mode, planApprovalPending: state.pendingReady !== null }).catch(() => {})
  host.pushFrom(id, { ch: 'goal', payload: state })
  /* 目标 / 待办变了，本轮注入的「任务与阶段」也得跟着变（T05-3） */
  await refreshSessionContext(id, await resolveAgentProfile(id))
}

/**
 * 把该实例的「待发续行」写给薄层（实施-05 S3b）。
 *
 * 与模式快照同一个理由：`goals.json` 按**会话文件路径**索引，
 * 而扩展只认自己是哪个 runner（`YAN_SESSION_ID`）。
 */
export async function applyGoalResume(id: string): Promise<void> {
  await goals.load()
  await writeGoalResumeSnapshot(id, goals.resumeOf(workModeKeyFor(id))).catch(() => {})
}

/**
 * 抦销未发续行（用户停止 / 用户改档）。
 *
 * ⚠️ 必须连**快照**一起清：扩展只读快照，不读 `goals.json` ——
 * 只清后者等于没清，下一轮它照发。
 */
export async function cancelGoalResume(id: string): Promise<void> {
  await goals.load()
  await goals.clearResume(workModeKeyFor(id)).catch(() => {})
  await writeGoalResumeSnapshot(id, null).catch(() => {})
}

/**
 * 把薄层「重复动作被拦下」的计数计入目标失败签名（2026-09-22）。
 *
 * 薄层只写得到计数文件（没有 `yan` CLI，也不该知道目标存储），所以这一步在宿主：
 * 读 `<YAN_DATA_DIR>/repeat-guard/<runnerId>.json` → 对差值各记一次固定签名失败。
 * 同一签名连续两次 → `blocked`（与 §5 的失败签名同一套阈值，见 `shared/goal.ts`）。
 *
 * 失败不影响回合收尾（没有计数文件 / 目标不在推进期都是正常的）。
 */
export async function consumeRepeatBlocks(id: string): Promise<void> {
  const key = workModeKeyFor(id)
  const changed = await goals.consumeRepeatBlocks(id, key).catch((err: unknown) => {
    console.error('[goal] 重复动作计数计入失败签名失败：', err)
    host.handoffDiag.record({
      stage: 'goal-continue',
      outcome: 'repeat-guard-failed',
      reason: err instanceof Error ? err.message : String(err),
      runnerId: id,
      sessionKey: key
    })
    return false
  })
  if (!changed) return
  const goal = goals.state(key)
  console.log(
    `[goal] 重复动作被拦下已计入失败签名（会话 ${id}）：phase=${goal.phase} failure=${goal.failure?.count ?? 0}`
  )
  host.handoffDiag.record({
    stage: 'goal-continue',
    outcome: isActiveGoalPhase(goal.phase) ? 'repeat-counted' : 'blocked-by-repeat',
    runnerId: id,
    sessionKey: key,
    detail: { phase: goal.phase, failures: goal.failure?.count ?? 0 }
  })
  /*
   * 进终态就把薄层可见的续行一并清掉（实施-14 A1）：
   * 只清 `goals.json` 不够 —— 快照里那条「接着干」会照样发出去，
   * 把模型重新叫起来干刚被拦下的那件事。
   */
  if (!isActiveGoalPhase(goal.phase)) await applyGoalResume(id)
  host.pushFrom(id, { ch: 'goal', payload: goal })
}

/**
 * 目标状态（实施-05 S3）的存储。
 *
 * 为什么与模式分两份文件：模式是「用户选什么」（低频、界面驱动），目标是
 * 「这一轮做到哪」（高频、模型驱动、带幂等记录）—— 混在一份里会让
 * 模式那份承担两个写者的并发语义。
 */
export const goals = new GoalStore()

/*
 * 自主档的兜底续接（S3c）。
 *
 * 模型通常会在工具回合里调用 `yan goal report`，但这不是可靠的唯一出口：
 * 它可能只给出一段普通文本，或因同一个 reportId 重试而让旧实现返回
 * `autoContinueArmed: false`。回合真正空闲后，如果目标仍在推进、模式仍是
 * 自主、且上一条续行已经被消费，就再补 arm 一次。串行闸门避免多条 state
 * 推送把同一轮 arm 两次；用户停止 / 改档仍通过上面的取消路径优先生效。
 */
export const autonomousArmInFlight = new Set<string>()

export async function maybeArmGoalContinue(id: string): Promise<void> {
  if (autonomousArmInFlight.has(id)) return
  /* 交接正在准备包：源续跑已被冻结（H1）——即便有人绕过调度器直接调这里，也不能破 */
  if (hasHandoffOperation(id)) return
  autonomousArmInFlight.add(id)
  try {
    const mode = await resolveWorkMode(id)

    await goals.load()
    const key = workModeKeyFor(id)
    const goal = goals.state(key)
    if (!goal.goalId || !isActiveGoalPhase(goal.phase) || goal.revision <= 0 || goal.pendingReady) return
    /*
     * 谁有资格被自动叫醒（2026-09-22）：
     *   · 自主档 —— 档位本身就意味着「接着干」；
     *   · 或者目标带 `pursue`（用户在 `+` 菜单里明确设定的持续目标）——
     *     那是**目标**语义，与档位正交，所以标准 / 计划档下也要继续推进。
     */
    if (mode.mode !== 'autonomous' && !goal.pursue) return

    const resume = goals.resumeOf(key)
    if (resume) {
      /* 还没消费的续行仍交给 goal-resume 扩展，不能覆盖它。 */
      if (resume.kind !== 'continue') return
      if (!(await goalResumeContinuationWasConsumed(id, resume.operationId))) return
      /* 旧的 continue 已消费，当前空闲回合需要一个新的 operationId。 */
    }

    /*
     * `paused`（用户按过停止）与 `pending`（已有未消费的续行）都在这一层取。
     * 两者都是「本次不 arm」的正常状态，不记事件（每次回合收尾都会走到，记了只会刷屏）。
     * 用户停止那一次由 `yan:abort` 的 `goal-continue:cancelled` 负责留痕。
     */
    if (hasHandoffOperation(id)) return
    const armed = await goals.armContinue(key, {
      consumed: (operationId) => goalResumeContinuationWasConsumed(id, operationId),
      usage: await goalBudgetUsage(id, goals.startOf(key))
    })
    if (armed.armed) {
      await applyGoalResume(id)
      await pushGoal(id)
      host.handoffDiag.record({
        stage: 'goal-continue',
        outcome: 'armed',
        reason: 'settled-fallback',
        runnerId: id,
        sessionKey: key,
        detail: { round: armed.round, mode: mode.mode, pursue: goal.pursue === true }
      })
    } else if (armed.reason === 'limit') {
      /* 到上限是**要让用户看见**的暂停原因（A6）：arm 不会再发生，所以每次收尾都记 */
      host.handoffDiag.record({
        stage: 'goal-continue',
        outcome: 'limit',
        reason: 'autonomous-continue-limit',
        runnerId: id,
        sessionKey: key,
        detail: { round: armed.round, limit: AUTONOMOUS_CONTINUE_LIMIT }
      })
    }
  } catch (error) {
    /* 自动兜底是增强路径；失败时保留目标状态，不让它影响当前会话 —— 但要留痕 */
    host.handoffDiag.record({
      stage: 'goal-continue',
      outcome: 'arm-threw',
      reason: error instanceof Error ? error.message : String(error),
      runnerId: id
    })
  } finally {
    autonomousArmInFlight.delete(id)
  }
}
