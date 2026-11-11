import { isLiveTerminalJob, type TerminalJob } from '../shared/terminal-jobs'

const FINISHED_KEEP = 50

const jobs = new Map<string, TerminalJob>()
const listeners = new Set<(jobs: TerminalJob[]) => void>()
let seq = 0

function emit(): void {
  const list = listTerminalJobs()
  for (const listener of listeners) listener(list)
}

function trim(): void {
  const finished = [...jobs.values()].filter((job) => !isLiveTerminalJob(job)).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  for (const job of finished.slice(0, Math.max(0, finished.length - FINISHED_KEEP))) jobs.delete(job.id)
}

export function listTerminalJobs(): TerminalJob[] {
  return [...jobs.values()].map((job) => ({ ...job, owners: [...job.owners] }))
}

export function onTerminalJobs(listener: (jobs: TerminalJob[]) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function addTerminalJob(input: Omit<TerminalJob, 'id' | 'state'>): TerminalJob {
  const job: TerminalJob = { ...input, id: `term-job-${Date.now().toString(36)}-${++seq}`, state: 'running' }
  jobs.set(job.id, job)
  emit()
  return job
}

export function terminalJob(id: string): TerminalJob | undefined {
  return jobs.get(id)
}

export function updateTerminalJob(id: string, patch: Partial<Pick<TerminalJob, 'state' | 'endedAt'>>): void {
  const job = jobs.get(id)
  if (!job) return
  Object.assign(job, patch)
  trim()
  emit()
}

export function requestTerminalJobStop(id: string): string | null {
  const job = jobs.get(id)
  if (!job || job.state !== 'running') return null
  job.state = 'stopping'
  emit()
  return job.terminalId
}

export function markTerminalJobsStopping(terminalId: string): void {
  let changed = false
  for (const job of jobs.values()) {
    if (job.kind === 'bash' || job.terminalId !== terminalId || job.state !== 'running') continue
    job.state = 'stopping'
    changed = true
  }
  if (changed) emit()
}

export function clearFinishedTerminalJobs(ids?: readonly string[]): void {
  const wanted = ids ? new Set(ids) : null
  let changed = false
  for (const job of [...jobs.values()]) {
    if (isLiveTerminalJob(job) || (wanted && !wanted.has(job.id))) continue
    jobs.delete(job.id)
    changed = true
  }
  if (changed) emit()
}

export function resetTerminalJobs(): void {
  jobs.clear()
  seq = 0
}
