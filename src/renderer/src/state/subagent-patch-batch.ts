import type { SubagentPatch, SubagentRun } from '../../../shared/ipc'
import { mergeSubagentTranscript } from '../../../shared/subagent-patch'

export class SubagentPatchBatch {
  private readonly pending = new Map<string, SubagentPatch[]>()

  add(patch: SubagentPatch): void {
    const list = this.pending.get(patch.id)
    if (list) list.push(patch)
    else this.pending.set(patch.id, [patch])
  }

  get size(): number {
    return this.pending.size
  }

  drain(): Map<string, SubagentPatch[]> {
    const out = new Map(this.pending)
    this.pending.clear()
    return out
  }
}

export function applySubagentPatches(runs: SubagentRun[], patches: ReadonlyMap<string, readonly SubagentPatch[]>): { runs: SubagentRun[]; stale: boolean } {
  let stale = false
  let changed = false
  const next = runs.map((run) => {
    const list = patches.get(run.id)
    if (!list?.length) return run
    let transcript = run.transcript
    for (const patch of list) {
      const merged = mergeSubagentTranscript(transcript, patch)
      if (!merged) {
        stale = true
        return run
      }
      transcript = merged
    }
    changed = true
    return { ...list[list.length - 1].run, transcript }
  })
  if (!stale && patches.size > 0) {
    const known = new Set(runs.map((run) => run.id))
    for (const id of patches.keys()) if (!known.has(id)) stale = true
  }
  return { runs: changed ? next : runs, stale }
}
