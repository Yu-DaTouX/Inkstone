/**
 * 子代理结束 → 通知父会话的模型。
 *
 * 只做投递决策：向谁投、要不要投、何时投。文本格式在 `shared/subagent-notice.ts`。
 *
 * 规则：
 *   · 只通知终态里「模型可能还在等它」的运行：完成与失败。用户手动停止的不通知
 *     （是用户自己按的，模型没有理由被叫醒），但它的结束仍可能让同批兄弟清空，
 *     用来触发提前收尾；
 *   · 按父会话找运行实例：用户此刻在看别的会话时，通知仍回到发起它的那个会话；
 *     该会话已经关掉（没有实例）就不投，不去唤醒无关会话；
 *   · 空闲时开新一轮、正忙时排队（`send` 的既有语义）；整理上下文等暂不接收的时段
 *     `send` 会拒绝，这里不重试——模型之后仍可以用 `yan subagent list` 查到；
 *   · 同一父会话为一个「批」，按兄弟是否仍在运行自适应合并：到达时该父会话已无
 *     运行中的兄弟就走 20 秒短窗口；仍有兄弟在跑就进等待批，截止 = 首条入批时刻 +
 *     clamp(0.5 × 首条运行时长, 2 分钟, 10 分钟)，等待期新到的完成通知并入同批且
 *     截止不延后。失败/出错不等待，按短窗口投递并带出已有等待批；兄弟任一刻全部
 *     结束（含被取消）立即改用短窗口收尾。等待批存在时每 15 秒轮询只读运行状态兜底。
 *     单条保持原格式；多条在一条消息里逐段列出原有内容，仍按通知识别（不显示为
 *     用户消息、仍作为助手段计时边界）。
 *     开关关闭时不入队，窗口内关闭则丢弃本批（与「关闭即不通知」一致）；会话在窗口内
 *     关闭时按既有规则不投，运行记录仍在，可用 `yan subagent list/get` 查到。
 */
import type { SubagentRun } from '../shared/ipc'
import { buildSubagentNotice } from '../shared/subagent-notice'

/** 无兄弟（或失败）时：首条完成通知到达后等待多久，把窗口内随后的完成通知合并进同一条消息 */
export const NOTICE_COALESCE_WINDOW_MS = 20_000
/** 等待批的下限：兄弟在跑时至少给较短任务一点合并余量 */
export const NOTICE_BATCH_MIN_WAIT_MS = 2 * 60_000
/** 等待批的上限：再长的任务也不让父会话等超过这个时间 */
export const NOTICE_BATCH_MAX_WAIT_MS = 10 * 60_000
/** 等待批存在时轮询「兄弟是否已全部结束」的间隔，兜底没有事件触发的结束 */
export const NOTICE_SIBLINGS_POLL_MS = 15_000

export interface NoticeTarget {
  send(text: string, images: undefined, mode: 'followUp'): Promise<{ ok: boolean; error?: string }>
}

export interface SubagentNotifierDeps {
  /** 按稳定会话 id / 运行实例 id 找到父会话的实例 */
  find(run: SubagentRun): NoticeTarget | null
  /** 开关：设置里关闭后不再自动唤醒模型 */
  enabled(): boolean | Promise<boolean>
  /**
   * 只读：该父会话下仍在运行（running / starting）的兄弟数量，用来决定短窗口还是等待批、
   * 以及兄弟全部结束后能否提前收尾。不传时按 0 处理（退化为原有的固定短窗口）。
   */
  runningSiblings?(run: SubagentRun): number | Promise<number>
  /** 可注入时钟，便于测试；默认 `Date.now` */
  now?(): number
}

/** 合并一条通知：单条保持原格式，多条在一个标签里逐段列出，不嵌套标签 */
function buildNotice(runs: SubagentRun[]): string {
  if (runs.length === 1) return buildSubagentNotice(runs[0])
  const bodies = runs.map((run) => {
    const text = buildSubagentNotice(run)
    const match = /^<subagent-notification id="[^"]+" status="[^"]+">\n([\s\S]*)\n<\/subagent-notification>$/.exec(text)
    return match ? match[1] : text
  })
  const ids = runs.map((run) => run.id).join(',')
  const status = runs.some((run) => run.status === 'error') ? 'error' : 'done'
  return `<subagent-notification id="${ids}" status="${status}">\n${bodies.join('\n\n')}\n</subagent-notification>`
}

interface PendingBatch {
  runs: SubagentRun[]
  /** 截止到点后投递 */
  timer: ReturnType<typeof setTimeout>
  /** 绝对截止时刻（可注入时钟），用于保证截止不延后 */
  deadlineAt: number
  /** 等待批期间轮询兄弟状态的定时器；短窗口批不需要 */
  pollTimer?: ReturnType<typeof setTimeout>
}

/** 不因等待窗口拖住退出；未投递的运行记录仍可查询 */
function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
}

/** 等待批的时长：0.5 × 首条运行时长，夹在上下限之间 */
function batchWaitMs(run: SubagentRun): number {
  const duration =
    typeof run.endedAt === 'number' && Number.isFinite(run.endedAt) && run.endedAt > run.startedAt
      ? run.endedAt - run.startedAt
      : 0
  return Math.min(NOTICE_BATCH_MAX_WAIT_MS, Math.max(NOTICE_BATCH_MIN_WAIT_MS, Math.floor(duration / 2)))
}

export function createSubagentNotifier(deps: SubagentNotifierDeps): (run: SubagentRun) => void {
  /** 同一父会话的待投递批次；key 优先稳定会话 id，退回发起它的运行实例 id */
  const pending = new Map<string, PendingBatch>()
  const now = (): number => deps.now?.() ?? Date.now()

  /** 兄弟仍在运行的数量；查询失败按 0 处理，宁可早投不拖住父会话 */
  const siblingsOf = async (run: SubagentRun): Promise<number> => {
    if (!deps.runningSiblings) return 0
    try {
      return await deps.runningSiblings(run)
    } catch {
      return 0
    }
  }

  const stopPoll = (batch: PendingBatch): void => {
    if (batch.pollTimer) clearTimeout(batch.pollTimer)
    batch.pollTimer = undefined
  }

  /** 窗口结束：清出批次后重新核对开关与归属，再投递合并文本 */
  const flush = (key: string): void => {
    const batch = pending.get(key)
    if (!batch) return
    pending.delete(key)
    clearTimeout(batch.timer)
    stopPoll(batch)
    void (async () => {
      if (!(await deps.enabled())) return
      /* 窗口内会话可能关了或换了实例：投递前重找一次，只投原父会话 */
      const target = deps.find(batch.runs[0])
      if (!target) return
      await target.send(buildNotice(batch.runs), undefined, 'followUp')
    })().catch(() => undefined)
  }

  /** 按新的延迟重挂截止定时器（截止只会提前，不会延后） */
  const rearm = (key: string, batch: PendingBatch, delay: number): void => {
    clearTimeout(batch.timer)
    batch.deadlineAt = now() + delay
    batch.timer = setTimeout(() => flush(key), delay)
    unref(batch.timer)
  }

  /** 兄弟已全部结束 / 出错到达：改用 20 秒短窗口收尾，仍大于当前截止时不提前 */
  const shorten = (key: string, batch: PendingBatch): void => {
    const target = now() + NOTICE_COALESCE_WINDOW_MS
    if (batch.deadlineAt <= target) return
    stopPoll(batch)
    rearm(key, batch, NOTICE_COALESCE_WINDOW_MS)
  }

  /** 等待批期间每 15 秒查一次兄弟是否已全部结束（兜底没有事件触发的结束） */
  const startPoll = (key: string): void => {
    const tick = (): void => {
      const batch = pending.get(key)
      if (!batch) return
      void (async () => {
        const siblings = await siblingsOf(batch.runs[0])
        const live = pending.get(key)
        if (!live || live !== batch) return
        if (siblings <= 0) {
          shorten(key, live)
          return
        }
        live.pollTimer = setTimeout(tick, NOTICE_SIBLINGS_POLL_MS)
        unref(live.pollTimer)
      })().catch(() => undefined)
    }
    const batch = pending.get(key)
    if (!batch) return
    batch.pollTimer = setTimeout(tick, NOTICE_SIBLINGS_POLL_MS)
    unref(batch.pollTimer)
  }

  return (run) => {
    if (run.status !== 'done' && run.status !== 'error' && run.status !== 'cancelled') return
    const key = run.parentSessionId || run.parentRunId
    if (!key) return
    void (async () => {
      if (!(await deps.enabled())) return
      const siblings = await siblingsOf(run)
      const open = pending.get(key)

      /* 取消不通知；它的结束仍可能让等待批的兄弟清空，据此触发提前收尾 */
      if (run.status === 'cancelled') {
        if (open && siblings <= 0) shorten(key, open)
        return
      }

      if (open) {
        open.runs.push(run)
        /* 失败不等待；兄弟已全部结束也不再等长截止 */
        if (run.status === 'error' || siblings <= 0) shorten(key, open)
        return
      }

      const short = run.status === 'error' || siblings <= 0
      const delay = short ? NOTICE_COALESCE_WINDOW_MS : batchWaitMs(run)
      const batch: PendingBatch = { runs: [run], timer: undefined as unknown as ReturnType<typeof setTimeout>, deadlineAt: now() + delay }
      pending.set(key, batch)
      rearm(key, batch, delay)
      if (!short) startPoll(key)
    })().catch(() => undefined)
  }
}
