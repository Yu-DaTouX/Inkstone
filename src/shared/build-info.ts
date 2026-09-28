/**
 * 构建信息（正式版本 / 构建版本）。
 *
 * 值来自**构建时注入**（见 `electron.vite.config.ts` 的 `define`）：
 *   · version       —— `package.json` 的正式版本号（与发布包一致）
 *   · buildTime     —— 那次构建的时刻（ISO 字符串）
 *   · buildHash     —— 构建时的 git 短 hash（无 git 时为空）
 *   · repositoryUrl —— 项目仓库的网页地址（来自 `package.json` 的 `repository` / `homepage`）
 *
 * 仓库地址也走注入、不在界面里抄一份：抄一份就会在改仓库 / 改远程后
 * 变成一个打不开的死链，而这类错误只有人眼看界面时才会发现。
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
  /** 仓库网页地址（`https://…`，无 `git+` 前缀、无 `.git` / `#fragment` 尾巴）；缺失时为空字符串 */
  repositoryUrl: string
}

declare const __YAN_BUILD__: YanBuildInfo

/** 兜底：非注入环境（例如 node 里直接 import 做测试）为空值，不编造版本 */
export const BUILD_INFO: YanBuildInfo =
  typeof __YAN_BUILD__ === 'undefined'
    ? { version: '', buildTime: '', buildHash: '', repositoryUrl: '' }
    : __YAN_BUILD__

/**
 * 把 `package.json` 里的仓库写法归一成**可点击的网页地址**。
 *
 * 三种写法都出现过：`git+https://github.com/o/r.git`（`repository.url`）、
 * `https://github.com/o/r#readme`（`homepage`）、以及纯字符串的 `repository`。
 * 归一化放在这个纯模块里而不是构建脚本里，是为了能被单测覆盖 ——
 * 归一化写错了界面上只会多一个打不开的链接，构建期不会有任何报错。
 */
export function normalizeRepositoryUrl(raw: string | undefined | null): string {
  if (!raw) return ''
  return raw
    .trim()
    .replace(/^git\+/, '')
    .replace(/#.*$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

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
