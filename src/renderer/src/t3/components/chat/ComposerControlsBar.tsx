import { CircleAlertIcon } from 'lucide-react'
import { useT } from '../../../i18n'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useComposerTraits } from '../../adapters/composer-thinking'
import { usePermissionAdapter } from '../../adapters/composer-permissions'
import { useStore } from '../../../state/store'
import { fastModeSupported } from '../../../../../shared/fast-mode'
import { UltracodeConfirmDialog } from '../../../patterns/UltracodeConfirmDialog'
import { cn } from '../../lib/utils'
import { ComposerControl } from './ComposerControl'
import { ComposerFooterModeControls } from './ComposerFooterControls'
import { CompactComposerControlsMenu } from './CompactComposerControlsMenu'
import { ComposerAccessFooter, ComposerReasoningPanel, FastBolt } from './ComposerModelMenuPanels'
import { TraitsMenuContent, TraitsPicker } from './TraitsPicker'
import { resolveComposerControlsOwnership } from './composerControlsOwnership'

export type ComposerModelMenu = {
  open: boolean
  onOpenChange: (open: boolean) => void
  aside: ReactNode
  footer: ReactNode
  badge: ReactNode
}

const REOPEN_GUARD_MS = 250

export function ComposerControlsBar(props: {
  modelPicker: (menu: ComposerModelMenu) => ReactNode
  collapsed: boolean
  hidden: boolean
  measuredHiddenBlockCount: number
  iconOnlyBlockCount: number
  showProviderUnavailable?: boolean
  providerSetupLabel?: string
  onOpenProviderSetup?: () => void
}) {
  const t = useT()
  const traits = useComposerTraits()
  const permissions = usePermissionAdapter()
  const iconOnlyBlockCount = props.iconOnlyBlockCount
  const [menuOpen, setMenuOpen] = useState(false)
  const closedAtRef = useRef(0)
  const changeMenuOpen = useCallback((open: boolean) => {
    if (!open) closedAtRef.current = performance.now()
    setMenuOpen(open)
  }, [])
  const openMenu = useCallback(() => {
    if (performance.now() - closedAtRef.current < REOPEN_GUARD_MS) return
    setMenuOpen(true)
  }, [])
  const unrestricted = permissions.mode === 'all'
  const fastSupported = useStore((s) => fastModeSupported(s.session?.model))
  const fastOn = useStore((s) => s.settings?.fastMode === true)
  const patchSettings = useStore((s) => s.patchSettings)
  const notify = useStore((s) => s.notify)
  const setFast = useCallback(
    (fast: boolean) => {
      void patchSettings({ fastMode: fast }).catch((error) => notify('error', String(error)))
    },
    [notify, patchSettings]
  )
  const menu: ComposerModelMenu = {
    open: menuOpen,
    onOpenChange: changeMenuOpen,
    aside: traits ? <ComposerReasoningPanel traits={traits} /> : null,
    badge: fastSupported && fastOn ? <FastBolt label={t('picker.speed.fast')} /> : null,
    footer: (
      <ComposerAccessFooter
        speed={fastSupported ? { fast: fastOn, onChange: setFast } : null}
        mode={permissions.mode}
        onModeChange={permissions.setMode}
      />
    )
  }

  const {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: restingHiddenBlockCount,
    hiddenBlockIds: hiddenRestingBlockIds,
    traitsHidden: traitsBlockHidden
  } = resolveComposerControlsOwnership({
    matchesDefault: permissions.matchesDefault,
    hasTraits: traits !== null,
    showMode: unrestricted,
    collapsed: props.collapsed,
    measuredHiddenBlockCount: props.measuredHiddenBlockCount
  })
  const size = props.collapsed ? 'xs' : 'sm'
  const overflowTraits = hiddenRestingBlockIds.includes('traits')
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
                onOpen={openMenu}
                expanded={menuOpen}
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
                onOpen={openMenu}
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
          {props.modelPicker(menu)}
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
            aria-hidden={!overflowTraits || undefined}
            inert={!overflowTraits || undefined}
            className={cn(
              'min-w-0 shrink-0',
              !overflowTraits && 'pointer-events-none invisible absolute'
            )}
          >
            <CompactComposerControlsMenu
              runtimeMode={permissions.mode}
              runtimeModeOptions={permissions.options}
              size={size}
              hidden={props.hidden || !overflowTraits}
              traitsMenuContent={
                overflowTraits && traits ? (
                  <TraitsMenuContent traits={traits} />
                ) : undefined
              }
              showPermissions={false}
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
