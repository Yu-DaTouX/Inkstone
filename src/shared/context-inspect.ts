export interface ContextInspectSection {
  id: string
  label: string
  tokens: number
  chars: number
  text: string
}

export interface ContextInspectTool {
  name: string
  description: string
  tokens: number
  active: boolean
  source?: string
}

export interface ContextInspectSnapshot {
  version: 1
  at: number
  promptTokens: number
  toolTokens: number
  sections: ContextInspectSection[]
  tools: ContextInspectTool[]
}

const MAX_SECTIONS = 40
const MAX_TOOLS = 200
const MAX_TEXT = 24_000

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0
}

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const end = max > 0 && /[\uD800-\uDBFF]/.test(v[max - 1] ?? '') && /[\uDC00-\uDFFF]/.test(v[max] ?? '') ? max - 1 : max
  return v.slice(0, end)
}

export function parseContextInspectSnapshot(raw: unknown): ContextInspectSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.version !== 1 || !Array.isArray(r.sections) || !Array.isArray(r.tools)) return null
  const sections = r.sections.slice(0, MAX_SECTIONS).flatMap((s): ContextInspectSection[] => {
    if (!s || typeof s !== 'object') return []
    const o = s as Record<string, unknown>
    const id = str(o.id, 60)
    if (!id) return []
    return [{ id, label: str(o.label, 60) || id, tokens: num(o.tokens), chars: num(o.chars), text: str(o.text, MAX_TEXT) }]
  })
  const tools = r.tools.slice(0, MAX_TOOLS).flatMap((t): ContextInspectTool[] => {
    if (!t || typeof t !== 'object') return []
    const o = t as Record<string, unknown>
    const name = str(o.name, 80)
    if (!name) return []
    const source = str(o.source, 160)
    return [{ name, description: str(o.description, 300), tokens: num(o.tokens), active: o.active === true, ...(source ? { source } : {}) }]
  })
  return { version: 1, at: num(r.at) || Date.now(), promptTokens: num(r.promptTokens), toolTokens: num(r.toolTokens), sections, tools }
}
