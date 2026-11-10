import type { ShutdownOutcome } from './shutdown'

export const UPDATE_WRITER_STEPS = ['runners', 'subagents', 'terminals'] as const

export interface UpdatePreflightControl {
  prepare(options?: { signal?: AbortSignal }): Promise<{ install: boolean; reason: string }>
  cancel(): void
}

export interface UpdatePreflightResult {
  install: boolean
  skipped?: 'no-control' | 'writers-unconfirmed' | 'timeout' | 'failed'
  writers: string[]
}

export async function prepareUpdateAfterWriters(
  outcomes: readonly ShutdownOutcome[],
  control: UpdatePreflightControl | null,
  options: { timeoutMs?: number; warn?: (message: string) => void; log?: (message: string) => void } = {}
): Promise<UpdatePreflightResult> {
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const log = options.log ?? ((message: string) => console.log(message))
  const writers = outcomes
    .filter((outcome) => (UPDATE_WRITER_STEPS as readonly string[]).includes(outcome.name) && !outcome.ok)
    .map((outcome) => `${outcome.name}${outcome.timedOut ? '(timeout)' : '(failed)'}`)
  if (!control) return { install: false, skipped: 'no-control', writers }
  if (writers.length) {
    control.cancel()
    warn(`[update] skipping pre-quit backup: ${writers.join(', ')}; writers did not confirm stop, automatic install on quit stays disabled`)
    return { install: false, skipped: 'writers-unconfirmed', writers }
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = Symbol('update-preflight-timeout')
  try {
    const result = await Promise.race([
      control.prepare({ signal: controller.signal }),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), options.timeoutMs ?? 60_000)
      })
    ])
    if (result === timedOut) {
      controller.abort()
      control.cancel()
      warn('[update] pre-quit backup timed out; automatic install on quit was canceled')
      return { install: false, skipped: 'timeout', writers }
    }
    if (result.install) log(`[update] pre-quit backup finished (${result.reason})`)
    return { install: result.install, writers }
  } catch (error) {
    controller.abort()
    control.cancel()
    warn(`[update] pre-quit preparation failed; automatic install on quit stays disabled: ${error instanceof Error ? error.message : String(error)}`)
    return { install: false, skipped: 'failed', writers }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
