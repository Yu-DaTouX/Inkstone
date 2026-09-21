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

/** Tab 快切顺序：标准 → 澄清 → 自主 → 标准。 */
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
 * 输入框 Tab 快切的用户开关。
 *
 * `undefined` = 没改过 = **开**（快切是用户要求的功能）；
 * 只有明确写 `false` 才关（与 `contextFold` 同一个「默认态不落盘」约定）。
 */
export function isWorkModeTabShortcut(value: unknown): boolean {
  return value !== false
}
