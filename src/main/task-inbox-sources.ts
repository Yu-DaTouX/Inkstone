import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import { listSessions } from './sessions'
import { currentTaskPlan } from './task-plan-store'
import type { RunnerRegistry } from './runners'
import type { InboxSession, RunnerFacts, TaskInboxSources } from './task-inbox-service'

const INBOX_STATE_FILE = 'task-inbox.json'
const DISMISS_MAX = 500

export interface InboxState {
  dismissed: string[]
  readUntil: Record<string, number>
}

const EMPTY_STATE: InboxState = { dismissed: [], readUntil: {} }

export async function readInboxState(root: string = YAN_DIR): Promise<InboxState> {
  try {
    const raw = await readFile(join(root, INBOX_STATE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_STATE, dismissed: [], readUntil: {} }
    const list = (parsed as { dismissed?: unknown }).dismissed
    const rawRead = (parsed as { readUntil?: unknown }).readUntil
    const readUntil: Record<string, number> = {}
    if (rawRead && typeof rawRead === 'object') {
      for (const [k, v] of Object.entries(rawRead as Record<string, unknown>)) {
        const n = Number(v)
        if (Number.isFinite(n) && n > 0) readUntil[k] = Math.floor(n)
      }
    }
    return {
      dismissed: Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(-DISMISS_MAX) : [],
      readUntil
    }
  } catch {
    return { dismissed: [], readUntil: {} }
  }
}

export async function writeInboxState(state: InboxState, root: string = YAN_DIR): Promise<InboxState> {
  const path = join(root, INBOX_STATE_FILE)
  await mkdir(dirname(path), { recursive: true })
  const recent = Object.entries(state.readUntil ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
  const persisted: InboxState = { dismissed: (state.dismissed ?? []).slice(-DISMISS_MAX), readUntil: Object.fromEntries(recent) }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(
      temp,
      JSON.stringify(
        persisted,
        null,
        2
      ),
      'utf8'
    )
    await rename(temp, path)
    return persisted
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

export function foldRunners(statuses: RunnerFacts[]): RunnerFacts[] {
  const score = (r: RunnerFacts) => (r.failed ? 4 : 0) + (r.waiting ? 2 : 0) + (r.running ? 1 : 0)
  const bySession = new Map<string, RunnerFacts>()
  for (const s of statuses) {
    const prev = bySession.get(s.sessionId)
    if (!prev) {
      bySession.set(s.sessionId, s)
      continue
    }
    const winner = score(s) > score(prev) ? s : prev
    bySession.set(s.sessionId, {
      sessionId: s.sessionId,
      ...(s.running || prev.running ? { running: true } : {}),
      ...(s.waiting || prev.waiting ? { waiting: true } : {}),
      ...(s.failed || prev.failed ? { failed: true } : {}),
      ...(winner.reason ? { reason: winner.reason } : {})
    })
  }
  return [...bySession.values()]
}

export function toRunnerFacts(s: {
  sessionId?: string
  running?: boolean
  waiting?: boolean
  failed?: boolean
  conn?: string
}): RunnerFacts[] {
  if (!s.sessionId) return []
  return [
    {
      sessionId: s.sessionId,
      ...(s.running ? { running: true } : {}),
      ...(s.waiting ? { waiting: true } : {}),
      ...(s.failed ? { failed: true } : {}),
      ...(s.failed ? { reason: s.conn === 'exited' ? '进程已退出' : '连接失败' } : {})
    }
  ]
}

export interface TaskInboxSourceOptions {
  registry: Pick<RunnerRegistry, 'statuses'>
  list?: () => Promise<InboxSession[]>
  dismissed?: () => string[]
  readPlan?: TaskInboxSources['readPlan']
  questionLog?: { list(sessionId: string): { question: string; answer: string | null; cancelled?: boolean }[] }
  awaitingReview?: (
    sessionId: string,
    session: InboxSession
  ) => Promise<{ since: number; reason?: string } | undefined>
}

export function createTaskInboxSources(opts: TaskInboxSourceOptions): TaskInboxSources {
  let sessionSnapshot = new Map<string, InboxSession>()

  const rawList =
    opts.list ??
    (async () => {
      const list = await listSessions(200)
      return list.map((s) => ({
        id: s.id,
        title: s.title || s.path,
        ...(s.projectId ? { spaceId: s.projectId } : {}),
        updatedAt: s.lastActivityAt ?? s.createdAt ?? 0
      }))
    })

  const listFn = async (): Promise<InboxSession[]> => {
    const list = await rawList()
    sessionSnapshot = new Map(list.map((s) => [s.id, s]))
    return list
  }

  const planFn =
    opts.readPlan ??
    (async (sessionId: string) => {
      const { state } = await currentTaskPlan(sessionId)
      if (!state.todos.length) return undefined
      const done = state.todos.filter((t) => t.done || t.status === 'done').length
      const blocked = state.todos.filter((t) => t.status === 'blocked').length
      const current = state.todos.find((t) => t.status === 'running') ?? state.todos.find((t) => !t.done)
      return {
        total: state.todos.length,
        done,
        ...(blocked ? { blocked } : {}),
        ...(current ? { current: current.text } : {})
      }
    })

  const questionFn = opts.questionLog
    ? async (sessionId: string) => {
        const entries = opts.questionLog!.list(sessionId)
        const last = entries[entries.length - 1]
        if (!last || last.cancelled || last.answer !== null) return undefined
        return { pending: true, text: last.question }
      }
    : undefined

  const reviewFn = opts.awaitingReview
    ? async (sessionId: string) => {
        const session = sessionSnapshot.get(sessionId)
        if (!session) return undefined
        return await opts.awaitingReview!(sessionId, session)
      }
    : undefined

  return {
    listSessions: listFn,
    runners: () => foldRunners(opts.registry.statuses().flatMap(toRunnerFacts)),
    dismissed: opts.dismissed ?? (() => []),
    readPlan: planFn,
    ...(questionFn ? { readQuestion: questionFn } : {}),
    ...(reviewFn ? { readAwaitingReview: reviewFn } : {})
  }
}
