import type { SubagentRun } from '../shared/ipc'
import { buildSubagentNotice } from '../shared/subagent-notice'

export const NOTICE_COALESCE_WINDOW_MS = 20_000
export const NOTICE_BATCH_MIN_WAIT_MS = 2 * 60_000
export const NOTICE_BATCH_MAX_WAIT_MS = 10 * 60_000
export const NOTICE_SIBLINGS_POLL_MS = 15_000

export interface NoticeTarget {
  send(text: string, images: undefined, mode: 'followUp'): Promise<{ ok: boolean; error?: string }>
}

export interface SubagentNotifierDeps {
  find(run: SubagentRun): NoticeTarget | null
  enabled(): boolean | Promise<boolean>
  runningSiblings?(run: SubagentRun): number | Promise<number>
  now?(): number
}

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
  timer: ReturnType<typeof setTimeout>
  deadlineAt: number
  pollTimer?: ReturnType<typeof setTimeout>
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
}

function batchWaitMs(run: SubagentRun): number {
  const duration =
    typeof run.endedAt === 'number' && Number.isFinite(run.endedAt) && run.endedAt > run.startedAt
      ? run.endedAt - run.startedAt
      : 0
  return Math.min(NOTICE_BATCH_MAX_WAIT_MS, Math.max(NOTICE_BATCH_MIN_WAIT_MS, Math.floor(duration / 2)))
}

export function createSubagentNotifier(deps: SubagentNotifierDeps): (run: SubagentRun) => void {
  const pending = new Map<string, PendingBatch>()
  const now = (): number => deps.now?.() ?? Date.now()

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

  const flush = (key: string): void => {
    const batch = pending.get(key)
    if (!batch) return
    pending.delete(key)
    clearTimeout(batch.timer)
    stopPoll(batch)
    void (async () => {
      if (!(await deps.enabled())) return
      const target = deps.find(batch.runs[0])
      if (!target) return
      await target.send(buildNotice(batch.runs), undefined, 'followUp')
    })().catch(() => undefined)
  }

  const rearm = (key: string, batch: PendingBatch, delay: number): void => {
    clearTimeout(batch.timer)
    batch.deadlineAt = now() + delay
    batch.timer = setTimeout(() => flush(key), delay)
    unref(batch.timer)
  }

  const shorten = (key: string, batch: PendingBatch): void => {
    const target = now() + NOTICE_COALESCE_WINDOW_MS
    if (batch.deadlineAt <= target) return
    stopPoll(batch)
    rearm(key, batch, NOTICE_COALESCE_WINDOW_MS)
  }

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

      if (run.status === 'cancelled') {
        if (open && siblings <= 0) shorten(key, open)
        return
      }

      if (open) {
        open.runs.push(run)
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
