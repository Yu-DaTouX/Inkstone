import type { SidebarThreadSortOrder } from './contracts'
import type { EnvironmentThreadShell } from './models'

export interface ThreadSortInput {
  readonly createdAt: string
  readonly updatedAt: string
  readonly latestUserMessageAt?: string | null
}

export function toSortableTimestamp(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function getFirstSortableTimestamp(...values: readonly (string | null | undefined)[]): number | null {
  for (const value of values) {
    const ms = toSortableTimestamp(value)
    if (ms !== null) return ms
  }
  return null
}

function getLatestUserMessageTimestamp(thread: ThreadSortInput): number {
  return getFirstSortableTimestamp(thread.latestUserMessageAt, thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: SidebarThreadSortOrder
): number {
  if (sortOrder === 'created_at') {
    return getFirstSortableTimestamp(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY
  }
  return getLatestUserMessageTimestamp(thread)
}

export function sortThreads<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder
): T[] {
  if (threads.length < 2) return [...threads]
  return threads
    .map((thread) => ({ thread, timestamp: getThreadSortTimestamp(thread, sortOrder) }))
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        (left.thread.id < right.thread.id ? 1 : left.thread.id > right.thread.id ? -1 : 0)
    )
    .map(({ thread }) => thread)
}

export type SettledThreadTimestampInput = Pick<
  EnvironmentThreadShell,
  'settledAt' | 'latestUserMessageAt' | 'latestRun' | 'updatedAt'
>

export function resolveSettledThreadTimestamp(thread: SettledThreadTimestampInput): string | null {
  if (thread.settledAt !== null && toSortableTimestamp(thread.settledAt) !== null) return thread.settledAt
  let latest: string | null = null
  let latestMs = Number.NEGATIVE_INFINITY
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt
  ]) {
    const parsed = toSortableTimestamp(candidate ?? undefined)
    if (candidate !== null && candidate !== undefined && parsed !== null && parsed > latestMs) {
      latest = candidate
      latestMs = parsed
    }
  }
  if (latest !== null) return latest
  return toSortableTimestamp(thread.updatedAt) === null ? null : thread.updatedAt
}

export function sortSettledThreads<T extends SettledThreadTimestampInput & { readonly id: string }>(
  threads: readonly T[]
): T[] {
  return threads
    .map((thread) => {
      const timestamp = resolveSettledThreadTimestamp(thread)
      return { thread, timestampMs: timestamp === null ? 0 : Date.parse(timestamp) }
    })
    .sort(
      (left, right) =>
        right.timestampMs - left.timestampMs ||
        (left.thread.id < right.thread.id ? 1 : left.thread.id > right.thread.id ? -1 : 0)
    )
    .map(({ thread }) => thread)
}

export function getLatestThreadForProject<
  T extends { readonly id: string; readonly projectId: string; readonly archivedAt: string | null } & ThreadSortInput
>(threads: readonly T[], projectId: string, sortOrder: SidebarThreadSortOrder): T | null {
  let latest: T | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY
  for (const thread of threads) {
    if (thread.projectId !== projectId || thread.archivedAt !== null) continue
    const timestamp = getThreadSortTimestamp(thread, sortOrder)
    if (latest === null || timestamp > latestTimestamp || (timestamp === latestTimestamp && thread.id > latest.id)) {
      latest = thread
      latestTimestamp = timestamp
    }
  }
  return latest
}

export function sortPinnedThreadsByOrderKey<T extends { readonly pinnedAt: string | null }>(
  threads: readonly T[]
): T[] {
  return [...threads].sort(
    (left, right) => (toSortableTimestamp(right.pinnedAt) ?? 0) - (toSortableTimestamp(left.pinnedAt) ?? 0)
  )
}

export function sortActiveThreadsByOrderKey<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[]
): T[] {
  return sortThreads(threads, 'updated_at')
}

export interface PinnedReorderPlan {
  readonly moves: ReadonlyArray<{ readonly id: string; readonly pinOrderKey: string }>
}

export function pinOrderKeyBetween(_before: string | null, _after: string | null): string | null {
  return null
}

export function planPinnedReorder(_input: {
  readonly orderedIds: readonly string[]
  readonly keysById: ReadonlyMap<string, string | null>
}): PinnedReorderPlan | null {
  return null
}
