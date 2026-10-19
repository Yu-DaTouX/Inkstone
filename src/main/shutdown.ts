export interface ShutdownStep {
  name: string
  run: () => unknown
  timeoutMs?: number
}

export interface ShutdownOutcome {
  name: string
  ok: boolean
  timedOut?: boolean
  error?: unknown
}

const DEFAULT_STEP_TIMEOUT_MS = 8_000

async function runStep(step: ShutdownStep): Promise<ShutdownOutcome> {
  const limit = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<ShutdownOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ name: step.name, ok: false, timedOut: true }), limit)
  })
  const work = (async (): Promise<ShutdownOutcome> => {
    try {
      await step.run()
      return { name: step.name, ok: true }
    } catch (error) {
      return { name: step.name, ok: false, error }
    }
  })()
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runShutdownSteps(
  steps: ShutdownStep[],
  report?: (outcome: ShutdownOutcome) => void
): Promise<ShutdownOutcome[]> {
  const outcomes: ShutdownOutcome[] = []
  for (const step of steps) {
    const outcome = await runStep(step)
    outcomes.push(outcome)
    if (!outcome.ok) report?.(outcome)
  }
  return outcomes
}
