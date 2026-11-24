const TRAILING_ERROR = /(?:^|\n)[ \t]*\u26a0\ufe0f?[ \t]*([A-Z][A-Z_]+ \(code \d{3}\):[^\n]*)\s*$/

export function splitAntigravityErrorLine(text: string): { text: string; error: string } | null {
  const match = TRAILING_ERROR.exec(text)
  if (!match) return null
  return { text: text.slice(0, match.index).replace(/\s+$/, ''), error: match[1].trim() }
}
