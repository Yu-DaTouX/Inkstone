/**
 * `yan` 命令参数的读取：CLI 的连字符写法（`--query-text`）与请求文件里的 camelCase
 * （`queryText`）都认，空串当作没传。
 */

/** 按候选键依次取第一个非空字符串（已去掉首尾空白）。 */
export function paramString(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** 取一个有限数字；字符串形式的数字也接受。 */
export function paramNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}
