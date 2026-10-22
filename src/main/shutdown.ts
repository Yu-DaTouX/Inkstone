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

export interface ShutdownOptions {
  defaultTimeoutMs?: number
  totalTimeoutMs?: number
}

export const DEFAULT_STEP_TIMEOUT_MS = 30_000
export const DEFAULT_TOTAL_TIMEOUT_MS = 90_000
const MIN_STEP_TIMEOUT_MS = 500

let activeRun: Promise<ShutdownOutcome[]> | undefined

function reportTimeout(name: string, limitMs: number): void {
  try {
    console.warn(`[shutdown] 步骤「${name}」超过 ${limitMs < 1000 ? `${limitMs} 毫秒` : `${(limitMs / 1000).toFixed(1)} 秒`}未完成，跳过该步骤继续清理`)
  } catch {
  }
}

async function runStep(step: ShutdownStep, limitMs: number): Promise<ShutdownOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<ShutdownOutcome>((resolve) => {
    timer = setTimeout(() => {
      reportTimeout(step.name, limitMs)
      resolve({ name: step.name, ok: false, timedOut: true })
    }, limitMs)
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

async function runAll(
  steps: ShutdownStep[],
  report: ((outcome: ShutdownOutcome) => void) | undefined,
  options: ShutdownOptions | undefined
): Promise<ShutdownOutcome[]> {
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const deadline = Date.now() + (options?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS)
  const outcomes: ShutdownOutcome[] = []
  for (const step of steps) {
    const limitMs = Math.min(step.timeoutMs ?? defaultTimeoutMs, Math.max(MIN_STEP_TIMEOUT_MS, deadline - Date.now()))
    const outcome = await runStep(step, limitMs)
    outcomes.push(outcome)
    if (!outcome.ok) report?.(outcome)
  }
  return outcomes
}

export function shutdownPending(): Promise<ShutdownOutcome[]> | undefined {
  return activeRun
}

export function runShutdownSteps(
  steps: ShutdownStep[],
  report?: (outcome: ShutdownOutcome) => void,
  options?: ShutdownOptions
): Promise<ShutdownOutcome[]> {
  if (activeRun) return activeRun
  const task = runAll(steps, report, options)
  activeRun = task
  void task.finally(() => {
    if (activeRun === task) activeRun = undefined
  }).catch(() => {})
  return task
}
