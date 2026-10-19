export type SwitchBlockReason = 'unmerged' | 'overlap' | 'unknown'

export interface SwitchCheckInput {
  unmerged: boolean
  dirty: readonly string[]
  targetChanged: readonly string[] | null
  caseInsensitive?: boolean
}

export interface SwitchCheckResult {
  blocked: boolean
  reason?: SwitchBlockReason
  paths: string[]
}

function ancestors(path: string): string[] {
  const out: string[] = []
  let cut = path.lastIndexOf('/')
  while (cut > 0) {
    out.push(path.slice(0, cut))
    cut = path.lastIndexOf('/', cut - 1)
  }
  return out
}

export function checkSwitch(input: SwitchCheckInput): SwitchCheckResult {
  const fold = (value: string): string => {
    const trimmed = value.replace(/\\/g, '/').replace(/\/+$/, '')
    return input.caseInsensitive ? trimmed.toLowerCase() : trimmed
  }
  if (input.unmerged) return { blocked: true, reason: 'unmerged', paths: [] }
  const dirty = [...new Set(input.dirty.filter(Boolean))]
  if (dirty.length === 0) return { blocked: false, paths: [] }
  if (!input.targetChanged) return { blocked: true, reason: 'unknown', paths: dirty }
  const changed = new Set<string>()
  const changedDirs = new Set<string>()
  for (const raw of input.targetChanged) {
    const path = fold(raw)
    if (!path) continue
    changed.add(path)
    for (const dir of ancestors(path)) changedDirs.add(dir)
  }
  const overlapping = dirty.filter((raw) => {
    const path = fold(raw)
    return changed.has(path) || changedDirs.has(path) || ancestors(path).some((dir) => changed.has(dir))
  })
  return overlapping.length > 0 ? { blocked: true, reason: 'overlap', paths: overlapping } : { blocked: false, paths: [] }
}
