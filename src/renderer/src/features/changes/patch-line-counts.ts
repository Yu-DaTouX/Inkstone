export interface LineCounts {
  added: number
  removed: number
}

const AT = 64
const PLUS = 43
const MINUS = 45

export function patchLineCounts(patch: string): LineCounts {
  let added = 0
  let removed = 0
  let inHunk = false
  let start = 0
  while (start < patch.length) {
    const lead = patch.charCodeAt(start)
    if (lead === AT && patch.charCodeAt(start + 1) === AT) inHunk = true
    else if (inHunk && lead === PLUS) added += 1
    else if (inHunk && lead === MINUS) removed += 1
    const end = patch.indexOf('\n', start)
    if (end < 0) break
    start = end + 1
  }
  return { added, removed }
}
