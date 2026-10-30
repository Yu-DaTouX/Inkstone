import type { MessageKey } from '../../i18n'
import type { DisabledReason, PrimaryKind } from './git-flow'

export const PRIMARY_LABEL: Record<PrimaryKind, MessageKey> = {
  commit: 'gitflow.action.commit',
  push: 'gitflow.action.push',
  publish: 'gitflow.action.publish',
  'up-to-date': 'gitflow.action.upToDate',
  behind: 'gitflow.action.behind'
}

export const REASON_KEY: Record<DisabledReason, MessageKey> = {
  'need-message': 'gitflow.reason.needMessage',
  'nothing-staged': 'gitflow.reason.nothingStaged',
  synced: 'gitflow.reason.synced',
  'no-remote': 'gitflow.reason.noRemote',
  detached: 'gitflow.reason.detached',
  unborn: 'gitflow.reason.unborn',
  diverged: 'gitflow.reason.diverged',
  behind: 'gitflow.reason.behind'
}
