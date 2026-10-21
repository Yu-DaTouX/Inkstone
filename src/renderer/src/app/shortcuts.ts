export type ShortcutId =
  | 'commandPalette'
  | 'newSession'
  | 'toggleSidebar'
  | 'toggleWorkspace'
  | 'openSettings'
  | 'shortcutSheet'
  | 'goBack'
  | 'stopRun'
  | 'focusComposer'
  | 'copyLastReply'
  | 'openTerminal'
  | 'workspaceTab1'
  | 'workspaceTab2'
  | 'workspaceTab3'
  | 'workspaceTab4'
  | 'workspaceTab5'
  | 'workspaceTab6'
  | 'workspaceClosePane'
  | 'workspaceToggleMaximize'
  | 'splitFocusNext'
  | 'splitFocusPrevious'
  | 'splitNewRight'
  | 'splitNewBelow'
  | 'splitClose'
  | 'splitFocusLeft'
  | 'splitFocusRight'
  | 'splitFocusUp'
  | 'splitFocusDown'
  | 'cycleTranscriptView'
  | 'cycleModel'
  | 'cycleModelBack'
  | 'cycleThinking'
  | 'quickAsk'

export type ShortcutRegistration = 'renderer' | 'host'

export type ShortcutPurposeKey = ShortcutId

export interface ShortcutDef {
  id: ShortcutId
  keys: readonly string[]
  purposeKey: ShortcutPurposeKey
  rebindable: boolean
  scope: 'global'
  terminalsYield: boolean
  registeredBy: ShortcutRegistration
}

export type ShortcutOverrides = Readonly<Partial<Record<ShortcutId, readonly string[]>>>

export const EMPTY_SHORTCUT_OVERRIDES: ShortcutOverrides = {}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'commandPalette', keys: ['Ctrl', 'K'], purposeKey: 'commandPalette', rebindable: false, scope: 'global', terminalsYield: true, registeredBy: 'renderer' },
  { id: 'newSession', keys: ['Ctrl', 'N'], purposeKey: 'newSession', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'toggleSidebar', keys: ['Ctrl', 'B'], purposeKey: 'toggleSidebar', rebindable: false, scope: 'global', terminalsYield: true, registeredBy: 'renderer' },
  { id: 'toggleWorkspace', keys: ['Ctrl', 'Alt', 'B'], purposeKey: 'toggleWorkspace', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'openSettings', keys: ['Ctrl', ','], purposeKey: 'openSettings', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'shortcutSheet', keys: ['Ctrl', '/'], purposeKey: 'shortcutSheet', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'goBack', keys: ['Alt', '←'], purposeKey: 'goBack', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'stopRun', keys: ['Ctrl', '.'], purposeKey: 'stopRun', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'focusComposer', keys: ['Ctrl', 'L'], purposeKey: 'focusComposer', rebindable: false, scope: 'global', terminalsYield: true, registeredBy: 'renderer' },
  { id: 'copyLastReply', keys: ['Ctrl', 'Shift', 'C'], purposeKey: 'copyLastReply', rebindable: false, scope: 'global', terminalsYield: true, registeredBy: 'renderer' },
  { id: 'openTerminal', keys: ['Ctrl', '`'], purposeKey: 'openTerminal', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab1', keys: ['Alt', '1'], purposeKey: 'workspaceTab1', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab2', keys: ['Alt', '2'], purposeKey: 'workspaceTab2', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab3', keys: ['Alt', '3'], purposeKey: 'workspaceTab3', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab4', keys: ['Alt', '4'], purposeKey: 'workspaceTab4', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab5', keys: ['Alt', '5'], purposeKey: 'workspaceTab5', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab6', keys: ['Alt', '6'], purposeKey: 'workspaceTab6', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceClosePane', keys: ['Ctrl', '\\'], purposeKey: 'workspaceClosePane', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceToggleMaximize', keys: ['Ctrl', 'Shift', '\\'], purposeKey: 'workspaceToggleMaximize', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'splitFocusNext', keys: ['Ctrl', 'Alt', ']'], purposeKey: 'splitFocusNext', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'splitFocusPrevious', keys: ['Ctrl', 'Alt', '['], purposeKey: 'splitFocusPrevious', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'splitNewRight', keys: ['Ctrl', 'Alt', '\\'], purposeKey: 'splitNewRight', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'splitNewBelow', keys: ['Ctrl', 'Alt', '-'], purposeKey: 'splitNewBelow', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'splitClose', keys: ['Ctrl', 'Alt', 'W'], purposeKey: 'splitClose', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'splitFocusLeft', keys: ['Ctrl', 'Alt', '←'], purposeKey: 'splitFocusLeft', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'splitFocusRight', keys: ['Ctrl', 'Alt', '→'], purposeKey: 'splitFocusRight', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'splitFocusUp', keys: ['Ctrl', 'Alt', '↑'], purposeKey: 'splitFocusUp', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'splitFocusDown', keys: ['Ctrl', 'Alt', '↓'], purposeKey: 'splitFocusDown', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'cycleTranscriptView', keys: ['Ctrl', 'O'], purposeKey: 'cycleTranscriptView', rebindable: false, scope: 'global', terminalsYield: true, registeredBy: 'renderer' },
  { id: 'cycleModel', keys: ['Ctrl', 'P'], purposeKey: 'cycleModel', rebindable: false, scope: 'global', terminalsYield: false, registeredBy: 'host' },
  { id: 'cycleModelBack', keys: ['Ctrl', 'Shift', 'P'], purposeKey: 'cycleModelBack', rebindable: false, scope: 'global', terminalsYield: false, registeredBy: 'host' },
  { id: 'cycleThinking', keys: ['Shift', 'Tab'], purposeKey: 'cycleThinking', rebindable: false, scope: 'global', terminalsYield: false, registeredBy: 'host' },
  { id: 'quickAsk', keys: ['Alt', 'Shift', 'Space'], purposeKey: 'quickAsk', rebindable: false, scope: 'global', terminalsYield: false, registeredBy: 'host' }
]

const SHORTCUT_ID_SET: ReadonlySet<string> = new Set(SHORTCUTS.map((def) => def.id))
const SHORTCUT_REBINDABLE_SET: ReadonlySet<string> = new Set(SHORTCUTS.filter((def) => def.rebindable).map((def) => def.id))

export const RENDERER_SHORTCUTS: readonly ShortcutDef[] = SHORTCUTS.filter((def) => def.registeredBy === 'renderer')

export const HOST_SHORTCUTS: readonly ShortcutDef[] = SHORTCUTS.filter((def) => def.registeredBy === 'host')

export function sanitizeShortcutOverrides(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_SHORTCUT_OVERRIDES
  const result: Record<string, readonly string[]> = {}
  for (const [id, keys] of Object.entries(value as Record<string, unknown>)) {
    if (!SHORTCUT_ID_SET.has(id) || !SHORTCUT_REBINDABLE_SET.has(id)) continue
    if (!Array.isArray(keys) || keys.length === 0) continue
    if (!keys.every((key) => typeof key === 'string' && key.length > 0)) continue
    result[id] = keys.slice()
  }
  return result as ShortcutOverrides
}

export function shortcutOverridesFromSettings(settings: unknown): ShortcutOverrides {
  const holder = settings as { shortcutOverrides?: unknown } | null | undefined
  return sanitizeShortcutOverrides(holder?.shortcutOverrides)
}

export function applyShortcutOverrides(
  overrides: ShortcutOverrides,
  defs: readonly ShortcutDef[] = SHORTCUTS
): ShortcutDef[] {
  return defs.map((def) => {
    const keys = overrides[def.id]
    return keys && keys.length ? { ...def, keys } : def
  })
}

export function effectiveShortcutKeys(def: ShortcutDef, overrides: ShortcutOverrides): readonly string[] {
  return overrides[def.id] ?? def.keys
}

export function shortcutKeysText(id: ShortcutId, overrides: ShortcutOverrides = EMPTY_SHORTCUT_OVERRIDES): string {
  const def = SHORTCUTS.find((item) => item.id === id)
  return def ? effectiveShortcutKeys(def, overrides).join('+') : ''
}

const KEY_ALIAS: Record<string, string> = {
  '←': 'arrowleft',
  '→': 'arrowright',
  '↑': 'arrowup',
  '↓': 'arrowdown'
}

const MODIFIERS = new Set(['ctrl', 'meta', 'shift', 'alt'])

export function shortcutKeyToken(keys: readonly string[]): string {
  const last = keys[keys.length - 1] ?? ''
  return (KEY_ALIAS[last] ?? last).toLowerCase()
}

function bindingModifiers(keys: readonly string[]): { ctrl: boolean; shift: boolean; alt: boolean } {
  const modifiers = new Set(keys.slice(0, -1).map((key) => key.toLowerCase()))
  return {
    ctrl: modifiers.has('ctrl') || modifiers.has('meta'),
    shift: modifiers.has('shift'),
    alt: modifiers.has('alt')
  }
}

export function shortcutSignature(def: ShortcutDef): string {
  const modifiers = def.keys
    .slice(0, -1)
    .map((key) => key.toLowerCase())
    .filter((key) => MODIFIERS.has(key))
    .sort()
  return [...modifiers, shortcutKeyToken(def.keys)].join('+')
}

export function findShortcutConflicts(defs: readonly ShortcutDef[] = SHORTCUTS): string[] {
  const seen = new Map<string, ShortcutId>()
  const conflicts: string[] = []
  for (const def of defs) {
    const signature = shortcutSignature(def)
    const previous = seen.get(signature)
    if (previous) conflicts.push(`${previous} / ${def.id}: ${def.keys.join('+')}`)
    else seen.set(signature, def.id)
  }
  return conflicts
}

export interface V3KeyState {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  composing?: boolean
  repeat?: boolean
  altGraph?: boolean
  modalOpen?: boolean
  inTerminal?: boolean
  editing?: boolean
}

const EDITING_KEYS: ReadonlySet<string> = new Set([
  'arrowleft',
  'arrowright',
  'arrowup',
  'arrowdown',
  'home',
  'end',
  'pageup',
  'pagedown',
  'backspace',
  'delete',
  'enter',
  'tab',
  'escape',
  'space',
  ' '
])

export function resolveV3Shortcut(
  state: V3KeyState,
  overrides: ShortcutOverrides = EMPTY_SHORTCUT_OVERRIDES
): ShortcutId | null {
  if (state.composing || state.repeat || state.altGraph || state.modalOpen) return null
  const ctrl = state.ctrl || state.meta
  const key = (KEY_ALIAS[state.key] ?? state.key).toLowerCase()
  if (state.editing && !ctrl && EDITING_KEYS.has(key)) return null
  const defs = overrides === EMPTY_SHORTCUT_OVERRIDES ? SHORTCUTS : applyShortcutOverrides(overrides)
  for (const def of defs) {
    if (def.registeredBy !== 'renderer') continue
    const modifiers = bindingModifiers(def.keys)
    if (ctrl !== modifiers.ctrl || state.shift !== modifiers.shift || state.alt !== modifiers.alt) continue
    if (key !== shortcutKeyToken(def.keys)) continue
    if (state.inTerminal && def.terminalsYield) continue
    return def.id
  }
  return null
}
