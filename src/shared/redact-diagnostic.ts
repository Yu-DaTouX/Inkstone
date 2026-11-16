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

export function redactCredentialShapes(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1[redacted]@')
    .replace(
      /([?&])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|token|key|secret|password|passwd|credential|authorization|auth)=[^&\s"']+/gi,
      '$1[redacted]'
    )
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|auth|token|secret|password|passwd|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*$|'(?:\\.|[^'\\])*$)/gi,
      '$1[redacted]'
    )
    .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '[redacted]')
    .replace(/\b(authorization\s*[:=]\s*)[^\s,;"']+/gi, '$1[redacted]')
    .replace(
      /(\b(?:x-api-key|api[-_]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential)\b\s*[:=]\s*)[^\s,;"'&?]+/gi,
      '$1[redacted]'
    )
}
