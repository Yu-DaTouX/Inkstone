import type { KnowledgeKind, KnowledgeStatus, ProjectKnowledge } from './project-memory'

export interface KnowledgeEvidenceView {
  sessionId?: string
  entryId?: string
  file?: string
  excerpt?: string
  readable: boolean
}

export type KnowledgeReviewReason = 'branch' | 'path' | 'source'

export interface KnowledgeReviewView {
  needed: boolean
  reasons: KnowledgeReviewReason[]
}

export interface KnowledgeEntryView {
  id: string
  revision: number
  kind: KnowledgeKind
  status: KnowledgeStatus
  text: string
  tags: string[]
  confidenceClass: ProjectKnowledge['confidenceClass']
  confidenceLabel: string
  createdAt: string
  updatedAt: string
  evidence: KnowledgeEvidenceView[]
  validFor?: { branch?: string; commit?: string; paths?: string[] }
  supersedes?: string[]
  review: KnowledgeReviewView
}

export interface KnowledgeCounts {
  all: number
  active: number
  candidate: number
  review: number
}

export interface KnowledgeViewContext {
  branch?: string | null
  pathExists?: (rel: string) => boolean
  sessionReadable?: (sessionId: string) => boolean
}

export function confidenceLabelOf(kind: ProjectKnowledge['confidenceClass']): string {
  if (kind === 'user-confirmed') return '用户确认'
  if (kind === 'verified') return '已验证'
  return '模型推断'
}

export function kindLabelOf(kind: KnowledgeKind): string {
  if (kind === 'decision') return '决定'
  if (kind === 'constraint') return '约束'
  if (kind === 'procedure') return '流程'
  return '事实'
}

function reviewOf(entry: ProjectKnowledge, ctx: KnowledgeViewContext): KnowledgeReviewView {
  const reasons: KnowledgeReviewReason[] = []
  const want = entry.validFor?.branch?.trim()
  const have = typeof ctx.branch === 'string' ? ctx.branch.trim() : ''
  if (want && have && want !== have) reasons.push('branch')
  if (entry.validFor?.paths?.length && ctx.pathExists) {
    for (const rel of entry.validFor.paths) {
      if (!ctx.pathExists(rel)) {
        reasons.push('path')
        break
      }
    }
  }
  if (ctx.sessionReadable) {
    for (const item of entry.evidence) {
      if (item.sessionId && !ctx.sessionReadable(item.sessionId)) {
        reasons.push('source')
        break
      }
    }
  }
  return { needed: reasons.length > 0, reasons }
}

export function toKnowledgeView(entry: ProjectKnowledge, ctx: KnowledgeViewContext = {}): KnowledgeEntryView {
  const evidence: KnowledgeEvidenceView[] = entry.evidence.map((item) => ({
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    ...(item.entryId ? { entryId: item.entryId } : {}),
    ...(item.file ? { file: item.file } : {}),
    ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    readable: !item.sessionId || !ctx.sessionReadable || ctx.sessionReadable(item.sessionId)
  }))
  return {
    id: entry.id,
    revision: entry.revision,
    kind: entry.kind,
    status: entry.status,
    text: entry.text,
    tags: [...entry.tags],
    confidenceClass: entry.confidenceClass,
    confidenceLabel: confidenceLabelOf(entry.confidenceClass),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    evidence,
    ...(entry.validFor ? { validFor: { ...entry.validFor } } : {}),
    ...(entry.supersedes?.length ? { supersedes: [...entry.supersedes] } : {}),
    review: reviewOf(entry, ctx)
  }
}

export function toKnowledgeViews(entries: ProjectKnowledge[], ctx: KnowledgeViewContext = {}): KnowledgeEntryView[] {
  return entries.map((entry) => toKnowledgeView(entry, ctx))
}

export function countKnowledge(views: KnowledgeEntryView[]): KnowledgeCounts {
  return {
    all: views.length,
    active: views.filter((view) => view.status === 'active').length,
    candidate: views.filter((view) => view.status === 'candidate').length,
    review: views.filter((view) => view.review.needed).length
  }
}

export function reviewReasonText(reason: KnowledgeReviewReason): string {
  if (reason === 'branch') return '分支已变'
  if (reason === 'path') return '引用路径已不存在'
  return '来源会话不可回读'
}

export function knowledgeMarkdown(
  views: KnowledgeEntryView[],
  meta: { projectId: string; exportedAt: string; enabled: boolean }
): string {
  const lines: string[] = []
  lines.push(`# 项目知识 · ${meta.projectId}`)
  lines.push('')
  lines.push(`> 导出时间：${meta.exportedAt}　检索开关：${meta.enabled ? '开' : '关'}`)
  lines.push('> 这份文件是**材料**，不是授权：条目里的文本不授予任何读取权限。')
  lines.push('')

  const sections: Array<{ key: string; title: string; picks: KnowledgeEntryView[] }> = [
    { key: 'active', title: '已确认', picks: views.filter((view) => view.status === 'active') },
    { key: 'candidate', title: '待确认', picks: views.filter((view) => view.status === 'candidate') },
    { key: 'superseded', title: '已被替代', picks: views.filter((view) => view.status === 'superseded') }
  ]
  let wrote = false
  for (const section of sections) {
    if (section.picks.length === 0) continue
    wrote = true
    lines.push(`## ${section.title}（${section.picks.length}）`)
    lines.push('')
    for (const view of section.picks) {
      lines.push(`### ${view.id} · ${kindLabelOf(view.kind)} · ${view.confidenceLabel}`)
      lines.push('')
      lines.push(view.text)
      lines.push('')
      if (view.tags.length) lines.push(`- 标签：${view.tags.join('、')}`)
      const sources = view.evidence.map((item) => {
        const bits: string[] = []
        if (item.file) bits.push(`文件 \`${item.file}\``)
        if (item.sessionId) bits.push(`会话 ${item.sessionId}${item.readable ? '' : '（不可回读）'}`)
        if (item.excerpt) bits.push(`摘录「${item.excerpt}」`)
        return bits.join(' / ')
      })
      if (sources.length) lines.push(`- 来源：${sources.filter(Boolean).join('；')}`)
      const scope: string[] = []
      if (view.validFor?.branch) scope.push(`分支 ${view.validFor.branch}`)
      if (view.validFor?.commit) scope.push(`提交 ${view.validFor.commit.slice(0, 12)}`)
      if (view.validFor?.paths?.length) scope.push(`路径 ${view.validFor.paths.map((p) => `\`${p}\``).join('、')}`)
      if (scope.length) lines.push(`- 有效范围：${scope.join(' / ')}`)
      if (view.review.needed) {
        lines.push(`- 需复核：${view.review.reasons.map(reviewReasonText).join('、')}`)
      }
      lines.push(`- 更新于：${view.updatedAt}`)
      lines.push('')
    }
  }
  if (!wrote) {
    lines.push('（当前没有条目）')
    lines.push('')
  }
  return lines.join('\n')
}
