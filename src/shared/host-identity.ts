const GROUP = 4
const GROUPS = 4

export function formatHostFingerprint(digest: Uint8Array): string {
  const bytes = digest.subarray(0, (GROUP * GROUPS) / 2)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0').toUpperCase()
  const groups: string[] = []
  for (let i = 0; i < GROUPS; i += 1) groups.push(hex.slice(i * GROUP, (i + 1) * GROUP))
  return groups.join('-')
}
