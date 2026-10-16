import { normalizeChainKey } from './session-chain'

export const HANDOFF_EVENT_STAGES = [
  'eligibility',
  'safety-boundary',
  'generate',
  'commit',
  'resume',
  'goal-continue'
] as const

export type HandoffEventStage = (typeof HANDOFF_EVENT_STAGES)[number]

export function isHandoffEventStage(value: unknown): value is HandoffEventStage {
  return typeof value === 'string' && (HANDOFF_EVENT_STAGES as readonly string[]).includes(value)
}

export interface HandoffEvent {
  at: number
  stage: HandoffEventStage
  outcome: string
  op: string | null
  handoffId: string | null
  runnerId: string | null
  sessionKey: string | null
  reason: string | null
  detail: Record<string, string | number | boolean | null>
}

export const HANDOFF_EVENT_LIMIT = 400

export const HANDOFF_DETAIL_MAX_CHARS = 120

const REDACT_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi,
  /\b(?:api[-_]?key|token|secret|password|authorization)\b\s*[=:]\s*\S+/gi
]

export function redactDiagnosticText(value: unknown, max = HANDOFF_DETAIL_MAX_CHARS): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  let out = trimmed.replace(/\s+/g, ' ')
  for (const pattern of REDACT_PATTERNS) out = out.replace(pattern, '[redacted]')
  if (out.length <= max) return out
  return `${out.slice(0, max)}…(共${out.length}字)`
}

export function sanitizeHandoffDetail(raw: unknown, max = HANDOFF_DETAIL_MAX_CHARS): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = redactDiagnosticText(key, 40)
    if (!name) continue
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = Math.round(value * 1000) / 1000
    else if (typeof value === 'boolean') out[name] = value
    else if (value === null || value === undefined) out[name] = null
    else out[name] = redactDiagnosticText(String(value), max)
  }
  return out
}

export function sanitizeDiagnosticId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.replace(/[^A-Za-z0-9._:/\\-]/g, '_').slice(0, 160)
}

function scalar(value: unknown): string | null {
  return typeof value === 'string' ? redactDiagnosticText(value) : null
}

export function normalizeHandoffEvent(raw: Partial<HandoffEvent> & { at?: number; now?: number }): HandoffEvent {
  const at = Number.isFinite(raw.at) ? Number(raw.at) : Date.now()
  return {
    at,
    stage: isHandoffEventStage(raw.stage) ? raw.stage : 'generate',
    outcome: redactDiagnosticText(raw.outcome, 60) ?? 'unknown',
    op: sanitizeDiagnosticId(raw.op),
    handoffId: sanitizeDiagnosticId(raw.handoffId),
    runnerId: sanitizeDiagnosticId(raw.runnerId),
    sessionKey: sanitizeDiagnosticId(raw.sessionKey),
    reason: scalar(raw.reason),
    detail: sanitizeHandoffDetail(raw.detail)
  }
}

export function sanitizeHandoffEventLine(raw: unknown): HandoffEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  if (!isHandoffEventStage(item.stage)) return null
  const at = Number(item.at)
  if (!Number.isFinite(at) || at <= 0) return null
  return normalizeHandoffEvent({ ...(item as Partial<HandoffEvent>), at })
}

export function handoffEventSummary(event: HandoffEvent): string {
  const parts = [`${event.stage}:${event.outcome}`]
  if (event.reason) parts.push(event.reason)
  return parts.join(' · ')
}

export function eventsForSession(
  events: HandoffEvent[],
  scope: { keys: Iterable<string>; runnerId?: string | null }
): HandoffEvent[] {
  const keys = new Set<string>()
  for (const key of scope.keys) {
    const normalized = normalizeChainKey(key)
    if (normalized) keys.add(normalized)
  }
  const runnerId = scope.runnerId ?? null
  return (events ?? []).filter((event) => {
    const key = normalizeChainKey(event.sessionKey)
    if (key) return keys.has(key)
    return Boolean(runnerId) && event.runnerId === runnerId
  })
}
