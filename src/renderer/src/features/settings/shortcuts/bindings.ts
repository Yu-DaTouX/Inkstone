import {
  effectiveShortcutKeys,
  EMPTY_SHORTCUT_OVERRIDES,
  SHORTCUTS,
  shortcutSignature,
  type ShortcutDef,
  type ShortcutId,
  type ShortcutOverrides
} from '../../../app/shortcuts'

export { applyShortcutOverrides, sanitizeShortcutOverrides } from '../../../app/shortcuts'
export { EMPTY_SHORTCUT_OVERRIDES } from '../../../app/shortcuts'
export type { ShortcutOverrides } from '../../../app/shortcuts'

export const effectiveKeys = effectiveShortcutKeys

export interface KeyStroke {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  composing?: boolean
  altGraph?: boolean
}

const MODIFIER_KEYS = new Set(['control', 'meta', 'alt', 'shift', 'altgraph', 'os'])

const DISPLAY_ALIAS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓'
}

export function bindingFromKeyStroke(stroke: KeyStroke): string[] | null {
  if (stroke.composing || stroke.altGraph) return null
  const raw = stroke.key
  if (!raw || MODIFIER_KEYS.has(raw.toLowerCase())) return null
  const token =
    DISPLAY_ALIAS[raw.toLowerCase()] ?? (raw === ' ' ? 'Space' : raw.length === 1 ? raw.toUpperCase() : raw)
  const keys: string[] = []
  if (stroke.ctrl || stroke.meta) keys.push('Ctrl')
  if (stroke.alt) keys.push('Alt')
  if (stroke.shift) keys.push('Shift')
  keys.push(token)
  return keys
}

export type RebindReason = 'empty' | 'fixed' | 'unmodified' | 'conflict'

export type RebindResult =
  | { ok: true; overrides: ShortcutOverrides }
  | { ok: false; reason: RebindReason; conflictId?: ShortcutId }

function hasModifierOrFunctionKey(keys: readonly string[]): boolean {
  if (keys.length > 1) return true
  return /^F([1-9]|1\d|2[0-4])$/.test(keys[keys.length - 1] ?? '')
}

export function rebindShortcut(
  id: ShortcutId,
  keys: readonly string[],
  overrides: ShortcutOverrides,
  defs: readonly ShortcutDef[] = SHORTCUTS
): RebindResult {
  if (!keys.length) return { ok: false, reason: 'empty' }
  const target = defs.find((def) => def.id === id)
  if (!target) return { ok: false, reason: 'conflict' }
  if (!target.rebindable) return { ok: false, reason: 'fixed' }
  if (!hasModifierOrFunctionKey(keys)) return { ok: false, reason: 'unmodified' }
  const signature = shortcutSignature({ ...target, keys })
  const conflict = defs.find(
    (def) => def.id !== id && shortcutSignature({ ...def, keys: overrides[def.id] ?? def.keys }) === signature
  )
  if (conflict) return { ok: false, reason: 'conflict', conflictId: conflict.id }
  return { ok: true, overrides: { ...overrides, [id]: keys } }
}

export function clearShortcutOverrides(overrides: ShortcutOverrides, id?: ShortcutId): ShortcutOverrides {
  if (!id) return EMPTY_SHORTCUT_OVERRIDES
  if (!(id in overrides)) return overrides
  const next: Record<string, readonly string[]> = { ...overrides }
  delete next[id]
  return next as ShortcutOverrides
}
