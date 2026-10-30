import { threadRuntimeIsActive, type EnvironmentThreadShell } from './models'
import { effectiveSnoozed } from './thread-settled'
import { toSortableTimestamp } from './thread-sort'

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | 'hasActionableProposedPlan'
  | 'hasPendingApprovals'
  | 'hasPendingUserInput'
  | 'pendingSubagentRequest'
  | 'interactionMode'
  | 'latestRun'
  | 'runtime'
>

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false
  if (thread.pendingSubagentRequest !== null) return false
  if (!threadRuntimeIsActive(thread.runtime) && thread.runtime?.status !== 'idle') return false
  const run = thread.latestRun
  const runSettled =
    run !== null &&
    run.status !== 'preparing' &&
    run.status !== 'queued' &&
    run.status !== 'starting' &&
    run.status !== 'running' &&
    run.status !== 'waiting' &&
    thread.runtime?.activeRunId !== run.runId
  return !(thread.interactionMode === 'plan' && thread.hasActionableProposedPlan && runSettled)
}

type InboxThreadInput = Pick<EnvironmentThreadShell, 'id' | 'environmentId' | 'createdAt' | 'unsettledAt' | 'latestRun'>

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, 'id' | 'environmentId'>>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>
): T[] {
  return [...threads].sort(
    (left, right) =>
      (timestamps.get(right) ?? 0) - (timestamps.get(left) ?? 0) ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId)
  )
}

export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0
      )
    ])
  )
  return sortNewestFirst(threads, timestamps)
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  'id' | 'environmentId' | 'createdAt' | 'latestRun' | 'latestUserAuthoredMessageAt'
>

export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined ? thread.latestRun?.requestedAt : thread.latestUserAuthoredMessageAt) ??
            undefined
        ) ?? 0
      )
    ])
  )
  return sortNewestFirst(threads, timestamps)
}

export const WORKING_EXIT_GRACE_MS = 2_000

type TrackedInboxThread = WorkingThreadInput &
  InboxThreadInput &
  Partial<
    Pick<
      EnvironmentThreadShell,
      'archivedAt' | 'deletedAt' | 'pinnedAt' | 'settledOverride' | 'settledAt' | 'snoozedAt' | 'snoozedUntil' | 'activeOrderKey' | 'pendingGuestMessageCount'
    >
  >

type ThreadKeyInput = Pick<EnvironmentThreadShell, 'environmentId' | 'id'>

const keyOf = (thread: ThreadKeyInput): string => `${thread.environmentId}:${thread.id}`

export interface InboxReturnObservation {
  readonly isWorking: (thread: WorkingThreadInput & ThreadKeyInput) => boolean
  readonly returnedAt: (thread: ThreadKeyInput) => number | undefined
}

export function createInboxReturnTracker() {
  const listeners = new Set<() => void>()
  const known = new Map<string, boolean>()
  const returns = new Map<string, number>()
  let version = 0

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: (): number => version,
    observe(threads: readonly TrackedInboxThread[] | null): InboxReturnObservation {
      if (threads === null) {
        known.clear()
        returns.clear()
        return { isWorking: isThreadWorking, returnedAt: () => undefined }
      }
      const at = Date.now()
      const present = new Set<string>()
      for (const thread of threads) {
        const key = keyOf(thread)
        present.add(key)
        const excluded =
          thread.archivedAt != null ||
          thread.deletedAt != null ||
          thread.pinnedAt != null ||
          effectiveSnoozed(thread as TrackedInboxThread & Parameters<typeof effectiveSnoozed>[0], at)
        const working = !excluded && isThreadWorking(thread)
        if (known.get(key) === true && !working) returns.set(key, at)
        known.set(key, working)
      }
      for (const key of known.keys()) if (!present.has(key)) known.delete(key)
      ++version
      const workingSnapshots = new Map(known)
      const returnSnapshots = new Map(returns)
      return {
        isWorking: (thread) => workingSnapshots.get(keyOf(thread)) ?? isThreadWorking(thread),
        returnedAt: (thread) => returnSnapshots.get(keyOf(thread))
      }
    },
    isWorking: (thread: WorkingThreadInput & ThreadKeyInput): boolean => known.get(keyOf(thread)) ?? isThreadWorking(thread),
    returnedAt: (thread: ThreadKeyInput): number | undefined => returns.get(keyOf(thread))
  }
}
