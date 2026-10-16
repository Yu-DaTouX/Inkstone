/**
 * 快捷键改绑的纯逻辑（设置 → 快捷键，WP-25b 余项）。
 *
 * 复用 `app/shortcuts.ts` 的注册表类型、归一化签名与覆盖应用：改绑、冲突判定与
 * 外壳运行时按键分发共用同一套规则，设置页不另算一套。覆盖表的类型与
 * 「取生效键位」也在 `app/shortcuts.ts`，这里再导出同名入口方便设置分区引用。
 *
 * 本文件保持无副作用：不 import React / store / DOM，便于 `scripts/test-v3-settings-shortcuts.mjs`
 * 直接在 Node 里钉死按键归纳、冲突与恢复默认。
 */
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

/** 兼容旧名：设置分区与 `ShellV3` 用 `effectiveKeys(def, overrides)` 取生效键位。 */
export const effectiveKeys = effectiveShortcutKeys

/** 一次按键（`KeyboardEvent` 里与改绑有关的字段子集）。 */
export interface KeyStroke {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  /** 输入法组字中：归输入法，不当快捷键。 */
  composing?: boolean
  /** AltGr（欧洲键盘的 Ctrl+Alt）不能被当成 Ctrl+Alt。 */
  altGraph?: boolean
}

const MODIFIER_KEYS = new Set(['control', 'meta', 'alt', 'shift', 'altgraph', 'os'])

/** DOM 键名 → 注册表里的显示记号（与 `app/shortcuts.ts` 的别名方向相反）。 */
const DISPLAY_ALIAS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓'
}

/**
 * 把一次按键收成注册表键位（如 `['Ctrl', 'Alt', 'B']`，顺序与注册表一致）。
 * 只按修饰键、输入法组字或 AltGr 时返回 null。
 */
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

/** 无修饰键时只允许 F1–F24：避免把单个字母 / 方向键抢成全局键。 */
function hasModifierOrFunctionKey(keys: readonly string[]): boolean {
  if (keys.length > 1) return true
  return /^F([1-9]|1\d|2[0-4])$/.test(keys[keys.length - 1] ?? '')
}

/**
 * 校验一次改绑：空键位、不可改项、缺修饰键或与其它项生效键位冲突都拒绝，
 * 成功时返回新的覆盖表。冲突只看归一化签名，所以修饰键顺序不同也算同一键位。
 */
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

/** 恢复默认：不传 id 清掉全部覆盖，传 id 只清那一项。 */
export function clearShortcutOverrides(overrides: ShortcutOverrides, id?: ShortcutId): ShortcutOverrides {
  if (!id) return EMPTY_SHORTCUT_OVERRIDES
  if (!(id in overrides)) return overrides
  const next: Record<string, readonly string[]> = { ...overrides }
  delete next[id]
  return next as ShortcutOverrides
}
