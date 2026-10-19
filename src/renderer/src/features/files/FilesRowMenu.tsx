import type { Key, ReactElement, RefObject } from 'react'
import { Menu, MenuItem, MenuSection, Popover, Separator, SubmenuTrigger } from '../../ui'
import { toAbsolutePath } from './files-model'
import { attachablePaths, copyTextFor, filesMenuModel, type FilesCopyKind, type FilesMenuTarget } from './files-menu'
import type { FilesText } from './files-text'

export interface FilesRowMenuProps {
  targets: readonly FilesMenuTarget[]
  text: FilesText
  cwd: string
  canAdd: boolean
  canTerminal: boolean
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
  onAttach: (paths: string[]) => void
  onPreview: (path: string) => void
  onTerminal: (path: string) => void
}

type MenuKey = 'attach' | 'copy:absolute' | 'copy:relative' | 'copy:name' | 'open:default' | 'open:preview' | 'reveal' | 'terminal'

export function FilesRowMenu({
  targets,
  text,
  cwd,
  canAdd,
  canTerminal,
  anchor,
  open,
  onOpenChange,
  onAttach,
  onPreview,
  onTerminal
}: FilesRowMenuProps): ReactElement | null {
  const first = targets[0]
  if (!first) return null
  const model = filesMenuModel(targets, { canAdd, canTerminal })
  const run = (key: MenuKey): void => {
    switch (key) {
      case 'attach':
        onAttach(attachablePaths(targets))
        return
      case 'copy:absolute':
      case 'copy:relative':
      case 'copy:name':
        void navigator.clipboard.writeText(copyTextFor(targets, cwd, key.slice(5) as FilesCopyKind))
        return
      case 'open:default':
        void window.yan.openPath(toAbsolutePath(cwd, first.path))
        return
      case 'open:preview':
        onPreview(first.path)
        return
      case 'reveal':
        void window.yan.revealPath(toAbsolutePath(cwd, first.path))
        return
      case 'terminal':
        onTerminal(first.path)
    }
  }
  const onAction = (key: Key): void => {
    run(String(key) as MenuKey)
    onOpenChange(false)
  }
  const label = model.plural ? text.selectedCount.replace('{n}', String(model.count)) : first.name
  const hasOpen = model.openDefault || model.openPreview

  return (
    <Popover triggerRef={anchor} isOpen={open} onOpenChange={onOpenChange} placement="bottom start" offset={4}>
      <Menu aria-label={label} autoFocus="first" onAction={onAction} onClose={() => onOpenChange(false)} data-testid="v3-files-menu">
        <MenuSection aria-label={label}>
          {model.attach ? (
            <MenuItem id="attach" textValue={text.attach}>
              {text.attach}
            </MenuItem>
          ) : null}
          <SubmenuTrigger>
            <MenuItem id="copy" textValue={text.copy}>
              {text.copy}
            </MenuItem>
            <Popover placement="end top" offset={2}>
              <Menu aria-label={text.copy} onAction={onAction} data-testid="v3-files-menu-copy">
                <MenuItem id="copy:absolute" textValue={model.plural ? text.copyAbsolutePlural : text.copyAbsolute}>
                  {model.plural ? text.copyAbsolutePlural : text.copyAbsolute}
                </MenuItem>
                <MenuItem id="copy:relative" textValue={model.plural ? text.copyRelativePlural : text.copyRelative}>
                  {model.plural ? text.copyRelativePlural : text.copyRelative}
                </MenuItem>
                <MenuItem id="copy:name" textValue={model.plural ? text.copyNamePlural : text.copyName}>
                  {model.plural ? text.copyNamePlural : text.copyName}
                </MenuItem>
              </Menu>
            </Popover>
          </SubmenuTrigger>
        </MenuSection>
        {hasOpen ? <Separator /> : null}
        {hasOpen ? (
          <MenuSection aria-label={text.openIn}>
            <SubmenuTrigger>
              <MenuItem id="open" textValue={text.openIn}>
                {text.openIn}
              </MenuItem>
              <Popover placement="end top" offset={2}>
                <Menu aria-label={text.openIn} onAction={onAction} data-testid="v3-files-menu-open">
                  {model.openPreview ? (
                    <MenuItem id="open:preview" textValue={text.openPreview}>
                      {text.openPreview}
                    </MenuItem>
                  ) : null}
                  {model.openDefault ? (
                    <MenuItem id="open:default" textValue={text.openDefault}>
                      {text.openDefault}
                    </MenuItem>
                  ) : null}
                </Menu>
              </Popover>
            </SubmenuTrigger>
          </MenuSection>
        ) : null}
        {model.reveal && !hasOpen ? <Separator /> : null}
        {model.reveal ? (
          <MenuItem id="reveal" textValue={text.reveal}>
            {text.reveal}
          </MenuItem>
        ) : null}
        {model.terminal ? <Separator /> : null}
        {model.terminal ? (
          <MenuItem id="terminal" textValue={text.openTerminal}>
            {text.openTerminal}
          </MenuItem>
        ) : null}
      </Menu>
    </Popover>
  )
}
