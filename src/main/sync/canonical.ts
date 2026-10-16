import { createHash } from 'node:crypto'

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

export function shortHash(text: string, length = 32): string {
  return sha256Hex(text).slice(0, length)
}
