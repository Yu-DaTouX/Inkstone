let switchInFlight: number | null = null

export function beginSessionSwitch(gate: number): void {
  switchInFlight = gate
}

export function endSessionSwitch(gate: number): void {
  if (switchInFlight === gate) switchInFlight = null
}

export function isSessionSwitchInFlight(): boolean {
  return switchInFlight !== null
}

export function resetSessionActivationForTest(): void {
  switchInFlight = null
}
