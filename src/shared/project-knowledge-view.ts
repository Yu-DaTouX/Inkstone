import type { KnowledgeKind, KnowledgeStatus, ProjectKnowledge } from './project-memory'

/**
 * 项目知识的**界面视图**（实施-03 §6「UI」）。
 *
 * 为什么不直接把 `ProjectKnowledge` 送进渲染端：
 *   ① 界面与导出都要「需复核」这个**派生**状态，而它取决于当前分支 / 文件 /
 *      来源会话是否还在 —— 那是宿主的能力，不是存储里的字段；
 *   ② §6 明确「条目显示真实来源与状态，**不显示**未经校准的精确可信度百分比」，
 *      所以视图里只有 `confidenceLabel` 这种文字，没有分数；
 *   ③ 渲染端不该拿到 `projectId` 之外的存储细节（revision 文件布局）。
 *
 * 这一层是**纯函数**：文件系统与 git 都由调用方以回调注入（宿主查、这里只判），
 * 所以它能在单测里把「分支漂移」「文件没了」「来源会话被删」三种情形直接摆出来。
 */

export interface KnowledgeEvidenceView {
  sessionId?: string
  entryId?: string
  file?: string
  excerpt?: string
  /**
   * 来源现在还能不能回读。
   *
   * false = 会话文件已被删 / 读不到 —— 界面显示「不可回读」，
   * **不伪造证据**（§4）。没有 sessionId 的证据（纯文件引用）恒为 true：
   * 它本来就只是文本引用，不代表权限。
   */
  readable: boolean
}

/** 需复核的原因：分支漂移 / 路径没了 / 来源不可回读。 */
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
  /** 置信类的中文/英文之外的**中性**说法，交给界面按语言渲染 */
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
  /** 当前分支；未知（非 git 目录）就不判分支漂移。 */
  branch?: string | null
  /** 相对路径 → 现在还在不在。缺省时不判路径。 */
  pathExists?: (rel: string) => boolean
  /** 会话 id → 会话文件还在不在。缺省时证据一律算可回读。 */
  sessionReadable?: (sessionId: string) => boolean
}

/**
 * 置信类的说法。
 *
 * 刻意**不带百分比**（§6）：`user-confirmed` 是「用户明确要求过」，
 * `verified` 是「有可核验来源」，`inferred` 是「模型推断」——
 * 三者是**种类**，不是同一条轴上的刻度。
 */
export function confidenceLabelOf(kind: ProjectKnowledge['confidenceClass']): string {
  if (kind === 'user-confirmed') return '用户确认'
  if (kind === 'verified') return '已验证'
  return '模型推断'
}

/** 条目类型（界面用；导出 Markdown 时当小标题）。 */
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
  /* 两边都有值才比较：不知道当前分支（非 git / 读取失败）就**不**误报漂移 */
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
    /* 「需复核」是**派生态**：一条候选也可以因为来源被删而需复核 */
    review: views.filter((view) => view.review.needed).length
  }
}

/** 需复核原因 → 中文短语（界面与导出共用，避免两处说法不一致）。 */
export function reviewReasonText(reason: KnowledgeReviewReason): string {
  if (reason === 'branch') return '分支已变'
  if (reason === 'path') return '引用路径已不存在'
  return '来源会话不可回读'
}

/**
 * 导出 Markdown（§6「导出 Markdown」）。
 *
 * 只导出**当前状态**：不含已删除（逻辑删除的墓碑不出现在材料里 ——
 * 否则「删掉的知识」会从导出文件里回来）。
 * 已失效（`superseded`）单列一节，因为它仍是项目历史的一部分。
 */
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
