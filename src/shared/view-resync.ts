export type ViewResyncMissingKind = 'msg-update' | 'tool-message' | 'tool-call'

export interface ViewResyncMissing {
  kind: ViewResyncMissingKind
  messageId: string
  callId?: string
  fields?: string[]
}

export interface ViewResyncRequest {
  reason: string
  runId?: string
  generation?: number
  sessionId?: string
  missing?: ViewResyncMissing[]
  attempt?: number
  giveUp?: boolean
}

const MAX_MISSING = 8
const MAX_TEXT = 80

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT) : undefined

const KINDS: readonly ViewResyncMissingKind[] = ['msg-update', 'tool-message', 'tool-call']

function missingOf(value: unknown): ViewResyncMissing | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const kind = KINDS.find((item) => item === raw.kind)
  const messageId = text(raw.messageId)
  if (!kind || !messageId) return null
  const callId = text(raw.callId)
  const fields = Array.isArray(raw.fields)
    ? raw.fields.map(text).filter((item): item is string => !!item).slice(0, 12)
    : []
  return { kind, messageId, ...(callId ? { callId } : {}), ...(fields.length ? { fields } : {}) }
}

export function normalizeViewResyncRequest(input: unknown): ViewResyncRequest {
  if (typeof input === 'string' || input === undefined || input === null) {
    return { reason: text(input) ?? 'unspecified' }
  }
  if (typeof input !== 'object') return { reason: 'unspecified' }
  const raw = input as Record<string, unknown>
  const runId = text(raw.runId)
  const sessionId = text(raw.sessionId)
  const generation = typeof raw.generation === 'number' && Number.isSafeInteger(raw.generation) ? raw.generation : undefined
  const attempt = typeof raw.attempt === 'number' && Number.isSafeInteger(raw.attempt) && raw.attempt > 0 ? raw.attempt : undefined
  const missing = Array.isArray(raw.missing)
    ? raw.missing.map(missingOf).filter((item): item is ViewResyncMissing => !!item).slice(0, MAX_MISSING)
    : []
  return {
    reason: text(raw.reason) ?? 'unspecified',
    ...(runId ? { runId } : {}),
    ...(generation !== undefined ? { generation } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(missing.length ? { missing } : {}),
    ...(attempt ? { attempt } : {}),
    ...(raw.giveUp === true ? { giveUp: true } : {})
  }
}

export function describeViewResyncMissing(missing: readonly ViewResyncMissing[] | undefined): string {
  if (!missing?.length) return 'missing=-'
  return `missing=${missing.map((item) => {
    const call = item.callId ? `/${item.callId}` : ''
    const fields = item.fields?.length ? `{${item.fields.join(',')}}` : ''
    return `${item.kind}:${item.messageId}${call}${fields}`
  }).join(';')}`
}
