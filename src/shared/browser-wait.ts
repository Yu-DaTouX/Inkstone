export interface BrowserWaitCondition {
  ref?: string
  text?: string
  url?: string
  gone?: boolean
}

export const WAIT_TIMEOUT_MIN_MS = 100
export const WAIT_TIMEOUT_MAX_MS = 60_000
export const WAIT_TIMEOUT_DEFAULT_MS = 10_000
export const WAIT_POLL_MS = 250

export type WaitParseResult =
  | { ok: true; condition: BrowserWaitCondition; timeoutMs: number }
  | { ok: false; code: string; message: string }

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === '1' || v === ''
}

export function parseWaitCondition(params: Record<string, unknown>): WaitParseResult {
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const ref = text(params.ref)
  const body = text(params.text)
  const url = text(params.url)
  const gone = truthy(params.gone)

  if (!ref && !body && !url) {
    return {
      ok: false,
      code: 'missing_condition',
      message: 'wait 需要一个条件：yan browser wait --ref <ref> / --text <文本> / --url <子串>（可加 --timeout <毫秒>）'
    }
  }
  if (gone && !ref) {
    return { ok: false, code: 'missing_ref', message: '--gone 要配合 --ref：yan browser wait --ref <ref> --gone' }
  }

  const raw = Number(params.timeout ?? params['timeout-ms'] ?? WAIT_TIMEOUT_DEFAULT_MS)
  const timeoutMs = Number.isFinite(raw)
    ? Math.min(Math.max(Math.floor(raw), WAIT_TIMEOUT_MIN_MS), WAIT_TIMEOUT_MAX_MS)
    : WAIT_TIMEOUT_DEFAULT_MS

  return {
    ok: true,
    condition: { ...(ref ? { ref } : {}), ...(body ? { text: body } : {}), ...(url ? { url } : {}), ...(gone ? { gone: true } : {}) },
    timeoutMs
  }
}

export function waitSatisfied(
  condition: BrowserWaitCondition,
  observation: { url: string; text: string; elements: { ref: string }[] }
): boolean {
  if (condition.ref) {
    const found = observation.elements.some((el) => el.ref === condition.ref)
    if (condition.gone ? found : !found) return false
  }
  if (condition.text && !observation.text.includes(condition.text)) return false
  if (condition.url && !observation.url.includes(condition.url)) return false
  return true
}

export function describeWait(condition: BrowserWaitCondition): string {
  return [
    condition.ref ? (condition.gone ? `ref=${condition.ref} 消失` : `ref=${condition.ref} 出现`) : '',
    condition.text ? `文本「${condition.text}」` : '',
    condition.url ? `地址包含「${condition.url}」` : ''
  ]
    .filter(Boolean)
    .join(' 且 ')
}
