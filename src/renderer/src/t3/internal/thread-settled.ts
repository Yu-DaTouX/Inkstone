import type { AppLang } from './contracts'
import { translate } from '../../i18n'
import { formatSnoozeWake, resolveSnoozeOptions } from '../../features/sidebar/session-snooze'
import type { EnvironmentThreadShell } from './models'

export interface SnoozePreset {
  readonly id: string
  readonly label: string
  readonly whenLabel: string
  readonly snoozedUntil: string
}

export type ThreadSnoozeShell = Pick<
  EnvironmentThreadShell,
  | 'hasPendingApprovals'
  | 'hasPendingUserInput'
  | 'pendingSubagentRequest'
  | 'pendingGuestMessageCount'
  | 'latestRun'
  | 'runtime'
  | 'snoozedUntil'
  | 'snoozedAt'
  | 'lastVisitedAt'
>

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['preparing', 'queued', 'starting'])

export function hasQueuedTurnStart(shell: Pick<ThreadSnoozeShell, 'runtime'>): boolean {
  return shell.runtime !== null && ACTIVE_STATUSES.has(shell.runtime.status)
}

export function canSnooze(shell: Pick<ThreadSnoozeShell, 'hasPendingApprovals' | 'hasPendingUserInput' | 'pendingSubagentRequest' | 'pendingGuestMessageCount' | 'runtime'>): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false
  if (shell.pendingSubagentRequest !== null) return false
  if (shell.pendingGuestMessageCount > 0) return false
  return !hasQueuedTurnStart(shell)
}

export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true
  if (shell.pendingSubagentRequest !== null) return true
  if (shell.pendingGuestMessageCount > 0) return true
  const failedAt = failureEdgeAt(shell)
  if (failedAt === null) return false
  return shell.snoozedAt === null || Date.parse(failedAt) > Date.parse(shell.snoozedAt)
}

function failureEdgeAt(shell: ThreadSnoozeShell): string | null {
  if (shell.runtime?.status !== 'failed') return null
  return shell.runtime.updatedAt
}

export function effectiveSnoozed(shell: ThreadSnoozeShell, now: number): boolean {
  if (shell.snoozedUntil === null) return false
  const wakeAt = Date.parse(shell.snoozedUntil)
  if (!Number.isFinite(wakeAt)) return false
  if (wakeAt <= now) return false
  return !threadRaisedHandWhileSnoozed(shell)
}

export function threadWokeAt(shell: ThreadSnoozeShell, now: number): string | null {
  if (shell.snoozedUntil === null) return null
  const wakeAt = Date.parse(shell.snoozedUntil)
  if (!Number.isFinite(wakeAt)) return null
  if (threadRaisedHandWhileSnoozed(shell)) return failureEdgeAt(shell) ?? shell.runtime?.updatedAt ?? shell.snoozedAt
  return wakeAt <= now ? shell.snoozedUntil : null
}

export function resolveSnoozePresets(now: number, lang: AppLang): SnoozePreset[] {
  return resolveSnoozeOptions(now).map((option) => ({
    id: option.id,
    label: translate(lang, option.labelKey),
    whenLabel: formatSnoozeWake(option.until, now, lang),
    snoozedUntil: new Date(option.until).toISOString()
  }))
}

export function pickSnoozePreset(
  shown: readonly SnoozePreset[],
  id: string,
  now: number,
  lang: AppLang
): SnoozePreset | undefined {
  const original = shown.find((preset) => preset.id === id)
  if (original && Date.parse(original.snoozedUntil) > now) return original
  return resolveSnoozePresets(now, lang).find((preset) => preset.id === id)
}

export function snoozeWakeLabel(snoozedUntil: string, now: number, lang: AppLang): string {
  const wakeAt = Date.parse(snoozedUntil)
  if (!Number.isFinite(wakeAt) || wakeAt <= now) return translate(lang, 'rail.justNow')
  return formatSnoozeWake(wakeAt, now, lang)
}

export function isThreadWokeUnseen(input: {
  readonly wokeAt: string | null
  readonly settled: boolean
  readonly lastVisitedAt: string | null | undefined
  readonly latestRunCompletedAt: string | null
}): boolean {
  if (input.wokeAt === null || input.settled) return false
  const wokeAt = Date.parse(input.wokeAt)
  if (!Number.isFinite(wokeAt)) return false
  const seenAt = [input.lastVisitedAt, input.latestRunCompletedAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((ms) => Number.isFinite(ms))
  return seenAt.every((ms) => ms < wokeAt)
}
