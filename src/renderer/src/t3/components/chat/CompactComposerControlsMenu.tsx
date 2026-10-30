import { memo, useRef, type ReactNode } from 'react'
import { EllipsisIcon } from 'lucide-react'
import type { PermissionMode } from '../../../../../shared/approval'
import type { RuntimeModeOption } from '../../adapters/composer-permissions'
import { useT } from '../../../i18n'
import { Menu, MenuPopup, MenuTrigger } from '../ui/menu'
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from './ComposerControl'
import { ComposerPermissionsSection } from './ComposerFooterControls'
import { focusRequestedPermission, useComposerMenuProps } from './composerEventScope'
import { useComposerMenuState } from './useComposerMenuState'

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
  const composerFloatingLayerProps = useComposerMenuProps()
  const size = props.size ?? 'sm'
  const [open, setOpen] = useComposerMenuState(props.hidden)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
    >
      <MenuTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            size={size}
            className="shrink-0"
            aria-label={t('composer.t3.moreControls')}
            data-composer-shortcut={
              [
                props.showPermissions !== false ? 'composer.mode' : null,
                props.traitsMenuContent ? 'composer.effort' : null
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            {props.showPermissions !== false ? (
              <div className="mx-2 my-1 h-px bg-border" role="separator" />
            ) : null}
          </>
        ) : null}
        {props.showPermissions === false ? null : (
          <ComposerPermissionsSection
            runtimeMode={props.runtimeMode}
            runtimeModeOptions={props.runtimeModeOptions}
            onRuntimeModeChange={props.onRuntimeModeChange}
          />
        )}
      </MenuPopup>
    </Menu>
  )
})
