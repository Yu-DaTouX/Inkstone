import type { ReactElement, RefObject } from 'react'
import { Copy, ExternalLink, FolderOpen, Link2, Plus, Tag } from 'lucide-react'
import { Menu, MenuItem, Popover } from '../../ui'
import { toAbsolutePath, type FileTreeRow } from './files-model'
import type { FilesText } from './files-text'

export type FilesMenuKey =
  | 'copyPath'
  | 'copyRelativePath'
  | 'copyName'
  | 'addContext'
  | 'reveal'
  | 'open'

const BLOCKED_OPEN_EXTENSIONS = new Set([
  'exe',
  'msi',
  'msp',
  'bat',
  'cmd',
  'ps1',
  'lnk',
  'url',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'scr',
  'com',
  'pif',
  'cpl',
  'jar',
  'reg',
  'msc',
  'inf',
  'gadget'
])

export function canOpenWithSystem(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return true
  return !BLOCKED_OPEN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export interface FilesRowMenuProps {
  row: FileTreeRow
  text: FilesText
  cwd: string
  canAdd: boolean
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (path: string) => void
}

export function FilesRowMenu({
  row,
  text,
  cwd,
  canAdd,
  anchor,
  open,
  onOpenChange,
  onAdd
}: FilesRowMenuProps): ReactElement {
  const run = (key: FilesMenuKey): void => {
    const abs = toAbsolutePath(cwd, row.path)
    switch (key) {
      case 'copyPath':
        void navigator.clipboard.writeText(abs)
        return
      case 'copyRelativePath':
        void navigator.clipboard.writeText(row.path)
        return
      case 'copyName':
        void navigator.clipboard.writeText(row.name)
        return
      case 'addContext':
        onAdd(row.path)
        return
      case 'reveal':
        void window.yan.revealPath(abs)
        return
      case 'open':
        void window.yan.openPath(abs)
    }
  }

  return (
    <Popover triggerRef={anchor} isOpen={open} onOpenChange={onOpenChange} placement="bottom start" offset={4}>
      <Menu
        aria-label={row.name || text.treeLabel}
        autoFocus="first"
        onAction={(key) => run(key as FilesMenuKey)}
        onClose={() => onOpenChange(false)}
        data-testid="v3-files-menu"
      >
        <MenuItem id="copyPath" textValue={text.copyPath}>
          <Copy size={14} aria-hidden />
          {text.copyPath}
        </MenuItem>
        {row.path === '' ? null : (
          <MenuItem id="copyRelativePath" textValue={text.copyRelativePath}>
            <Link2 size={14} aria-hidden />
            {text.copyRelativePath}
          </MenuItem>
        )}
        <MenuItem id="copyName" textValue={text.copyName}>
          <Tag size={14} aria-hidden />
          {text.copyName}
        </MenuItem>
        {canAdd && !row.dir ? (
          <MenuItem id="addContext" textValue={text.addContext}>
            <Plus size={14} aria-hidden />
            {text.addContext}
          </MenuItem>
        ) : null}
        <MenuItem id="reveal" textValue={text.reveal}>
          <FolderOpen size={14} aria-hidden />
          {text.reveal}
        </MenuItem>
        {row.dir || canOpenWithSystem(row.name) ? (
          <MenuItem id="open" textValue={text.openWithSystem}>
            <ExternalLink size={14} aria-hidden />
            {text.openWithSystem}
          </MenuItem>
        ) : null}
      </Menu>
    </Popover>
  )
}
