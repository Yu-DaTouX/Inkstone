const DIAGNOSTIC_TEXT_MAX_CHARS = 120

const REDACT_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi,
  /\b(?:api[-_]?key|token|secret|password|authorization)\b\s*[=:]\s*\S+/gi
]

export function redactDiagnosticText(value: unknown, max = DIAGNOSTIC_TEXT_MAX_CHARS): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  let out = trimmed.replace(/\s+/g, ' ')
  for (const pattern of REDACT_PATTERNS) out = out.replace(pattern, '[redacted]')
  if (out.length <= max) return out
  return `${out.slice(0, max)}…(共${out.length}字)`
}
