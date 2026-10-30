import type { ContextMenuItem } from '../internal/contracts'
import type { SnoozePreset } from '../internal/thread-settled'
import type { TFunc } from '../../i18n'

export type ThreadActionMenuId =
  | 'move-to-project'
  | `move:${string}`
  | 'filter-by-project'
  | 'project-settings'
  | 'pin'
  | 'unpin'
  | 'snooze'
  | `snooze:${string}`
  | 'unsnooze'
  | 'rename'
  | 'regenerate-title'
  | 'mark-unread'
  | 'mark-read'
  | 'copy'
  | 'copy-path'
  | 'copy-thread'
  | 'copy-thread-id'
  | 'archive'
  | 'unarchive'
  | 'delete'

export type DraftActionMenuId = 'copy' | 'copy-path' | 'project-settings' | 'discard'

export interface MoveTarget {
  readonly projectId: string
  readonly label: string
}

export function snoozeActionId(presetId: string): `snooze:${string}` {
  return `snooze:${presetId}`
}

export function moveActionId(projectId: string): `move:${string}` {
  return `move:${projectId}`
}

export function buildDraftActionMenuItems(
  options: {
    readonly hasPath: boolean
    readonly hasProject: boolean
  },
  t: TFunc
): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: 'copy',
      label: t('sidebar.t3.copy'),
      icon: 'copy',
      disabled: !options.hasPath,
      children: options.hasPath ? [{ id: 'copy-path', label: t('rail.copyPath'), icon: 'folder' }] : []
    },
    ...(options.hasProject ? [{ id: 'project-settings' as const, label: t('sidebar.t3.projectSettings'), icon: 'settings' }] : []),
    { id: 'discard', label: t('sidebar.t3.discardDraft'), icon: 'trash', destructive: true, separatorBefore: true }
  ]
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean
  readonly projectFilter: { readonly label: string; readonly isActive: boolean } | null
  readonly moveTargets: ReadonlyArray<MoveTarget>
  readonly moveTargetProjectId: string | null
  readonly isPinned: boolean
  readonly isArchived: boolean
  readonly isSnoozed: boolean
  readonly canSnoozeNow: boolean
  readonly markedUnread: boolean
  readonly isRegeneratingTitle: boolean
  readonly isRunning: boolean
  readonly supports: {
    readonly snooze: boolean
    readonly pinning: boolean
    readonly titleRegeneration: boolean
    readonly move: boolean
  }
  readonly snoozePresets: ReadonlyArray<SnoozePreset>
}

export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return action !== 'project-settings' && action !== 'mark-unread' && action !== 'mark-read' && !action.startsWith('copy')
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
  t: TFunc
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.supports.move
      ? [
          {
            id: 'move-to-project' as const,
            label: t('rail.moveSession'),
            icon: 'folder-input',
            disabled: state.moveTargets.length === 0 && state.moveTargetProjectId === null,
            children: [
              ...state.moveTargets.map((target) => ({
                id: moveActionId(target.projectId),
                label: target.label,
                checked: target.projectId === state.moveTargetProjectId
              })),
              { id: 'move:none' as const, label: t('rail.noGroup'), checked: state.moveTargetProjectId === null, separatorBefore: state.moveTargets.length > 0 }
            ]
          }
        ]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: 'filter-by-project' as const,
            label: state.projectFilter.isActive
              ? t('sidebar.t3.showAllProjects')
              : t('sidebar.t3.filterByProject', { name: state.projectFilter.label }),
            icon: 'folder-tree'
          }
        ]
      : []),
    ...(state.supports.pinning
      ? [state.isPinned ? { id: 'unpin' as const, label: t('rail.unpin'), icon: 'pin-off' } : { id: 'pin' as const, label: t('rail.pin'), icon: 'pin' }]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: 'unsnooze' as const, label: t('rail.wakeNow'), icon: 'clock' }
            : {
                id: 'snooze' as const,
                label: t('rail.snooze'),
                icon: 'clock',
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: snoozeActionId(preset.id),
                    label: `${preset.label} (${preset.whenLabel})`
                  })),
                  {
                    id: 'snooze:custom' as const,
                    label: t('rail.snoozeCustom'),
                    separatorBefore: state.snoozePresets.length > 0
                  }
                ]
              }
        ]
      : []),
    { id: 'rename', label: t('rail.rename'), icon: 'pencil', separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: 'regenerate-title' as const,
            label: t('rail.regenerateTitle'),
            icon: 'refresh-cw',
            disabled: state.isRegeneratingTitle
          }
        ]
      : []),
    state.markedUnread
      ? { id: 'mark-read' as const, label: t('rail.markRead'), icon: 'mail-open' }
      : { id: 'mark-unread' as const, label: t('rail.markUnread'), icon: 'mail' },
    {
      id: 'copy',
      label: t('sidebar.t3.copy'),
      icon: 'copy',
      separatorBefore: true,
      children: [
        { id: 'copy-path', label: t('rail.copyPath'), icon: 'folder' },
        { id: 'copy-thread', label: t('sidebar.t3.copyThread'), icon: 'message-square' },
        { id: 'copy-thread-id', label: t('sidebar.t3.copyThreadId'), icon: 'hash' }
      ]
    },
    { id: 'project-settings', label: t('sidebar.t3.projectSettings'), icon: 'settings' },
    state.isArchived
      ? { id: 'unarchive', label: t('rail.unarchive'), icon: 'archive-restore', separatorBefore: true }
      : {
          id: 'archive',
          label: t('rail.archive'),
          icon: 'archive',
          disabled: state.isRunning,
          separatorBefore: true
        },
    { id: 'delete', label: t('rail.delete'), destructive: true, icon: 'trash' }
  ]
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children ? { children: item.children.map((child) => ({ ...child, disabled: true })) } : {})
            }
          : item
      )
}
