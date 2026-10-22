import type { SubagentRun } from '../shared/ipc'
import { buildSubagentNotice } from '../shared/subagent-notice'

export const NOTICE_COALESCE_WINDOW_MS = 3_000
export const NOTICE_BATCH_MIN_WAIT_MS = 60_000
export const NOTICE_BATCH_MAX_WAIT_MS = 10 * 60_000
export const NOTICE_SIBLINGS_POLL_MS = 15_000
const MAX_DELIVERY_ATTEMPTS = 5
export const NOTICE_MAX_UNDELIVERED_RUNS = 20

export interface NoticeTarget {
  send(text: string, images: undefined, mode: 'followUp'): Promise<{ ok: boolean; error?: string }>
}

export interface SubagentNotifierDeps {
  find(run: SubagentRun): NoticeTarget | null
  enabled(): boolean | Promise<boolean>
  runningSiblings?(run: SubagentRun): number | Promise<number>
  now?(): number
}

export type SubagentNotifier = ((run: SubagentRun) => void) & { retry(): void }

export interface NoticeTargetLookup<T> {
  agentForSession(sessionId: string): T | null | undefined
  agentOf(runId: string): T | null | undefined
  runtimeOf(runId: string): { sessionId?: string; generation: number } | null | undefined
}

export function findNoticeTarget<T>(
  run: Pick<SubagentRun, 'parentSessionId' | 'parentRunId' | 'parentGeneration'>,
  lookup: NoticeTargetLookup<T>
): T | null {
  const sessionId = run.parentSessionId
  if (sessionId && !sessionId.startsWith('pending:')) return lookup.agentForSession(sessionId) ?? null
  const runId = run.parentRunId
  if (!runId || run.parentGeneration === undefined) return null
  if (sessionId && sessionId !== `pending:${runId}`) return null
  const runtime = lookup.runtimeOf(runId)
  if (!runtime || runtime.generation !== run.parentGeneration) return null
  return lookup.agentOf(runId) ?? null
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

export function createSubagentNotifier(deps: SubagentNotifierDeps): SubagentNotifier {
  const pending = new Map<string, PendingBatch>()
  const undelivered = new Map<string, SubagentRun[]>()
  const failedAttempts = new Map<string, number>()
  let retrying = false
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

  const deliver = async (target: NoticeTarget, runs: SubagentRun[]): Promise<boolean> => {
    try {
      return (await target.send(buildNotice(runs), undefined, 'followUp')).ok
    } catch {
      return false
    }
  }

  const runStamp = (run: SubagentRun): number =>
    typeof run.endedAt === 'number' && Number.isFinite(run.endedAt)
      ? run.endedAt
      : Number.isFinite(run.startedAt)
        ? run.startedAt
        : 0

  const runIds = (runs: SubagentRun[]): string => runs.map((run) => run.id).join(',')

  const trimUndelivered = (): void => {
    const all: SubagentRun[] = []
    for (const runs of undelivered.values()) all.push(...runs)
    const excess = all.length - NOTICE_MAX_UNDELIVERED_RUNS
    if (excess <= 0) return
    const dropped = new Set([...all].sort((a, b) => runStamp(a) - runStamp(b)).slice(0, excess))
    for (const [key, runs] of [...undelivered]) {
      const kept = runs.filter((run) => !dropped.has(run))
      if (kept.length > 0) undelivered.set(key, kept)
      else {
        undelivered.delete(key)
        failedAttempts.delete(key)
      }
    }
    console.warn(
      `[subagent-notify] 未投递通知超过 ${NOTICE_MAX_UNDELIVERED_RUNS} 条上限，丢弃最旧的 ${dropped.size} 条：${runIds([...dropped])}`
    )
  }

  const keepUndelivered = (key: string, runs: SubagentRun[]): void => {
    const attempts = (failedAttempts.get(key) ?? 0) + 1
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      failedAttempts.delete(key)
      console.warn(`[subagent-notify] 连续投递失败 ${attempts} 次，放弃 ${runs.length} 条通知（父会话 ${key}）：${runIds(runs)}`)
      return
    }
    failedAttempts.set(key, attempts)
    undelivered.set(key, [...runs, ...(undelivered.get(key) ?? [])])
    trimUndelivered()
  }

  const flush = (key: string): void => {
    const batch = pending.get(key)
    if (!batch) return
    pending.delete(key)
    clearTimeout(batch.timer)
    stopPoll(batch)
    void (async () => {
      if (!(await deps.enabled())) return
      const runs = [...(undelivered.get(key) ?? []), ...batch.runs]
      undelivered.delete(key)
      const target = deps.find(runs[runs.length - 1])
      if (!target) {
        undelivered.set(key, runs)
        trimUndelivered()
        return
      }
      if (await deliver(target, runs)) failedAttempts.delete(key)
      else keepUndelivered(key, runs)
    })().catch(() => undefined)
  }

  const retry = (): void => {
    if (retrying || undelivered.size === 0) return
    retrying = true
    void (async () => {
      if (!(await deps.enabled())) {
        undelivered.clear()
        return
      }
      for (const [key, runs] of [...undelivered]) {
        if (pending.has(key)) continue
        const target = deps.find(runs[runs.length - 1])
        if (!target) continue
        undelivered.delete(key)
        if (await deliver(target, runs)) failedAttempts.delete(key)
        else keepUndelivered(key, runs)
      }
    })().catch(() => undefined).finally(() => {
      retrying = false
    })
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

  const notify = (run: SubagentRun): void => {
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

  return Object.assign(notify, { retry })
}
