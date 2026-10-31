import { CircleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useComposerTraits } from '../../adapters/composer-thinking'
import { usePermissionAdapter } from '../../adapters/composer-permissions'
import { UltracodeConfirmDialog } from '../../../patterns/UltracodeConfirmDialog'
import { cn } from '../../lib/utils'
import { ComposerControl } from './ComposerControl'
import { ComposerFooterModeControls } from './ComposerFooterControls'
import { CompactComposerControlsMenu } from './CompactComposerControlsMenu'
import { TraitsMenuContent, TraitsPicker } from './TraitsPicker'
import { resolveComposerControlsOwnership } from './composerControlsOwnership'

export function ComposerControlsBar(props: {
  modelPicker: ReactNode
  collapsed: boolean
  hidden: boolean
  measuredHiddenBlockCount: number
  iconOnlyBlockCount: number
  showProviderUnavailable?: boolean
  providerSetupLabel?: string
  onOpenProviderSetup?: () => void
}) {
  const traits = useComposerTraits()
  const permissions = usePermissionAdapter()
  const iconOnlyBlockCount = props.iconOnlyBlockCount

  const {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: restingHiddenBlockCount,
    hiddenBlockIds: hiddenRestingBlockIds,
    traitsHidden: traitsBlockHidden,
    overflowShowsPermissions
  } = resolveComposerControlsOwnership({
    matchesDefault: permissions.matchesDefault,
    hasTraits: traits !== null,
    collapsed: props.collapsed,
    measuredHiddenBlockCount: props.measuredHiddenBlockCount
  })
  const size = props.collapsed ? 'xs' : 'sm'
  const restingBlockDefs = [
    ...(traits
      ? [
          {
            id: 'traits',
            content: (
              <TraitsPicker
                traits={traits}
                size={size}
                hidden={props.hidden || traitsBlockHidden}
                isComposerOwned
              />
            )
          }
        ]
      : []),
    ...(!showModeBlock
      ? []
      : [
          {
            id: 'mode',
            content: (
              <ComposerFooterModeControls
                runtimeMode={permissions.mode}
                size={size}
                hidden={props.hidden || restingHiddenBlockCount > 0}
                accessDisplay={accessDisplay}
                pendingMode={permissions.pendingMode}
                onRuntimeModeChange={permissions.requestMode}
                onConfirmPending={permissions.confirmPending}
                onCancelPending={permissions.cancelPending}
              />
            )
          }
        ])
  ]

  return (
    <>
      {props.showProviderUnavailable ? (
        <ComposerControl
          type="button"
          disabled={!props.onOpenProviderSetup}
          onClick={() => props.onOpenProviderSetup?.()}
          data-chat-provider-unavailable="true"
          className="shrink-0"
        >
          <CircleAlertIcon className="size-4" />
          {props.providerSetupLabel}
        </ComposerControl>
      ) : (
        <>
          {props.modelPicker}
          {restingBlockDefs.map((def, index) => {
            const hidden = index >= restingBlockDefs.length - restingHiddenBlockCount
            return (
              <div
                key={def.id}
                data-resting-block={def.id}
                data-composer-block-icon-only={
                  index >= restingBlockDefs.length - iconOnlyBlockCount ? 'true' : 'false'
                }
                aria-hidden={hidden || undefined}
                inert={hidden || undefined}
                className={cn(
                  'flex w-max min-w-max shrink-0 items-center gap-1',
                  def.id === 'traits' && '[[data-chat-provider-model-picker]+&]:-ms-0.5',
                  hidden && 'pointer-events-none invisible absolute',
                  index >= restingBlockDefs.length - iconOnlyBlockCount &&
                    '[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative'
                )}
              >
                {def.content}
              </div>
            )
          })}
          <div
            data-resting-controls-overflow
            aria-hidden={hiddenRestingBlockIds.length === 0 || undefined}
            inert={hiddenRestingBlockIds.length === 0 || undefined}
            className={cn(
              'min-w-0 shrink-0',
              hiddenRestingBlockIds.length === 0 && 'pointer-events-none invisible absolute'
            )}
          >
            <CompactComposerControlsMenu
              runtimeMode={permissions.mode}
              runtimeModeOptions={permissions.options}
              size={size}
              hidden={props.hidden || hiddenRestingBlockIds.length === 0}
              traitsMenuContent={
                hiddenRestingBlockIds.includes('traits') && traits ? (
                  <TraitsMenuContent traits={traits} />
                ) : undefined
              }
              showPermissions={overflowShowsPermissions}
              onRuntimeModeChange={permissions.requestMode}
            />
          </div>
        </>
      )}
      {traits ? (
        <UltracodeConfirmDialog
          isOpen={traits.ultracodeConfirmOpen}
          onCancel={traits.cancelUltracode}
          onConfirm={traits.confirmUltracode}
        />
      ) : null}
    </>
  )
}
