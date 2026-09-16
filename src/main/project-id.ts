/**
 * 项目 id 的派生规则。
 *
 * ⚠️ 历史坑（D14）：旧实现是 `base64url(cwd).slice(0, 36)`，而 36 个
 * base64 字符只能覆盖**路径的前 27 字节**。于是同一父目录下的两个项目
 * （`.../pi-desktop` 与 `.../pi-desktop-2`）会派生出**同一个 id**。
 *
 * 后果不轻：`resolveFileContext`（文件树 / `@` 补全 / 全项目搜索共用的
 * 边界，见 index.ts）是**按 id 反查项目**的，`find` 命中第一条就把另一个
 * cwd 判成「项目与工作目录不匹配」，这些入口直接报错。用户看到的是
 * 「读取目录失败，请检查当前项目权限」，根因却在 id 上。
 *
 * 这里的分工：
 *   · `legacyProjectId` 保留旧算法 —— 已有设置里的 id **不能改**，
 *     它是会话归属索引的键，改键等于丢归属；
 *   · `projectIdForCwd` 只在 id 真被别的 cwd 占用时才换成整条路径的
 *     sha1，保证新旧数据都不会出现「两个 cwd 共用一个 id」。
 */
import { createHash } from 'node:crypto'

/** 旧算法：前 36 个 base64url 字符（只覆盖路径前 27 字节，会同前缀碰撞） */
export function legacyProjectId(cwd: string): string {
  return `project-${Buffer.from(cwd.toLowerCase()).toString('base64url').slice(0, 36)}`
}

/** 碰撞时的退路：整条路径的 sha1（大小写不敏感，与 legacy 同前缀约定一致） */
export function hashedProjectId(cwd: string): string {
  return `project-${createHash('sha1').update(cwd.toLowerCase()).digest('base64url').slice(0, 36)}`
}

/**
 * 给一个 cwd 派生项目 id。
 *
 * `isTaken` 返回 true 表示这个 id 已经被**别的** cwd 占用（调用方判断，
 * 因为「别的」只有它知道）。不传就是纯粹沿用旧算法，用于迁移。
 */
export function projectIdForCwd(cwd: string, isTaken?: (id: string) => boolean): string {
  const legacy = legacyProjectId(cwd)
  if (!isTaken || !isTaken(legacy)) return legacy
  let id = hashedProjectId(cwd)
  let salt = 0
  /* sha1 前 36 字符再撞的概率可以忽略；这里仍然兜住，避免死循环写出重复 id。 */
  while (isTaken(id)) id = hashedProjectId(`${cwd}\u0000${salt++}`)
  return id
}
