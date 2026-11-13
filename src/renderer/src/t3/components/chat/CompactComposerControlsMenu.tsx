import { memo, type ReactNode } from 'react'
import { Dialog, DialogTrigger } from 'react-aria-components'
import { EllipsisIcon } from '../../../ui/icons'
import type { PermissionMode } from '../../../../../shared/approval'
import type { RuntimeModeOption } from '../../adapters/composer-permissions'
import { useT } from '../../../i18n'
import { Popover } from '../../../ui'
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from './ComposerControl'
import { ComposerPermissionsSection } from './ComposerFooterControls'
import { composerFloatingLayerProps, composerMenuClosed } from './composerEventScope'
import { ComposerMenuCloseProvider } from './composerMenuClose'
import { useComposerMenuState } from './useComposerMenuState'
import './ComposerControlMenus.css'

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  runtimeMode: PermissionMode
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>
  traitsMenuContent?: ReactNode
  showPermissions?: boolean
  size?: ComposerControlSize
  hidden?: boolean
  onRuntimeModeChange: (mode: PermissionMode) => void
}) {
  const t = useT()
  const size = props.size ?? 'sm'
  const [open, setOpen] = useComposerMenuState(props.hidden)

  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) composerMenuClosed()
      }}
    >
      <ComposerControl
        size={size}
        className="t3-compact-menu__trigger"
        aria-label={t('composer.t3.moreControls')}
        data-composer-shortcut={
          [
            props.showPermissions !== false ? 'composer.mode' : null,
            props.traitsMenuContent ? 'composer.effort' : null
          ]
            .filter(Boolean)
            .join(' ') || undefined
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </ComposerControl>
      <Popover placement="top start" offset={4} {...composerFloatingLayerProps}>
        <Dialog aria-label={t('composer.t3.moreControls')} className="t3-compact-menu__dialog">
          <ComposerMenuCloseProvider value={() => setOpen(false)}>
          {props.traitsMenuContent ? (
            <>
              {props.traitsMenuContent}
              {props.showPermissions !== false ? (
                <div className="t3-compact-menu__separator" role="separator" />
              ) : null}
            </>
          ) : null}
          {props.showPermissions === false ? null : (
            <ComposerPermissionsSection
              runtimeMode={props.runtimeMode}
              runtimeModeOptions={props.runtimeModeOptions}
              onRuntimeModeChange={(mode) => {
                props.onRuntimeModeChange(mode)
                setOpen(false)
              }}
            />
          )}
          </ComposerMenuCloseProvider>
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
})
