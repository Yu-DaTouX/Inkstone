/**
 * 会话后台工作的调度服务：回合收尾后「接下来做什么」只在这里决定。
 *
 * 职责（从 index.ts 抽出，行为不变）：
 *   · 每个 runner 一条串行工作链：交接、目标续跑、重复拦下的补记按优先级在同一条链里判定，
 *     不再各自 `void` 起跑；
 *   · 模型报错后的自动继续：计数落盘（AutoContinueStore）、退避定时、学习等待闸；
 *   · 从运行推送里识别调度时机（回合结束、模型报错、一轮真的产出）。
 *
 * 它不持有窗口、IPC 或 pi 进程：需要的能力都经 `SessionWorkDeps` 注入。
 * 这样桌面 IPC、远程入口（以及以后的手机入口）触发的后台工作走同一套规则，
 * 不必在第二个入口里复制一份调度逻辑。
 */
import { randomUUID } from 'node:crypto'
import type { MainPush, SessionState } from '../shared/ipc'
import { decideSessionWork } from '../shared/handoff-schedule'
import { retryResumeSummary, type AutoContinuePlan } from '../shared/auto-continue'
import type { AutoContinueStore } from './auto-continue-service'

export interface SessionWorkDeps {
  /** 当前实例状态；实例不存在时返回 null */
  stateOf(id: string): SessionState | null
  /** 交接操作是否仍在进行（含作为交接目标的实例） */
  hasHandoffOperation(id: string): boolean
  /** 交接现场是否仍挂着（重复拦下可能在中途清掉它） */
  handoffPending(id: string): boolean
  consumeRepeatBlocks(id: string): Promise<void>
  /** 满足资格时发起交接；发起了返回 true */
  tryArmHandoff(id: string, reason: string): Promise<boolean>
  maybeArmGoalContinue(id: string): Promise<void>
  /** 会话的工作模式键（自动继续计数按它落盘）；没有时不做自动继续 */
  workModeKeyFor(id: string): string | null
  autoContinues: AutoContinueStore
  /** 自动继续的有效上限（测试通道可覆盖） */
  autoContinueLimit: number
  /** 学习练习是否正等着用户作答（等待时不把模型叫起来） */
  studyGateBlocks(id: string): Promise<boolean>
  /** 写「待发续行」快照；薄层在回合空闲时据此发一条 custom 消息 */
  writeRetrySnapshot(id: string, snapshot: { operationId: string; at: number; kind: 'retry'; summary: string }): Promise<void>
  notify(id: string, message: string, notifyType: 'info' | 'warning' | 'error', idPrefix: string): void
}

export interface SessionWorkScheduler {
  /** 把一次「回合空下来之后看看要不要做事」排进该会话的串行链 */
  schedule(id: string, reason: string): Promise<void>
  /** 运行推送的调度钩子：回合结束 → 排工作；模型报错 → 自动继续；真的产出 → 计数归零 */
  observePush(id: string, msg: MainPush): void
  /** 用户发言 / 停止 / 一轮成功 → 失败计数归零（并撤掉待发的自动继续） */
  resetAutoContinue(id: string): Promise<void>
  cancelAutoContinue(id: string): void
  /** 是否有待发的自动继续（调度判定用） */
  hasPendingAutoContinue(id: string): boolean
}

export function createSessionWorkScheduler(deps: SessionWorkDeps): SessionWorkScheduler {
  /* 串行链按 runnerId 分开：不同会话之间没有共享状态，没必要互相阻塞 */
  const tails = new Map<string, Promise<void>>()
  /*
   * 待发的自动继续（每个 runner 至多一个）。
   * 用 token 而不是只存 timer：延时期间用户可能发话 / 按停止，条目会被换掉或删掉 ——
   * 回调醒来时先验明正身，避免「取消之后还是发了」。
   */
  const timers = new Map<string, { timer: NodeJS.Timeout; token: string }>()

  async function run(id: string, reason: string): Promise<void> {
    const state = deps.stateOf(id)
    if (!state) return
    const decision = decideSessionWork({
      busy: state.isAgentRunning === true || state.isStreaming === true,
      handoffPending: deps.hasHandoffOperation(id),
      errorRetryPending: timers.has(id),
      handoffAllowed: true
    })
    /* 三个 `wait-*` 都是「现在不做决定」（安全边界未到 / 已有更高优先级的事） */
    if (decision === 'wait-busy' || decision === 'wait-error-retry' || decision === 'wait-handoff') return
    /* 重复拦下先计入：它可能把目标打成 blocked（终态），那就不能 arm 任何东西 */
    await deps.consumeRepeatBlocks(id).catch(() => undefined)
    /* 它可能改掉交接现场（目标终态会清续行），再核一次 */
    if (deps.handoffPending(id)) return
    if (await deps.tryArmHandoff(id, reason)) return
    await deps.maybeArmGoalContinue(id).catch(() => undefined)
  }

  function schedule(id: string, reason: string): Promise<void> {
    const previous = tails.get(id) ?? Promise.resolve()
    const next = previous.then(
      () => run(id, reason),
      () => run(id, reason)
    )
    tails.set(id, next)
    void next.finally(() => {
      if (tails.get(id) === next) tails.delete(id)
    })
    return next.catch(() => undefined)
  }

  function cancelAutoContinue(id: string): void {
    const entry = timers.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    timers.delete(id)
  }

  async function resetAutoContinue(id: string): Promise<void> {
    cancelAutoContinue(id)
    const key = deps.workModeKeyFor(id)
    if (!key) return
    try {
      await deps.autoContinues.load()
      await deps.autoContinues.reset(key)
    } catch {
      /* 归零失败不影响会话：下一次错误会再试 */
    }
  }

  /*
   * 退避在宿主而不在薄层：薄层的 1.8s 只是「确认回合真的空闲」，
   * 与「上游刚挂了、给它几秒再试」是两件事，混在一起就调不动了。
   */
  function scheduleAutoContinue(id: string, plan: Extract<AutoContinuePlan, { action: 'retry' }>): void {
    cancelAutoContinue(id)
    const token = randomUUID()
    const timer = setTimeout(() => {
      const current = timers.get(id)
      if (!current || current.token !== token) return
      timers.delete(id)
      void (async () => {
        /* 延时期间学习练习可能刚好在等作答：这次不把模型叫起来，快照也不写 */
        if (await deps.studyGateBlocks(id)) {
          deps.notify(id, '学习正等着学习者作答：这次自动继续先不发，等他答完再接着走。', 'info', 'auto-continue-learn')
          return
        }
        await deps.writeRetrySnapshot(id, {
          operationId: randomUUID(),
          at: Date.now(),
          kind: 'retry',
          summary: retryResumeSummary({ error: plan.error, attempt: plan.attempt, limit: deps.autoContinueLimit })
        })
      })().catch(() => {
        /* 快照写不进去 → 这一次不继续；下一次错误还会再来（不会静默丢掉整条链） */
      })
    }, plan.delayMs)
    /* 不阻止应用退出：用户关窗口时不该等这个定时器 */
    timer.unref?.()
    timers.set(id, { timer, token })
  }

  /* 幂等与去重在 store 里：同一次错误从两条通道到达时，第二次拿到 duplicate */
  async function handleModelError(id: string, payload: { text: string; source: string }): Promise<void> {
    const key = deps.workModeKeyFor(id)
    if (!key) return
    let result: { plan: AutoContinuePlan | null; duplicate: boolean }
    try {
      await deps.autoContinues.load()
      result = await deps.autoContinues.noteFailure(key, payload.text, { learnWaiting: await deps.studyGateBlocks(id) })
    } catch {
      return
    }
    const { plan, duplicate } = result
    if (!plan || duplicate) return
    if (plan.action === 'stop') {
      deps.notify(id, plan.note, plan.reason === 'limit' ? 'error' : 'info', 'auto-continue')
      return
    }
    deps.notify(id, plan.note, 'warning', 'auto-continue')
    scheduleAutoContinue(id, plan)
  }

  function observePush(id: string, msg: MainPush): void {
    /* 回合刚结束：交接、普通续跑、重复拦下都在同一条串行链里决定 */
    if (msg.ch === 'state' && (msg.payload as SessionState)?.isAgentRunning === false) {
      void schedule(id, 'settled')
    }
    /* 模型报错 → 自动继续（单开通道；拿提示文案做判据太脆） */
    if (msg.ch === 'agent-error') void handleModelError(id, msg.payload)
    /* 一轮真的产出了（有文本或工具调用、且没标错）→ 连续失败计数归零 */
    if (
      msg.ch === 'msg-update' &&
      msg.payload?.patch?.role === 'assistant' &&
      !msg.payload.patch.error &&
      (msg.payload.patch.text || msg.payload.patch.toolCalls?.length)
    ) {
      void resetAutoContinue(id)
    }
  }

  return {
    schedule,
    observePush,
    resetAutoContinue,
    cancelAutoContinue,
    hasPendingAutoContinue: (id) => timers.has(id)
  }
}
