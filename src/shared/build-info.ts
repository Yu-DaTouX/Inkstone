/**
 * 构建信息（正式版本 / 构建版本）。
 *
 * 值来自**构建时注入**（见 `electron.vite.config.ts` 的 `define`）：
 *   · version   —— `package.json` 的正式版本号（与发布包一致）
 *   · buildTime —— 那次构建的时刻（ISO 字符串）
 *   · buildHash —— 构建时的 git 短 hash（无 git 时为空）
 *
 * 为什么要显示它：「正式版本」区分不了同一版本的哪一次构建。
 * 排查「改了代码但界面上还是旧行为」时（例如旧实例仍在跑、或双击的是旧包），
 * 一眼看到构建时间就能定位 —— 这类问题实际发生过一次。
 *
 * 纯逻辑（无 Electron 依赖），所以可以单测格式化函数。
 */
export interface YanBuildInfo {
  version: string
  /** ISO 时间字符串；缺失表示注入失败 */
  buildTime: string
  /** git 短 hash；无 git 时为空字符串 */
  buildHash: string
}

declare const __YAN_BUILD__: YanBuildInfo

/** 兜底：非注入环境（例如 node 里直接 import 做测试）为空值，不编造版本 */
export const BUILD_INFO: YanBuildInfo =
  typeof __YAN_BUILD__ === 'undefined'
    ? { version: '', buildTime: '', buildHash: '' }
    : __YAN_BUILD__

/**
 * 把构建时刻格式化成**本地时间**（界面上要给人看，不是给机器看）。
 * 传入空值或非法值时不抛错，原样返回（界面显示 — 的职责交给调用方）。
 */
export function formatBuildTime(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}
