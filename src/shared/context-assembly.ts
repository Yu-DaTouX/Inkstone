import type { AgentActivity } from './agent-profile'
import type { SourceReference } from './library'

export type ContextSectionId = 'requirement' | 'task' | 'sources' | 'space' | 'preference'

export interface CitationLocator {
  start: number
  end: number
}

export interface ContextCitation {
  sourceId: string
  version: number
  title: string
  locator?: CitationLocator
}

export interface ContextFragment {
  section: ContextSectionId
  heading: string
  text: string
  citations: ContextCitation[]
}

export interface ContextAssembly {
  activity: AgentActivity
  fragments: ContextFragment[]
  citations: ContextCitation[]
  budget: {
    limit: number
    used: number
    dropped: number
    truncated: number
  }
}

export const DEFAULT_CONTEXT_BUDGET = 6000
export const SOURCES_BUDGET_RATIO = 0.6
export const MIN_SOURCE_CHARS = 200

export interface ContextSourceInput {
  ref: SourceReference
  title: string
  text: string
  start?: number
}

export interface ContextAssemblyInput {
  activity: AgentActivity
  requirement?: string
  task?: string
  sources?: ContextSourceInput[]
  space?: string
  preference?: string
}

const SECTION_HEADINGS: Record<ContextSectionId, string> = {
  requirement: '当次要求',
  task: '任务与阶段',
  sources: '来源片段',
  space: '相关空间',
  preference: '偏好'
}

const JOIN = '\n'

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0) return { text: '', truncated: text.length > 0 }
  if (text.length <= max) return { text, truncated: false }
  const end = max > 0 && /[\uD800-\uDBFF]/.test(text[max - 1]) && /[\uDC00-\uDFFF]/.test(text[max] ?? '') ? max - 1 : max
  return { text: text.slice(0, end), truncated: true }
}

export function assembleContext(
  input: ContextAssemblyInput,
  budget: number = DEFAULT_CONTEXT_BUDGET
): ContextAssembly {
  const limit = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : DEFAULT_CONTEXT_BUDGET
  const citations: ContextCitation[] = []
  let dropped = 0
  let truncated = 0
  let skeletonChars = 0

  type SkeletonItem = { section: ContextSectionId; heading: string; text: string }
  const leading: SkeletonItem[] = []
  const trailing: SkeletonItem[] = []
  if (input.requirement?.trim()) {
    leading.push({ section: 'requirement', heading: SECTION_HEADINGS.requirement, text: input.requirement.trim() })
  }
  if (input.task?.trim()) {
    leading.push({ section: 'task', heading: SECTION_HEADINGS.task, text: input.task.trim() })
  }
  if (input.space?.trim()) {
    trailing.push({ section: 'space', heading: SECTION_HEADINGS.space, text: input.space.trim() })
  }
  if (input.preference?.trim()) {
    trailing.push({ section: 'preference', heading: SECTION_HEADINGS.preference, text: input.preference.trim() })
  }

  const clipSkeleton = (items: SkeletonItem[]): ContextFragment[] => {
    const out: ContextFragment[] = []
    for (const item of items) {
      const clipped = clip(item.text, Math.max(0, limit - skeletonChars))
      if (!clipped.text) {
        dropped++
        continue
      }
      out.push({ section: item.section, heading: item.heading, text: clipped.text, citations: [] })
      skeletonChars += clipped.text.length
      if (clipped.truncated) truncated++
    }
    return out
  }

  const leadingFragments = clipSkeleton(leading)
  const trailingFragments = clipSkeleton(trailing)

  const sourcesBudget = Math.min(Math.max(0, limit - skeletonChars), Math.floor(limit * SOURCES_BUDGET_RATIO))
  const sourceFragments: ContextFragment[] = []
  let sourceUsed = 0
  for (const source of input.sources ?? []) {
    const left = sourcesBudget - sourceUsed
    if (left < Math.min(MIN_SOURCE_CHARS, source.text.length)) {
      dropped++
      continue
    }
    const clipped = clip(source.text, left)
    const start = source.start ?? 0
    const citation: ContextCitation = {
      sourceId: source.ref.sourceId,
      version: source.ref.version,
      title: source.title,
      ...(clipped.text.length > 0 ? { locator: { start, end: start + clipped.text.length } } : {})
    }
    sourceFragments.push({
      section: 'sources',
      heading: SECTION_HEADINGS.sources,
      text: clipped.text,
      citations: [citation]
    })
    citations.push(citation)
    sourceUsed += clipped.text.length
    if (clipped.truncated) truncated++
  }

  return {
    activity: input.activity,
    fragments: [...leadingFragments, ...sourceFragments, ...trailingFragments],
    citations,
    budget: { limit, used: skeletonChars + sourceUsed, dropped, truncated }
  }
}

export function citationToken(citation: ContextCitation): string {
  const loc = citation.locator ? `#${citation.locator.start}-${citation.locator.end}` : ''
  return `⟦${citation.sourceId}@${citation.version}${loc}⟧`
}

const TOKEN_RE = /⟦([^@⟧]+)@(\d+)(?:#(\d+)-(\d+))?⟧/g

export function parseCitationTokens(text: string): ContextCitation[] {
  const out: ContextCitation[] = []
  if (typeof text !== 'string') return out
  TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const [, sourceId, version, start, end] = match
    const citation: ContextCitation = { sourceId, version: Number(version), title: sourceId }
    if (start !== undefined && end !== undefined) {
      citation.locator = { start: Number(start), end: Number(end) }
    }
    out.push(citation)
  }
  return out
}

export function renderContextSection(assembly: ContextAssembly): string | null {
  const lines: string[] = []
  for (const fragment of assembly.fragments) {
    const body = fragment.text.trim()
    if (!body) continue
    lines.push(`### ${fragment.heading}`)
    if (fragment.section === 'sources' && fragment.citations.length > 0) {
      for (const citation of fragment.citations) {
        lines.push(`【来源】${citation.title} ${citationToken(citation)}`)
      }
    }
    lines.push(body)
  }
  if (lines.length === 0) return null
  return ['按当前活动装配的本轮上下文（不是全量资料）：', ...lines].join(JOIN)
}
