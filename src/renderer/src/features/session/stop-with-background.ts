import { type TerminalJob } from '../../../../shared/terminal-jobs'

export type StopChoice = 'together' | 'turn' | 'cancel'
export type StopFlowResult = 'turn' | 'together' | 'cancelled'

export const STOP_PREVIEW_COMMANDS = 3
export const STOP_COMMAND_CHARS = 80

export interface BackgroundStopSummary {
  ids: string[]
  count: number
  commands: string[]
  more: number
}

export interface StopFlowDeps {
  jobs(): readonly TerminalJob[] | Promise<readonly TerminalJob[]>
  confirm(summary: BackgroundStopSummary): Promise<StopChoice>
  abortTurn(): Promise<void>
  stopJob(id: string): Promise<unknown>
}

export function runningBackgroundJobs(jobs: readonly TerminalJob[]): TerminalJob[] {
  return jobs.filter((job) => job.state === 'running')
}

export function commandPreview(command: string, max = STOP_COMMAND_CHARS): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function summarizeBackgroundJobs(jobs: readonly TerminalJob[], limit = STOP_PREVIEW_COMMANDS): BackgroundStopSummary {
  const sorted = [...jobs].sort((a, b) => a.startedAt - b.startedAt)
  return {
    ids: sorted.map((job) => job.id),
    count: sorted.length,
    commands: sorted.slice(0, limit).map((job) => commandPreview(job.command)),
    more: Math.max(0, sorted.length - limit)
  }
}

export async function runStopFlow(deps: StopFlowDeps): Promise<StopFlowResult> {
  let listed: readonly TerminalJob[] = []
  try {
    listed = await deps.jobs()
  } catch {
    listed = []
  }
  const running = runningBackgroundJobs(listed)
  if (running.length === 0) {
    await deps.abortTurn()
    return 'turn'
  }
  const summary = summarizeBackgroundJobs(running)
  const choice = await deps.confirm(summary)
  if (choice === 'cancel') return 'cancelled'
  await deps.abortTurn()
  if (choice === 'turn') return 'turn'
  await Promise.allSettled(summary.ids.map((id) => deps.stopJob(id)))
  return 'together'
}

interface PendingConfirm {
  summary: BackgroundStopSummary
  resolve: (choice: StopChoice) => void
}

let pending: PendingConfirm | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

export function requestStopConfirm(summary: BackgroundStopSummary): Promise<StopChoice> {
  const previous = pending
  return new Promise<StopChoice>((resolve) => {
    pending = { summary, resolve }
    previous?.resolve('cancel')
    emit()
  })
}

export function answerStopConfirm(choice: StopChoice): void {
  const current = pending
  if (!current) return
  pending = null
  emit()
  current.resolve(choice)
}

export function stopConfirmSummary(): BackgroundStopSummary | null {
  return pending?.summary ?? null
}

export function subscribeStopConfirm(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
