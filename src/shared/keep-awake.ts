export interface KeepAwakeInput {
  working: boolean
  onBattery: boolean
  whileWorking?: boolean
  onBatteryAllowed?: boolean
}

export function shouldKeepAwake(input: KeepAwakeInput): boolean {
  if (!input.working) return false
  if (input.whileWorking === false) return false
  if (input.onBattery && input.onBatteryAllowed === false) return false
  return true
}

export const KEEP_AWAKE_RELEASE_MS = 30_000
