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

export function resolveSnoozePresets(now: number, lang: AppLang): SnoozePreset[] {
  return resolveSnoozeOptions(now).map((option) => ({
    id: option.id,
    label: translate(lang, option.labelKey),
    whenLabel: formatSnoozeWake(option.until, now, lang),
    snoozedUntil: new Date(option.until).toISOString()
  }))
}

export function snoozeWakeLabel(snoozedUntil: string, now: number, lang: AppLang): string {
  const wakeAt = Date.parse(snoozedUntil)
  if (!Number.isFinite(wakeAt) || wakeAt <= now) return translate(lang, 'rail.justNow')
  return formatSnoozeWake(wakeAt, now, lang)
}
