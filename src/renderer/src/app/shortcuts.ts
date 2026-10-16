/**
 * v3 全局快捷键注册表（WP-25b）。
 *
 * 这是 v3 外壳全局键位的**唯一来源**：`ShellV3` 从 `SHORTCUTS`（叠加用户覆盖后）绑定，
 * `features/commands/ShortcutSheet` 也从同一份清单画表，设置页的改绑同样落在这里的
 * 纯函数，避免两处各维护一套。
 *
 * 每项带 `rebindable`：终端会让键的 Ctrl+K/B/J/L 与 Ctrl+Shift+C 保持固定
 *（否则终端让键语义会随改绑漂移），Esc、确认卡 Alt+Y/N 不在注册表里、本来就不参与改绑。
 *
 * 每项还带 `registeredBy`：`renderer` 由 `ShellV3` 从本表绑定；`host` 是主进程
 * `before-input-event`（Ctrl+P / Ctrl+Shift+P / Shift+Tab）与独立快速提问窗口
 *（Alt+Shift+Space）已经注册的键，这里只用于帮助显示与冲突检测，
 * `resolveV3Shortcut` 不会命中它们，避免同一个按键出现两条分发路径。
 *
 * 用户覆盖（`ShortcutOverrides`）只存「改过的项」，读取时按 ShortcutId 覆盖默认键位，
 * 所以以后调整默认键，没改过的用户会跟着变。
 *
 * 为什么不复用 `lib/host-actions.ts` 的 `KEY_BINDINGS`：
 *   · 那是 v2 宿主动作表（会话切换器 / 动作模式）的键位，语义是 v2 的；
 *   · v3 的 Ctrl+K 是命令面板、Ctrl+J 是运行总览页，新增了 Ctrl+Alt+B / Ctrl+/；
 *   · 两者确实重合的只有 Ctrl+B / Ctrl+N / Ctrl+,，v3 以本表为准，
 *     输入框 / 审批 / 终端三组说明仍复用 host-actions 的 `SHORTCUT_NOTE_GROUPS`。
 *
 * 文件保持**纯数据 + 纯函数**：不 import React / store / DOM，便于 `scripts/test-v3-shortcuts.mjs`
 * 直接在 Node 里钉死匹配、冲突与 IME / 模态抑制。
 */

export type ShortcutId =
  | 'commandPalette'
  | 'newSession'
  | 'toggleSidebar'
  | 'openRuns'
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
  | 'cycleModel'
  | 'cycleModelBack'
  | 'cycleThinking'
  | 'quickAsk'

/** 触发路径：`renderer` 由外壳绑定；`host` 已由主进程 / 独立窗口注册，本表只做展示与冲突检测。 */
export type ShortcutRegistration = 'renderer' | 'host'

/** 快捷键表里「作用」一列的文案键（指向 `features/commands/shortcut-text.ts`）。 */
export type ShortcutPurposeKey = ShortcutId

export interface ShortcutDef {
  id: ShortcutId
  /** 默认键位，顺序即显示顺序，最后一项是触发键。 */
  keys: readonly string[]
  /** 作用说明的文案键。 */
  purposeKey: ShortcutPurposeKey
  /** 是否允许用户改键；终端让键（terminalsYield）保持 false，其余可改。 */
  rebindable: boolean
  scope: 'global'
  /** 焦点在终端里时让给 xterm（只用于 xterm 真正会用的键）。 */
  terminalsYield: boolean
  /** 由谁注册；`host` 项不参与外壳分发。 */
  registeredBy: ShortcutRegistration
}

/** 用户键位覆盖：按 ShortcutId 存改过的键位；缺省项用注册表默认。 */
export type ShortcutOverrides = Readonly<Partial<Record<ShortcutId, readonly string[]>>>

/** 没有覆盖时的空表；没有设置字段的调用方也能直接引用。 */
export const EMPTY_SHORTCUT_OVERRIDES: ShortcutOverrides = {}

/**
 * 全局键位表：`registeredBy:'renderer'` 由 `ShellV3` 绑定；`registeredBy:'host'`
 * 的 Ctrl+P / Ctrl+Shift+P / Shift+Tab（主进程 `before-input-event`）与
 * Alt+Shift+Space（独立快速提问窗口）只做帮助显示与冲突检测，不在这里二次注册。
 *
 * 只列 v3 当前确实有入口的动作：Ctrl+Shift+J（运行总览浮层）、Ctrl+[ / ]
 *（上下一个运行中的会话）、F8（跳到下一个需要处理的）、Ctrl+↑/↓（上下一条用户消息）
 * 目前没有对应实现，故不注册，避免出现按了没反应的假动作。
 */
export const SHORTCUTS: readonly ShortcutDef[] = [
  /* Ctrl+K/B/J 同时是终端的键（terminalsYield），保持固定。 */
  { id: 'commandPalette', keys: ['Ctrl', 'K'], purposeKey: 'commandPalette', rebindable: false, scope: 'global', terminalsYield: true, registeredBy: 'renderer' },
  { id: 'newSession', keys: ['Ctrl', 'N'], purposeKey: 'newSession', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'toggleSidebar', keys: ['Ctrl', 'B'], purposeKey: 'toggleSidebar', rebindable: false, scope: 'global', terminalsYield: true, registeredBy: 'renderer' },
  { id: 'openRuns', keys: ['Ctrl', 'J'], purposeKey: 'openRuns', rebindable: false, scope: 'global', terminalsYield: true, registeredBy: 'renderer' },
  { id: 'toggleWorkspace', keys: ['Ctrl', 'Alt', 'B'], purposeKey: 'toggleWorkspace', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'openSettings', keys: ['Ctrl', ','], purposeKey: 'openSettings', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'shortcutSheet', keys: ['Ctrl', '/'], purposeKey: 'shortcutSheet', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'goBack', keys: ['Alt', '←'], purposeKey: 'goBack', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  /* 停止（只在当前视图就是运行实例时生效，见 ShellV3 的运行时判断）。 */
  { id: 'stopRun', keys: ['Ctrl', '.'], purposeKey: 'stopRun', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  /* Ctrl+L / Ctrl+Shift+C 是 xterm 自己的键（清屏 / 复制），保持固定。 */
  { id: 'focusComposer', keys: ['Ctrl', 'L'], purposeKey: 'focusComposer', rebindable: false, scope: 'global', terminalsYield: true, registeredBy: 'renderer' },
  { id: 'copyLastReply', keys: ['Ctrl', 'Shift', 'C'], purposeKey: 'copyLastReply', rebindable: false, scope: 'global', terminalsYield: true, registeredBy: 'renderer' },
  /* 打开工作区终端页签；Alt+1…6 按 `WORKBENCH_TABS` 的顺序切页签。 */
  { id: 'openTerminal', keys: ['Ctrl', '`'], purposeKey: 'openTerminal', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab1', keys: ['Alt', '1'], purposeKey: 'workspaceTab1', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab2', keys: ['Alt', '2'], purposeKey: 'workspaceTab2', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab3', keys: ['Alt', '3'], purposeKey: 'workspaceTab3', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab4', keys: ['Alt', '4'], purposeKey: 'workspaceTab4', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab5', keys: ['Alt', '5'], purposeKey: 'workspaceTab5', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  { id: 'workspaceTab6', keys: ['Alt', '6'], purposeKey: 'workspaceTab6', rebindable: true, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
  /* 宿主已注册：主进程 before-input-event 与独立快速提问窗口，外壳只显示与让位。 */
  { id: 'cycleModel', keys: ['Ctrl', 'P'], purposeKey: 'cycleModel', rebindable: false, scope: 'global', terminalsYield: false, registeredBy: 'host' },
  { id: 'cycleModelBack', keys: ['Ctrl', 'Shift', 'P'], purposeKey: 'cycleModelBack', rebindable: false, scope: 'global', terminalsYield: false, registeredBy: 'host' },
  { id: 'cycleThinking', keys: ['Shift', 'Tab'], purposeKey: 'cycleThinking', rebindable: false, scope: 'global', terminalsYield: false, registeredBy: 'host' },
  { id: 'quickAsk', keys: ['Alt', 'Shift', 'Space'], purposeKey: 'quickAsk', rebindable: false, scope: 'global', terminalsYield: false, registeredBy: 'host' }
]

const SHORTCUT_ID_SET: ReadonlySet<string> = new Set(SHORTCUTS.map((def) => def.id))
const SHORTCUT_REBINDABLE_SET: ReadonlySet<string> = new Set(SHORTCUTS.filter((def) => def.rebindable).map((def) => def.id))

/** 外壳可从注册表绑定的项（`registeredBy:'renderer'`）。 */
export const RENDERER_SHORTCUTS: readonly ShortcutDef[] = SHORTCUTS.filter((def) => def.registeredBy === 'renderer')

/** 宿主（主进程 / 独立窗口）已注册的项，只用于帮助显示与冲突检测。 */
export const HOST_SHORTCUTS: readonly ShortcutDef[] = SHORTCUTS.filter((def) => def.registeredBy === 'host')

/**
 * 清洗磁盘 / IPC 传来的覆盖：只收已知、可改的 ShortcutId 与非空字符串数组。
 * 主进程只原样存取，渲染端读设置和绑定时都过这里，脏值与固定项的残留覆盖都不参与匹配。
 */
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

/** 从 AppSettings 形状（或任意对象）里读覆盖并清洗；收 unknown 以便字段落地前也能编译。 */
export function shortcutOverridesFromSettings(settings: unknown): ShortcutOverrides {
  const holder = settings as { shortcutOverrides?: unknown } | null | undefined
  return sanitizeShortcutOverrides(holder?.shortcutOverrides)
}

/** 把覆盖应用到注册表；返回新数组，不改传入的 def。 */
export function applyShortcutOverrides(
  overrides: ShortcutOverrides,
  defs: readonly ShortcutDef[] = SHORTCUTS
): ShortcutDef[] {
  return defs.map((def) => {
    const keys = overrides[def.id]
    return keys && keys.length ? { ...def, keys } : def
  })
}

/** 某一项的生效键位：有覆盖用覆盖，否则用注册表默认。 */
export function effectiveShortcutKeys(def: ShortcutDef, overrides: ShortcutOverrides): readonly string[] {
  return overrides[def.id] ?? def.keys
}

/** 显示键（`←` 等符号）与 `KeyboardEvent.key` 的对应；其余按键小写后直接比较。 */
const KEY_ALIAS: Record<string, string> = {
  '←': 'arrowleft',
  '→': 'arrowright',
  '↑': 'arrowup',
  '↓': 'arrowdown'
}

const MODIFIERS = new Set(['ctrl', 'meta', 'shift', 'alt'])

/** 触发的 DOM 键名（已归一到小写）。 */
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

/** 归一化签名，用于冲突检测（Ctrl+Shift+B 与 Shift+Ctrl+B 视为同一个键）。 */
export function shortcutSignature(def: ShortcutDef): string {
  const modifiers = def.keys
    .slice(0, -1)
    .map((key) => key.toLowerCase())
    .filter((key) => MODIFIERS.has(key))
    .sort()
  return [...modifiers, shortcutKeyToken(def.keys)].join('+')
}

/** 返回注册表内的重复键位；正常应为空。 */
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
  /** 输入法组字中：按键归输入法，不当快捷键。 */
  composing?: boolean
  /** 长按重复：只执行一次。 */
  repeat?: boolean
  /** AltGr（欧洲键盘的 Ctrl+Alt 组合）不能被当成 Ctrl+Alt。 */
  altGraph?: boolean
  /** 有模态层打开：全局分发让位。 */
  modalOpen?: boolean
  /** 焦点在 xterm 内：让给终端自己的键。 */
  inTerminal?: boolean
  /** 焦点在可输入控件（input / textarea / contenteditable）里：不抢编辑器原生键。 */
  editing?: boolean
}

/** 焦点在输入控件里时，没有 Ctrl/Cmd 也归编辑器的键（方向 / 退格 / 回车等）。 */
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

/**
 * 把一次 keydown 归纳为一个 v3 快捷键 ID；不适用时返回 null。
 *
 * 与确认卡的 `Alt+Y` / `Alt+N` 不冲突：那两键不在注册表里，这里也不会命中。
 * 只有修饰键与键位**完全一致**才算命中，所以 Ctrl+B 与 Ctrl+Alt+B 互不误触。
 *
 * 抑制顺序（与现有 guards 一致）：输入法组字 / 长按 / AltGr / 模态一律先让位；
 * 焦点在输入控件里时，不带 Ctrl/Cmd 的编辑键不抢（Alt+← 这类多平台差异键也归编辑器）；
 * 终端聚焦时只让 `terminalsYield` 的项；`registeredBy:'host'` 的项永不命中。
 */
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
