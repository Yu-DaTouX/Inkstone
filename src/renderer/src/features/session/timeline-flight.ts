export const FLIGHT_INSET_PX = 24
export const FLIGHT_FRAME_CAP_MS = 34
export const FLIGHT_SETTLE_FRAMES = 30
export const FLIGHT_SETTLE_STILL = 2

const LEAD_MS = 120
const LAND_MS = 280
const LEAD_SCREENS = 0.35
const LAND_SCREENS = 0.6
const CRUISE_MIN_MS = 60
const CRUISE_MAX_MS = 120
const CRUISE_MS_PER_OCTAVE = 36
const NEAR_MIN_MS = 200
const NEAR_MAX_MS = 420
const NEAR_MS_PER_ROOT_SCREEN = 140
const NEAR_LIMIT = 1.5
const LANDING_ROWS_MAX = 12

export interface FlightPlan {
  far: boolean
  duration: number
  lead: number
  land: number
  leadMs: number
  cruiseMs: number
  landMs: number
}

export type FlightPhase = 'lead' | 'cruise' | 'land' | 'done'

export function planFlight(distance: number, viewport: number): FlightPlan {
  const view = Math.max(1, viewport)
  const lead = view * LEAD_SCREENS
  const land = view * LAND_SCREENS
  if (distance <= (lead + land) * NEAR_LIMIT) {
    const duration = distance <= 0.5 ? 0 : Math.round(Math.min(NEAR_MAX_MS, NEAR_MIN_MS + NEAR_MS_PER_ROOT_SCREEN * Math.sqrt(distance / view)))
    return { far: false, duration, lead: 0, land: 0, leadMs: 0, cruiseMs: 0, landMs: 0 }
  }
  const cruise = distance - lead - land
  const cruiseMs = Math.round(Math.min(CRUISE_MAX_MS, CRUISE_MIN_MS + CRUISE_MS_PER_OCTAVE * Math.log2(1 + cruise / view)))
  return { far: true, duration: LEAD_MS + cruiseMs + LAND_MS, lead, land, leadMs: LEAD_MS, cruiseMs, landMs: LAND_MS }
}

export function flightPhase(plan: FlightPlan, elapsed: number): FlightPhase {
  if (elapsed >= plan.duration) return 'done'
  if (!plan.far) return 'land'
  if (elapsed < plan.leadMs) return 'lead'
  return elapsed < plan.leadMs + plan.cruiseMs ? 'cruise' : 'land'
}

export function skipCruise(plan: FlightPlan, elapsed: number, landingReady: boolean): number {
  if (!plan.far || !landingReady) return elapsed
  const landAt = plan.leadMs + plan.cruiseMs
  return elapsed >= plan.leadMs && elapsed < landAt ? landAt : elapsed
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function flightTravel(plan: FlightPlan, elapsed: number, distance: number): number {
  if (distance <= 0) return 0
  if (elapsed >= plan.duration) return distance
  if (!plan.far) {
    const t = clamp01(elapsed / Math.max(1, plan.duration))
    return distance * t * t * (3 - 2 * t)
  }
  const lead = Math.min(plan.lead, distance / 2)
  const land = Math.min(plan.land, distance / 2)
  if (elapsed < plan.leadMs) {
    const t = clamp01(elapsed / plan.leadMs)
    return lead * t * t
  }
  if (elapsed < plan.leadMs + plan.cruiseMs) {
    const u = clamp01((elapsed - plan.leadMs) / plan.cruiseMs)
    const from = lead
    const to = distance - land
    const span = to - from
    const leave = Math.min((2 * lead) / plan.leadMs * plan.cruiseMs, span * 3)
    const enter = Math.min((3 * land) / plan.landMs * plan.cruiseMs, span * 3)
    const u2 = u * u
    const u3 = u2 * u
    const value = (2 * u3 - 3 * u2 + 1) * from + (u3 - 2 * u2 + u) * leave + (-2 * u3 + 3 * u2) * to + (u3 - u2) * enter
    return Math.min(to, Math.max(from, value))
  }
  const u = clamp01((elapsed - plan.leadMs - plan.cruiseMs) / plan.landMs)
  const rest = 1 - u
  return distance - land * rest * rest * rest
}

export function landingIndices(target: number, around: readonly number[], count: number): number[] {
  const picked = new Set<number>()
  for (const index of [target, target + 1, target - 1, target + 2, ...around]) {
    if (picked.size >= LANDING_ROWS_MAX) break
    if (Number.isInteger(index) && index >= 0 && index < count) picked.add(index)
  }
  return [...picked].sort((a, b) => a - b)
}
