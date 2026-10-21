export interface SubagentBrief {
  title?: string
  goal: string
  deliverables: string[]
  sources: string[]
  boundary: string
  maxToolCalls?: number
  timeoutMinutes?: number
}

export const SUBAGENT_BRIEF_LIMITS = {
  maxTitle: 40,
  maxGoal: 4000,
  maxBoundary: 2000,
  maxDeliverables: 8,
  maxSources: 20,
  maxItem: 500,
  maxTimeoutMinutes: 60
} as const

function optionalInt(raw: unknown, label: string, min: number, max: number): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { ok: false, error: `${label}必须是正数` }
  return { ok: true, value: Math.min(max, Math.max(min, Math.round(value))) }
}

function charLength(text: string): number {
  return [...text].length
}

function listOf(raw: unknown, label: string, max: number): { ok: true; items: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, items: [] }
  if (!Array.isArray(raw)) return { ok: false, error: `${label}必须是数组` }
  const items: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') return { ok: false, error: `${label}里第 ${items.length + 1} 项不是字符串` }
    const trimmed = value.trim()
    if (!trimmed) continue
    if (charLength(trimmed) > SUBAGENT_BRIEF_LIMITS.maxItem) {
      return { ok: false, error: `${label}里有一项超过 ${SUBAGENT_BRIEF_LIMITS.maxItem} 字符` }
    }
    if (!items.includes(trimmed)) items.push(trimmed)
  }
  if (items.length > max) return { ok: false, error: `${label}最多 ${max} 项（实际 ${items.length}）` }
  return { ok: true, items }
}

export function parseSubagentBrief(
  raw: unknown,
  fallbackGoal: string
): { ok: true; brief: SubagentBrief } | { ok: false; error: string } {
  const box = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const goalRaw = typeof box.goal === 'string' ? box.goal.trim() : ''
  const goal = goalRaw || fallbackGoal.trim()
  if (!goal) return { ok: false, error: '任务输入缺少目标（goal），也没有可用的任务描述' }
  if (charLength(goal) > SUBAGENT_BRIEF_LIMITS.maxGoal) {
    return { ok: false, error: `目标超过 ${SUBAGENT_BRIEF_LIMITS.maxGoal} 字符` }
  }
  const deliverables = listOf(box.deliverables, '交付物', SUBAGENT_BRIEF_LIMITS.maxDeliverables)
  if (!deliverables.ok) return deliverables
  const sources = listOf(box.sources, '来源', SUBAGENT_BRIEF_LIMITS.maxSources)
  if (!sources.ok) return sources
  const boundaryRaw = typeof box.boundary === 'string' ? box.boundary.trim() : ''
  if (charLength(boundaryRaw) > SUBAGENT_BRIEF_LIMITS.maxBoundary) {
    return { ok: false, error: `边界说明超过 ${SUBAGENT_BRIEF_LIMITS.maxBoundary} 字符` }
  }
  const minutes = optionalInt(box.timeoutMinutes, '时间上限', 1, SUBAGENT_BRIEF_LIMITS.maxTimeoutMinutes)
  if (!minutes.ok) return minutes
  const title = typeof box.title === 'string' ? [...box.title.replace(/\s+/g, ' ').trim()].slice(0, SUBAGENT_BRIEF_LIMITS.maxTitle).join('') : ''
  return {
    ok: true,
    brief: {
      ...(title ? { title } : {}),
      goal,
      deliverables: deliverables.items,
      sources: sources.items,
      boundary: boundaryRaw,
      ...(minutes.value ? { timeoutMinutes: minutes.value } : {})
    }
  }
}

export function briefPrompt(brief: SubagentBrief, task: string): string {
  const lines: string[] = [brief.goal]
  const extra = task.trim() && task.trim() !== brief.goal.trim() ? task.trim() : ''
  if (extra) lines.push('', `任务原话：${extra}`)
  if (brief.deliverables.length > 0) {
    lines.push('', '要交回的东西：')
    for (const item of brief.deliverables) lines.push(`- ${item}`)
  }
  if (brief.sources.length > 0) {
    lines.push('', '只依据这些来源（不要自行扩大）：')
    for (const item of brief.sources) lines.push(`- ${item}`)
  }
  if (brief.boundary) lines.push('', `边界：${brief.boundary}`)
  lines.push('', '交回时先说结论（做了什么 / 结论是什么），再说依据；做不到的部分如实说做不到。')
  return lines.join('\n')
}

export interface SubagentResult {
  summary: string
  summaryTruncated: boolean
  summaryFrom: 'last-message' | 'error' | 'none'
  sources: string[]
  artifacts: string[]
  openQuestions: string[]
  at: number
}

export const SUBAGENT_SUMMARY_MAX = 600
const SOURCE_MAX = 12
const ARTIFACT_MAX = 20

const SOURCE_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'glob', 'web_search', 'fetch', 'browser'])
const SOURCE_KEYS = ['path', 'file', 'filePath', 'filepath', 'dir', 'cwd', 'url']

interface SubagentTranscriptLike {
  role: string
  text: string
  toolCalls?: { name: string; args?: unknown }[]
}

function pushUnique(list: string[], value: string, max: number): void {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 500) return
  if (list.includes(trimmed)) return
  if (list.length >= max) return
  list.push(trimmed)
}

export function summarizeSubagentRun(
  input: {
    transcript: readonly SubagentTranscriptLike[]
    diffPaths?: readonly string[]
    resultPath?: string
    error?: string
    status: string
  },
  now: number
): SubagentResult {
  let summary = ''
  let from: SubagentResult['summaryFrom'] = 'none'
  for (let i = input.transcript.length - 1; i >= 0; i -= 1) {
    const msg = input.transcript[i]
    if (msg.role !== 'assistant') continue
    const text = String(msg.text ?? '').trim()
    if (!text) continue
    summary = text
    from = 'last-message'
    break
  }
  if (from === 'none' && input.error) {
    summary = input.error.trim()
    from = 'error'
  }
  const codePoints = [...summary]
  const truncated = codePoints.length > SUBAGENT_SUMMARY_MAX
  if (truncated) summary = `${codePoints.slice(0, SUBAGENT_SUMMARY_MAX).join('')}…`

  const sources: string[] = []
  for (const msg of input.transcript) {
    for (const call of msg.toolCalls ?? []) {
      if (!SOURCE_TOOLS.has(String(call.name ?? ''))) continue
      const args = call.args
      if (!args || typeof args !== 'object') continue
      const box = args as Record<string, unknown>
      for (const key of SOURCE_KEYS) {
        const value = box[key]
        if (typeof value === 'string') pushUnique(sources, value, SOURCE_MAX)
      }
    }
  }

  const artifacts: string[] = []
  for (const path of input.diffPaths ?? []) pushUnique(artifacts, String(path), ARTIFACT_MAX)
  if (input.resultPath) pushUnique(artifacts, input.resultPath, ARTIFACT_MAX)

  return {
    summary,
    summaryTruncated: truncated,
    summaryFrom: from,
    sources,
    artifacts,
    openQuestions: [],
    at: now
  }
}
