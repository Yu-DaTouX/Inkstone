import type { MainPush, SubagentPatch, SubagentRun } from '../shared/ipc'
import { SubagentPushTracker } from '../shared/subagent-push'

const SUBAGENT_FLUSH_MS = 150

export interface SubagentPushBatch {
  change(run: SubagentRun, patch?: SubagentPatch): void
  patch(patch: SubagentPatch): void
  remove(id: string): void
}

export function createSubagentPushBatch(port: {
  push: (msg: MainPush) => void
  publishRemote: (msg: MainPush) => void
}): SubagentPushBatch {
  const pending = new Map<string, { run: SubagentRun; patches: SubagentPatch[] | null }>()
  const tracker = new SubagentPushTracker()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.size === 0) return
    const runs = [...pending.values()]
    pending.clear()
    for (const { run, patches } of runs) {
      if (!patches) {
        port.push({ ch: 'subagent', payload: tracker.run(run) })
        continue
      }
      for (const patch of patches) port.push({ ch: 'subagent-patch', payload: tracker.patch(patch) })
      port.publishRemote({ ch: 'subagent', payload: run })
    }
  }

  return {
    change: (run, patch) => {
      const previous = pending.get(run.id)
      const patches = patch && (!previous || previous.patches) ? [...(previous?.patches ?? []), patch] : null
      pending.set(run.id, { run, patches })
      if (run.status !== 'starting' && run.status !== 'running') {
        flush()
        return
      }
      if (timer) return
      timer = setTimeout(flush, SUBAGENT_FLUSH_MS)
      timer.unref?.()
    },
    patch: (patch) => {
      flush()
      port.push({ ch: 'subagent-patch', payload: tracker.patch(patch) })
    },
    remove: (id) => {
      pending.delete(id)
      flush()
      tracker.forget(id)
      port.push({ ch: 'subagent-remove', payload: id })
    }
  }
}
