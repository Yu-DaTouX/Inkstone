export const AUTO_PROJECT_COLOR_COUNT = 7

export function projectMonogram(label: string): string {
  const words = label.trim().split(/[\s._\-/\\]+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...words[0]]
  if (!/^[\x00-\x7f]+$/.test(words[0])) return first[0]
  const digit = first.slice(1).find((char) => /\d/.test(char))
  const second = digit ?? (words.length > 1 ? [...words[words.length - 1]][0] : (first[1] ?? ''))
  return (first[0] + second).toUpperCase()
}

function stableHash(key: string): number {
  let hash = 2166136261
  for (const char of key.toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}

export function hashedProjectTone(key: string): number {
  return (stableHash(key) % AUTO_PROJECT_COLOR_COUNT) + 1
}
