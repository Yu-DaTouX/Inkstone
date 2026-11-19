import type { TurnSegment } from '../../../../shared/turns'

const UNRENDERED_SEGMENT_KEYS = new Set(['texts', 'response', 'responseParts'])

export interface ProcessGroupCompareProps {
  segments: readonly TurnSegment[]
  groupKey: string
  live: boolean
  openByDefault: boolean
  alertFailures: boolean
  showFailures: boolean
  view: string
  approvalIds: ReadonlySet<string>
  glowId?: string | null
  compactionAfter: { messageId: string; toolId: string | null } | null
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && Object.is(left[key], right[key]))
}

function sameItems(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return shallowEqual(a, b)
  return a.length === b.length && a.every((item, index) => shallowEqual(item, b[index]))
}

export function sameSegment(a: TurnSegment, b: TurnSegment): boolean {
  if (a === b) return true
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (UNRENDERED_SEGMENT_KEYS.has(key)) continue
    if (!sameItems(left[key], right[key])) return false
  }
  return true
}

function sameSegments(a: readonly TurnSegment[], b: readonly TurnSegment[]): boolean {
  return a === b || (a.length === b.length && a.every((segment, index) => sameSegment(segment, b[index])))
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

function sameGlow(a: string | null | undefined, b: string | null | undefined, segments: readonly TurnSegment[]): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return !segments.some((segment) => segment.tools.some((call) => call.id === a || call.id === b))
}

const COMPARED_PROPS = new Set(['segments', 'groupKey', 'live', 'openByDefault', 'alertFailures', 'showFailures', 'view', 'approvalIds', 'glowId', 'compactionAfter'])

function sameOtherProps(a: object, b: object): boolean {
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) if (!COMPARED_PROPS.has(key) && !Object.is(left[key], right[key])) return false
  return true
}

export function sameProcessGroupProps(a: ProcessGroupCompareProps, b: ProcessGroupCompareProps): boolean {
  return sameOtherProps(a, b) &&
    a.groupKey === b.groupKey &&
    a.live === b.live &&
    a.openByDefault === b.openByDefault &&
    a.alertFailures === b.alertFailures &&
    a.showFailures === b.showFailures &&
    a.view === b.view &&
    sameIds(a.approvalIds, b.approvalIds) &&
    shallowEqual(a.compactionAfter, b.compactionAfter) &&
    sameSegments(a.segments, b.segments) &&
    sameGlow(a.glowId, b.glowId, b.segments)
}
