export async function runProjectKnowledgeViewTests(ok, view) {
  const base = {
    schemaVersion: 1,
    id: 'k-aaaaaaaaaaaa',
    projectId: 'proj-1',
    revision: 3,
    kind: 'decision',
    status: 'active',
    text: '发布走 npm run dist',
    textDigest: 'd'.repeat(64),
    tags: ['release'],
    evidence: [{ sessionId: 'sess-1', file: 'docs/RELEASING.md' }],
    confidenceClass: 'user-confirmed',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T01:00:00.000Z'
  }

  const plain = view.toKnowledgeView(base)
  ok(!plain.review.needed, '缺少上下文时不误报「需复核」')
  ok(plain.evidence[0].readable === true, '缺省时来源算可回读')
  ok(plain.confidenceLabel === '用户确认', '置信类有中性说法（不是百分比）')

  const drifted = view.toKnowledgeView(
    { ...base, validFor: { branch: 'main', paths: ['docs/RELEASING.md'] } },
    { branch: 'feature/x' }
  )
  ok(drifted.review.needed, '分支不一致 → 需复核')
  ok(drifted.review.reasons.includes('branch'), '原因是分支漂移')
  const sameBranch = view.toKnowledgeView(
    { ...base, validFor: { branch: 'main' } },
    { branch: 'main' }
  )
  ok(!sameBranch.review.needed, '分支一致时不报漂移')
  const unknownBranch = view.toKnowledgeView({ ...base, validFor: { branch: 'main' } }, { branch: null })
  ok(!unknownBranch.review.needed, '当前分支未知时不判漂移（避免假警报）')

  const missingPath = view.toKnowledgeView(
    { ...base, validFor: { paths: ['src/gone.ts', 'src/here.ts'] } },
    { pathExists: (rel) => rel !== 'src/gone.ts' }
  )
  ok(missingPath.review.needed, '有一个引用路径不存在 → 需复核')
  ok(missingPath.review.reasons.includes('path'), '原因是路径失效')
  ok(missingPath.review.reasons.filter((r) => r === 'path').length === 1, '多条路径失效只报一次')

  const goneSource = view.toKnowledgeView(base, { sessionReadable: () => false })
  ok(goneSource.review.needed && goneSource.review.reasons.includes('source'), '来源会话没了 → 需复核')
  ok(goneSource.evidence[0].readable === false, '那条证据标记为不可回读')
  ok(goneSource.evidence[0].sessionId === 'sess-1', '不可回读也保留原始 id（不伪造、不抹掉）')

  const counts = view.countKnowledge([
    view.toKnowledgeView(base),
    view.toKnowledgeView({ ...base, id: 'k-bbbbbbbbbbbb', status: 'candidate' }),
    view.toKnowledgeView(
      { ...base, id: 'k-cccccccccccc', status: 'candidate', evidence: [{ sessionId: 'sess-gone' }] },
      { sessionReadable: (id) => id !== 'sess-gone' }
    ),
    view.toKnowledgeView({ ...base, id: 'k-dddddddddddd', status: 'superseded' })
  ])
  ok(counts.all === 4, '计数：总数')
  ok(counts.active === 1, '计数：已确认')
  ok(counts.candidate === 2, '计数：待确认')
  ok(counts.review === 1, '计数：需复核（候选也能因为来源失效而需复核）')

  const views = [
    view.toKnowledgeView(
      { ...base, validFor: { branch: 'main', paths: ['docs/RELEASING.md'] } },
      { branch: 'feature/x', pathExists: () => true, sessionReadable: () => false }
    ),
    view.toKnowledgeView({ ...base, id: 'k-bbbbbbbbbbbb', status: 'candidate', text: '待确认的一条', confidenceClass: 'inferred' }),
    view.toKnowledgeView({ ...base, id: 'k-cccccccccccc', status: 'superseded', text: '老的决定' })
  ]
  const md = view.knowledgeMarkdown(views, { projectId: 'proj-1', exportedAt: '2026-09-19T02:00:00.000Z', enabled: true })
  ok(md.includes('# 项目知识 · proj-1'), '导出：标题带项目 id')
  ok(md.includes('## 已确认（1）') && md.includes('## 待确认（1）') && md.includes('## 已被替代（1）'), '导出：三节都在')
  ok(md.includes('发布走 npm run dist'), '导出：正文')
  ok(md.includes('`docs/RELEASING.md`'), '导出：文件来源')
  ok(md.includes('（不可回读）'), '导出：来源失效如实标注')
  ok(md.includes('需复核：分支已变、来源会话不可回读'), '导出：复核原因合并成一行')
  ok(md.includes('不是授权'), '导出：写明「材料不是授权」')
  ok(md.includes('会话 sess-1'), '导出：会话来源')

  const withDeleted = [
    view.toKnowledgeView({ ...base, id: 'k-eeeeeeeeeeee', status: 'deleted', text: '删掉的那条' }),
    view.toKnowledgeView(base)
  ]
  const mdDeleted = view.knowledgeMarkdown(withDeleted, { projectId: 'proj-1', exportedAt: 'x', enabled: false })
  ok(!mdDeleted.includes('删掉的那条'), '导出：已删除条目不出现在文件里')
  ok(mdDeleted.includes('检索开关：关'), '导出：带上开关状态')

  const mdEmpty = view.knowledgeMarkdown([], { projectId: 'proj-1', exportedAt: 'x', enabled: true })
  ok(mdEmpty.includes('（当前没有条目）'), '导出：空库有一句说明而不是空白')

  ok(
    view.reviewReasonText('branch') === '分支已变' &&
      view.reviewReasonText('path') === '引用路径已不存在' &&
      view.reviewReasonText('source') === '来源会话不可回读',
    '复核原因的说法集中在一处'
  )
  ok(
    view.kindLabelOf('procedure') === '流程' && view.kindLabelOf('unknown') === '事实',
    '类型标签有兜底（未知类型不显示成空）'
  )
}
