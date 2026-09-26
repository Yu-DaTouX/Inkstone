/**
 * 会话 / 目录路径的**身份**归一化（实施-25 P02）。
 *
 * 只用于「是不是同一个」的判断，**不改变展示与落盘的原始路径**。
 *
 * 为什么必须共享一份：已经在两个地方踩过同一个坑 ——
 *   · main 的 `session-layout` 用它匹配会话归属；
 *   · 渲染端的左栏用它判断「哪条会话是当前会话」。
 * 两边各写一份就会漂移：Windows 上 `\` 与 `/`、盘符大小写都能让同一个文件
 * 看起来是两个（症状是「归属菜单点了没反应」——菜单项被判成「当前会话不在列表里」）。
 */
export function normalizeLayoutPath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

/** 两个路径是否指向同一个东西；任一为空都是 false。 */
export function samePath(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  return normalizeLayoutPath(a) === normalizeLayoutPath(b)
}
