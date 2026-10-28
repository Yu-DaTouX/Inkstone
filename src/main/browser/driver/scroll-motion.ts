export type WheelServices = {
  cdp(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>
  sleep(ms: number): Promise<void>
}

export interface WheelMotion {
  x: number
  y: number
  deltaX: number
  deltaY: number
  modifiers?: number
}

export interface WheelStep {
  deltaX: number
  deltaY: number
}

export const SINGLE_EVENT_DISTANCE = 120
export const PIXELS_PER_STEP = 80
export const MAX_STEPS = 12
export const STEP_INTERVAL_MS = 8

export function wheelSteps(motion: WheelMotion): WheelStep[] {
  const distance = Math.max(Math.abs(motion.deltaX), Math.abs(motion.deltaY))
  const count = distance <= SINGLE_EVENT_DISTANCE ? 1 : Math.min(MAX_STEPS, Math.ceil(distance / PIXELS_PER_STEP))
  const steps: WheelStep[] = []
  let emittedX = 0
  let emittedY = 0
  for (let step = 1; step <= count; step += 1) {
    const progress = step / count
    const eased = progress * progress * (3 - 2 * progress)
    const cumulativeX = step === count ? motion.deltaX : motion.deltaX * eased
    const cumulativeY = step === count ? motion.deltaY : motion.deltaY * eased
    steps.push({ deltaX: cumulativeX - emittedX, deltaY: cumulativeY - emittedY })
    emittedX = cumulativeX
    emittedY = cumulativeY
  }
  return steps
}

export async function dispatchWheelMotion(
  services: WheelServices,
  motion: WheelMotion,
  sessionId?: string
): Promise<void> {
  const steps = wheelSteps(motion)
  for (const [index, step] of steps.entries()) {
    await services.cdp(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseWheel',
        x: motion.x,
        y: motion.y,
        modifiers: motion.modifiers ?? 0,
        deltaX: step.deltaX,
        deltaY: step.deltaY
      },
      sessionId
    )
    if (index < steps.length - 1) await services.sleep(STEP_INTERVAL_MS)
  }
}
