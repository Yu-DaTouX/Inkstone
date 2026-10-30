import type { EnvironmentId } from './contracts'
import type { EnvironmentThreadShell } from './models'
import type { ThreadSortInput } from './thread-sort'
import { getThreadSortTimestamp } from './thread-sort'

export interface EnvironmentThreadSearchMatch {
  readonly environmentId: EnvironmentId
  readonly threadId: string
  readonly title: string
  readonly snippet: string | null
  readonly matchedMessageId?: string | null
}

export type ThreadSearchShell = Pick<
  EnvironmentThreadShell,
  | 'environmentId'
  | 'id'
  | 'title'
  | 'branch'
  | 'createdAt'
  | 'updatedAt'
  | 'latestUserMessageAt'
  | 'latestUserAuthoredMessageAt'
  | 'opens'
>

export interface ThreadSearchSubject {
  readonly id: string
  readonly title: string
  readonly branch: string | null
  readonly projectTitle: string | null
  readonly environmentLabel: string | null
  readonly activityAt: number | null
  readonly opens: null
}

export function threadSearchSubject(
  thread: ThreadSearchShell,
  projectTitle: string | null | undefined,
  environmentLabel?: string | null
): ThreadSearchSubject {
  const authored = thread.latestUserAuthoredMessageAt
  const activityAt =
    authored === undefined
      ? getThreadSortTimestamp(thread as ThreadSortInput, 'updated_at')
      : Date.parse(authored ?? thread.createdAt)
  return {
    id: thread.id,
    title: thread.title,
    branch: thread.branch,
    projectTitle: projectTitle ?? null,
    environmentLabel: environmentLabel ?? null,
    activityAt: Number.isFinite(activityAt) ? activityAt : null,
    opens: null
  }
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, 'environmentId' | 'threadId'>
): string {
  return JSON.stringify([match.environmentId, match.threadId])
}

export function makeThreadSearchKey(environmentIds: ReadonlyArray<EnvironmentId>, query: string): string {
  return JSON.stringify([[...environmentIds].sort((left, right) => left.localeCompare(right)), query])
}

export interface ShownOrder {
  readonly query: string
  readonly keys: ReadonlyArray<string>
  readonly shown: number
}

const LATE_ROOM = 3

export function nextShownOrder(
  previous: ShownOrder | null,
  query: string,
  ranked: ReadonlyArray<string>,
  limit: number
): ShownOrder {
  if (previous?.query !== query) return { query, keys: ranked, shown: Math.min(limit, ranked.length) }
  const listed = new Set(ranked)
  const kept = previous.keys.slice(0, previous.shown).filter((key) => listed.has(key))
  const held = new Set(kept)
  const seen = new Set(previous.keys)
  const rest = ranked.filter((key) => !held.has(key))
  const arrived = rest.filter((key) => !seen.has(key)).length
  const keys = [...kept, ...rest]
  const shown = Math.min(keys.length, limit + LATE_ROOM, Math.max(limit, kept.length + Math.min(arrived, LATE_ROOM)))
  const unchanged =
    shown === previous.shown &&
    keys.length === previous.keys.length &&
    keys.every((key, index) => key === previous.keys[index])
  return unchanged ? previous : { query, keys, shown }
}

export interface SettledThreadSearch {
  readonly query: string
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>
}

export function visibleThreadSearch(
  query: string,
  ready: SettledThreadSearch | null,
  previous: SettledThreadSearch | null
): SettledThreadSearch {
  if (ready !== null) return ready
  const current = query.toLowerCase()
  const before = (previous?.query ?? '').toLowerCase()
  return previous !== null && current.length > 0 && before.length > 0 && (current.startsWith(before) || before.startsWith(current))
    ? previous
    : { query: '', matches: [] }
}
