export interface LineLocation {
  line: number
  column?: number
}

export interface GoToKeyState {
  key: string
  code?: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  composing?: boolean
}

export function parseLineLocation(value: string): LineLocation | null {
  const match = /^(\d+)\s*(?::\s*(\d*))?$/.exec(value.trim())
  if (!match) return null
  const line = Number(match[1])
  if (!Number.isSafeInteger(line) || line < 1) return null
  const column = match[2] ? Number(match[2]) : 0
  return column > 0 ? { line, column } : { line }
}

export function validateLineLocation(location: LineLocation | null, lineCount: number, firstLine = 1): LineLocation | null {
  if (!location) return null
  if (!Number.isInteger(lineCount) || lineCount < 1) return null
  if (!Number.isInteger(firstLine) || firstLine < 1) return null
  if (location.line < firstLine || location.line > lineCount) return null
  const column = location.column && location.column > 0 ? location.column : undefined
  return column ? { line: location.line, column } : { line: location.line }
}

export function goToLineShortcut(state: GoToKeyState): boolean {
  if (state.composing || !state.ctrl || state.meta || state.alt || state.shift) return false
  if (state.code === 'KeyG') return true
  return /^[ -~]$/.test(state.key) && state.key.toLowerCase() === 'g'
}
