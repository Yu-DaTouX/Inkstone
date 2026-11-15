import type { SubagentRun } from './subagent-run'

export type SubagentRunPush = Omit<SubagentRun, 'task' | 'brief'> & Partial<Pick<SubagentRun, 'task' | 'brief'>>

export interface SubagentPatch {
  id: string
  run: SubagentRunPush
  transcriptFrom: number
  textFrom?: number
  thinkingFrom?: number
}

export function slimSubagentRun(run: SubagentRunPush): SubagentRunPush {
  if (!('task' in run) && !('brief' in run)) return run
  const { task: _task, brief: _brief, ...rest } = run
  return rest
}

export function mergeSubagentRunPush(previous: SubagentRun | undefined, incoming: SubagentRunPush): SubagentRun | null {
  if (typeof incoming.task === 'string') return { ...incoming, task: incoming.task }
  if (!previous) return null
  return { ...incoming, task: previous.task, ...(previous.brief ? { brief: previous.brief } : {}) }
}

export class SubagentPushTracker {
  private readonly announced = new Set<string>()

  run(run: SubagentRun): SubagentRunPush {
    if (this.announced.has(run.id)) return slimSubagentRun(run)
    this.announced.add(run.id)
    return run
  }

  patch(patch: SubagentPatch): SubagentPatch {
    return { ...patch, run: slimSubagentRun(patch.run) }
  }

  forget(id: string): void {
    this.announced.delete(id)
  }
}
