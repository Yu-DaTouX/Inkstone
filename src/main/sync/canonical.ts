/**
 * 同步用的规范化与哈希工具。
 *
 * 为什么需要 canonical JSON：两台设备各自 `desktop.json` 的键顺序可能不同，
 * 直接 `JSON.stringify` 会把同一份内容算成两个哈希，制造假冲突。
 * 这里递归按键名排序，保证「内容相同 ⇒ payload 相同 ⇒ 哈希相同」。
 */
import { createHash } from 'node:crypto'

/** 键序稳定的 JSON 序列化；`undefined` 的对象属性被省略（与 JSON.stringify 一致）。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = source[key]
      if (item === undefined) continue
      out[key] = sortValue(item)
    }
    return out
  }
  return value
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 记录 / 冲突文件名用的短哈希。 */
export function shortHash(text: string, length = 32): string {
  return sha256Hex(text).slice(0, length)
}
