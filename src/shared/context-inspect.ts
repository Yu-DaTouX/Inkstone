/** 「上下文构成」快照：pi 已拼好的固定部分（系统提示分段 + 工具定义）的只读报告。 */

export interface ContextInspectSection {
  /** 稳定 id：preamble / tools / rules / docs / skills / project-context / cwd / appended / additions … */
  id: string
  label: string
  /** 估算值，总量仍以 Agent 上报为准 */
  tokens: number
  chars: number
  /** 截断后的原文，供「注入内容」查看 */
  text: string
}

export interface ContextInspectTool {
  name: string
  description: string
  tokens: number
  /** 当前是否启用（未启用的不计入发给模型的工具定义） */
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
  return typeof v === 'string' ? v.slice(0, max) : ''
}

/** 扩展经 HTTP 上报的内容不可信：逐字段收敛，形状不对返回 null。 */
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
