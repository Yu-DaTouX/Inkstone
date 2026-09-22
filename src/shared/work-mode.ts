/**
 * 工作模式（实施-05 §2 的契约与纯逻辑）。
 *
 * 三档：
 *   · `standard`   正常执行；信息不足时先问（改动前的默认行为）
 *   · `clarify`    先把目标问清楚，达到就绪条件后自动转标准并开工（S3 做转移）
 *   · `autonomous` 合理计划、验证、持续推进，不提偏好问题
 *
 * 这里只放**纯函数与类型**（可被主进程、单测、`yan` CLI 共用）。
 * 落盘与并发在 `main/work-mode-service.ts`，界面在 `Composer`，模型侧提示在
 * `resources/pi-extensions/question.js`。
 *
 * ⚠️ 曾经有一个全局布尔 `autonomous`（desktop.json）。它**不是**模式的等价物：
 *    A 会话切模式不得改变 B 会话的提问行为。旧值只作为**迁移输入**读一次
 *    （见 `migrateLegacyAutonomous`），新字段优先。
 */

/** 合法模式集合。顺序就是界面与 Tab 快切的顺序。 */
export const WORK_MODES = ['standard', 'clarify', 'autonomous'] as const

export type WorkMode = (typeof WORK_MODES)[number]

export const DEFAULT_WORK_MODE: WorkMode = 'standard'

/**
 * 一个会话持有的模式状态。
 *
 * `revision` 是提交用的乐观版本：界面提交时带上它读到的值，宿主比对后
 * 不一致就拒绝（返回当前值让界面恢复），避免两个入口互相覆盖。
 */
export interface WorkModeState {
  mode: WorkMode
  revision: number
  /**
   * 已提交但尚未生效的模式（当前回合还在跑）。
   *
   * 契约里保留这一项：模式按轮次生效，切完这一轮才知道新值；
   * 界面上显示「下一轮生效」而不是假装它已经生效。
   */
  pendingMode?: WorkMode
}

export function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === 'string' && (WORK_MODES as readonly string[]).includes(value)
}

/** 脏值一律回落到标准模式（不能因为设置里一个字串就把当前模式弄坏）。 */
export function normalizeWorkMode(value: unknown): WorkMode {
  return isWorkMode(value) ? value : DEFAULT_WORK_MODE
}

/** Tab 快切顺序：标准 → 计划 → 自主 → 标准。 */
export function nextWorkMode(current: WorkMode): WorkMode {
  const index = WORK_MODES.indexOf(normalizeWorkMode(current))
  return WORK_MODES[(index + 1) % WORK_MODES.length]
}

/**
 * 旧配置迁移（**幂等**）：
 *   · 新的 `defaultWorkMode` 合法 → 听它的（新字段优先）；
 *   · 否则旧 `autonomous === true` → `autonomous`；
 *   · 其余（含缺失、脏值）→ `standard`。
 *
 * 只认字面 `true`：旧字段是布尔开关，脏值当作没开过。
 */
export function migrateLegacyAutonomous(defaultWorkMode: unknown, legacyAutonomous: unknown): WorkMode {
  if (isWorkMode(defaultWorkMode)) return defaultWorkMode
  return legacyAutonomous === true ? 'autonomous' : DEFAULT_WORK_MODE
}

/**
 * 模式快捷键的用户开关。
 *
 * `undefined` = 没改过 = **开**（快捷键是用户要求的功能）；
 * 只有明确写 `false` 才关（与 `contextFold` 同一个「默认态不落盘」约定）。
 * 旧字段 `workModeTab` 在读取时迁到这里（见 `settings.ts`），不再写回。
 */
export function isWorkModeShortcutEnabled(value: unknown): boolean {
  return value !== false
}

/**
 * 默认的模式快捷键。
 *
 * 2026-09-22 用户拍板：模式切换从**裸 Tab** 改成 `Ctrl+Tab`。
 * 理由：裸 Tab 是输入框里唯一的「移到下一个控件」键，被抢掉后键盘用户
 * 只能靠 Esc 逃出输入框（且 Tab 补全弹窗与它互相打架）。
 */
export const DEFAULT_WORK_MODE_BINDING = 'Ctrl+Tab'

export interface KeyBinding {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  /** 规范化后的主键（字符键大写，空格叫 `Space`） */
  key: string
}

/** 事件的最小形状：纯逻辑不依赖 DOM，node 里也能测 */
export interface KeyLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** 只按修饰键本身不算一次组合（用户还没按完） */
const MODIFIER_KEY_NAMES = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock']

/** `e.key` 的规范化：单字符一律大写（CapsLock / Shift 让大小写漂移），空格另有名字 */
export function normalizeKeyName(key: string): string {
  if (key === ' ') return 'Space'
  return key.length === 1 ? key.toUpperCase() : key
}

/** 序列化：修饰键顺序固定，保证同一组合只有一种写法（存盘与比较都靠它） */
export function formatKeyBinding(binding: KeyBinding): string {
  const mods: string[] = []
  if (binding.ctrl) mods.push('Ctrl')
  if (binding.alt) mods.push('Alt')
  if (binding.shift) mods.push('Shift')
  if (binding.meta) mods.push('Meta')
  return [...mods, binding.key].join('+')
}

/** 解析存储 / 用户输入里的组合键文本；非法（缺主键 / 认不得的修饰键）返回 null */
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
    /* 主键也归一：存盘的值必须与事件比较用同一套写法（`e.key` 会大小写漂移） */
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

/** 从一次真实按键构造组合键；只按了修饰键时返回 null */
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

/**
 * 可用的组合键必须带修饰键。
 *
 * 为什么拒收裸键：快捷键是**全局**生效的（焦点不在输入框也拦），裸键会抢掉正常输入 ——
 * 用户录到单键时我们要说清原因，而不是默默接受。
 */
export function isUsableKeyBinding(binding: KeyBinding | null): binding is KeyBinding {
  return !!binding && (binding.ctrl || binding.alt || binding.shift || binding.meta)
}

/**
 * 规范化要存盘的快捷键值：
 *   · `''` → 保持 `''`（显式禁用，与开关那个字段是两回事）；
 *   · 合法的组合键 → 规范化后的文本（`ctrl+shift+k` → `Ctrl+Shift+K`）；
 *   · 非法 / 脏值 → `undefined`（当作没设过 = 回到默认的 `Ctrl+Tab`）。
 */
export function normalizeWorkModeShortcut(value: unknown): string | undefined {
  if (value === '') return ''
  const binding = parseKeyBinding(value)
  if (!binding || !isUsableKeyBinding(binding)) return undefined
  return formatKeyBinding(binding)
}

/** 这次按键是不是命中这个快捷键（未设置时按默认值比） */
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
