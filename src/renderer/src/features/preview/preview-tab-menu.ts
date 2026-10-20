export type PreviewTabAction = 'keep' | 'close' | 'close-others' | 'close-right' | 'close-all'
export type PreviewTabFileAction = 'copy:absolute' | 'copy:relative' | 'copy:name' | 'reveal' | 'reveal-tree'

export interface PreviewTabMenuModel {
  copy: { absolute: string; relative: string | null; name: string }
  reveal: boolean
  revealInTree: boolean
  tabActions: PreviewTabAction[]
}

function relativeInside(abs: string, cwd: string): string | null {
  const path = abs.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root || !path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null
  return path.slice(root.length + 1) || null
}

export function previewTabMenu(input: {
  path: string
  cwd: string
  tabs: readonly string[]
  preview: boolean
  canRevealInTree: boolean
}): PreviewTabMenuModel {
  const index = input.tabs.indexOf(input.path)
  const solo = input.tabs.length <= 1
  const hasRight = index >= 0 && index < input.tabs.length - 1
  const relative = relativeInside(input.path, input.cwd)
  const segments = input.path.replace(/\\/g, '/').split('/').filter(Boolean)
  const tabActions: PreviewTabAction[] = []
  if (input.preview) tabActions.push('keep')
  tabActions.push('close')
  if (!solo) tabActions.push('close-others')
  if (hasRight) tabActions.push('close-right')
  if (!solo) tabActions.push('close-all')
  return {
    copy: { absolute: input.path, relative, name: segments[segments.length - 1] ?? input.path },
    reveal: true,
    revealInTree: input.canRevealInTree && relative !== null,
    tabActions
  }
}

export function previewTabKeyAction(key: string, modifiers: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }): 'close' | 'menu' | null {
  if (modifiers.ctrl || modifiers.alt || modifiers.meta) return null
  if (key === 'Delete' || key === 'Backspace') return modifiers.shift ? null : 'close'
  if (key === 'ContextMenu' || (key === 'F10' && modifiers.shift)) return 'menu'
  return null
}
