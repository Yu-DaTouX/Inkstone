import { toAbsolutePath } from './files-model'

export const MENU_BULK_LIMIT = 100

const BLOCKED_OPEN_EXTENSIONS = new Set([
  'exe', 'msi', 'msp', 'bat', 'cmd', 'ps1', 'psm1', 'lnk', 'url', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'scr',
  'com', 'pif', 'cpl', 'jar', 'reg', 'msc', 'inf', 'gadget', 'appref-ms', 'settingcontent-ms'
])

export function canOpenWithSystem(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return true
  return !BLOCKED_OPEN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export interface FilesMenuTarget {
  path: string
  name: string
  dir: boolean
  blocked?: boolean
}

export interface FilesMenuModel {
  plural: boolean
  count: number
  attach: boolean
  openDefault: boolean
  openPreview: boolean
  reveal: boolean
  terminal: boolean
}

export function filesMenuModel(
  targets: readonly FilesMenuTarget[],
  options: { canAdd: boolean; canTerminal: boolean }
): FilesMenuModel {
  const plural = targets.length > 1
  const first = targets[0]
  const live = !!first && !first.blocked
  return {
    plural,
    count: targets.length,
    attach: options.canAdd && attachablePaths(targets).length > 0,
    openDefault: !plural && live && (first.dir || canOpenWithSystem(first.name)),
    openPreview: !plural && live && !first.dir,
    reveal: !plural && !!first,
    terminal: !plural && live && first.dir && options.canTerminal
  }
}

export function attachablePaths(targets: readonly FilesMenuTarget[]): string[] {
  return targets
    .filter((target) => !target.dir && !target.blocked)
    .slice(0, MENU_BULK_LIMIT)
    .map((target) => target.path)
}

export type FilesCopyKind = 'absolute' | 'relative' | 'name'

export function copyTextFor(targets: readonly FilesMenuTarget[], cwd: string, kind: FilesCopyKind): string {
  return targets
    .map((target) => (kind === 'absolute' ? toAbsolutePath(cwd, target.path) : kind === 'relative' ? target.path : target.name))
    .join('\n')
}

export function terminalCdCommand(abs: string): string {
  return `cd "${abs.replace(/"/g, '')}"\r`
}
