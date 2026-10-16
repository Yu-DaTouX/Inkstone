import type { SessionQuestionFrequency } from './question-frequency'

export const WORK_MODES = ['standard', 'clarify', 'autonomous'] as const

export type WorkMode = (typeof WORK_MODES)[number]

export const DEFAULT_WORK_MODE: WorkMode = 'standard'

export interface WorkModeState {
  mode: WorkMode
  revision: number
  pendingMode?: WorkMode
  questionFrequency?: SessionQuestionFrequency
}

export function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === 'string' && (WORK_MODES as readonly string[]).includes(value)
}

export function normalizeWorkMode(value: unknown): WorkMode {
  return isWorkMode(value) ? value : DEFAULT_WORK_MODE
}

export function nextWorkMode(current: WorkMode): WorkMode {
  const index = WORK_MODES.indexOf(normalizeWorkMode(current))
  return WORK_MODES[(index + 1) % WORK_MODES.length]
}

export function migrateLegacyAutonomous(defaultWorkMode: unknown, legacyAutonomous: unknown): WorkMode {
  if (isWorkMode(defaultWorkMode)) return defaultWorkMode
  return legacyAutonomous === true ? 'autonomous' : DEFAULT_WORK_MODE
}

export function isWorkModeShortcutEnabled(value: unknown): boolean {
  return value !== false
}

export const DEFAULT_WORK_MODE_BINDING = 'Ctrl+Tab'

export interface KeyBinding {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
}

export interface KeyLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const MODIFIER_KEY_NAMES = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock']

export function normalizeKeyName(key: string): string {
  if (key === ' ') return 'Space'
  return key.length === 1 ? key.toUpperCase() : key
}

export function formatKeyBinding(binding: KeyBinding): string {
  const mods: string[] = []
  if (binding.ctrl) mods.push('Ctrl')
  if (binding.alt) mods.push('Alt')
  if (binding.shift) mods.push('Shift')
  if (binding.meta) mods.push('Meta')
  return [...mods, binding.key].join('+')
}

export function parseKeyBinding(text: unknown): KeyBinding | null {
  if (typeof text !== 'string') return null
  const parts = text
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const binding: KeyBinding = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: normalizeKeyName(parts[parts.length - 1])
  }
  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') binding.ctrl = true
    else if (lower === 'alt') binding.alt = true
    else if (lower === 'shift') binding.shift = true
    else if (lower === 'meta' || lower === 'cmd' || lower === 'super') binding.meta = true
    else return null
  }
  return binding
}

export function bindingFromKey(key: KeyLike): KeyBinding | null {
  if (MODIFIER_KEY_NAMES.includes(key.key)) return null
  return {
    ctrl: key.ctrlKey,
    alt: key.altKey,
    shift: key.shiftKey,
    meta: key.metaKey,
    key: normalizeKeyName(key.key)
  }
}

export function isUsableKeyBinding(binding: KeyBinding | null): binding is KeyBinding {
  return !!binding && (binding.ctrl || binding.alt || binding.shift || binding.meta)
}

export function normalizeWorkModeShortcut(value: unknown): string | undefined {
  if (value === '') return ''
  const binding = parseKeyBinding(value)
  if (!binding || !isUsableKeyBinding(binding)) return undefined
  return formatKeyBinding(binding)
}

export function matchesKeyBinding(text: string | undefined, key: KeyLike): boolean {
  const binding = parseKeyBinding(text || DEFAULT_WORK_MODE_BINDING)
  if (!binding) return false
  return (
    binding.key === normalizeKeyName(key.key) &&
    binding.ctrl === key.ctrlKey &&
    binding.alt === key.altKey &&
    binding.shift === key.shiftKey &&
    binding.meta === key.metaKey
  )
}
