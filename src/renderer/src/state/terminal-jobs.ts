import { create } from 'zustand'
import { terminalJobOwnedBy, type TerminalJob } from '../../../shared/terminal-jobs'
import { viewIdentityOf, type ViewIdentityInput } from './view-identity'

interface TerminalJobsState {
  jobs: TerminalJob[]
  loaded: boolean
  set(jobs: TerminalJob[]): void
  load(): Promise<void>
}

export const useTerminalJobs = create<TerminalJobsState>((set, get) => ({
  jobs: [],
  loaded: false,
  set: (jobs) => set({ jobs, loaded: true }),
  load: async () => {
    if (get().loaded || typeof window === 'undefined' || typeof window.yan?.terminal?.jobs !== 'function') return
    const jobs = await window.yan.terminal.jobs().catch(() => null)
    if (jobs && !get().loaded) set({ jobs, loaded: true })
  }
}))

export function terminalJobsForView(jobs: readonly TerminalJob[], view: ViewIdentityInput): TerminalJob[] {
  const id = viewIdentityOf(view)
  const keys = [id.sessionFile, id.sessionId].filter((key): key is string => !!key)
  if (!keys.length) return []
  return jobs.filter((job) => keys.some((key) => terminalJobOwnedBy(job, key)))
}
