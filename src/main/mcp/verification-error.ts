import { redactSecretText } from '../../shared/redact-diagnostic'

const VERIFICATION_ERROR_MAX_CHARS = 6000

export function verificationErrorText(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const text = redactSecretText(raw).trim()
  if (!text) return undefined
  return text.length > VERIFICATION_ERROR_MAX_CHARS ? `${text.slice(0, VERIFICATION_ERROR_MAX_CHARS)}…` : text
}
