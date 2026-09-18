/**
 * 项目知识**检索纯逻辑**的测试（实施-03 S3）。
 *
 * 这一片没有任何 IO —— 输入是条目数组 + 一句查询，输出是命中列表与材料块。
 * 所以断言全部对着**返回值**验，重点是两条产品口径：
 *   · 无关条目 → **零注入**（不是「注入一个空壳」）；
 *   · `candidate` / `superseded` / `deleted` 连打分都不参与（`considered` 只数 active）。
 */
export function runProjectKnowledgeSearchTests(ok, search) {
  const {
    searchProjectKnowledge,
    renderKnowledgeBlock,
    estimateKnowledgeTokens,
    PROJECT_KNOWLEDGE_SEARCH_DEFAULTS
  } = search

  let seq = 0
  const entry = (over = {}) => ({
    schemaVersion: 1,
    id: `k-${String(++seq).padStart(3, '0')}`,
    projectId: 'proj-a',
    revision: 1,
    kind: 'decision',
    status: 'active',
    text: '占位',
    textDigest: '0'.repeat(16),
    tags: [],
    evidence: [],
    confidenceClass: 'user-confirmed',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...over
  })

  /* ── 中文查询：连续 CJK 段里的 bigram 命中 ───────────────────── */
  const deploy = entry({ text: '上线统一走 npm run dist，先跑完整门槛', tags: ['发布'] })
  const deployHit = searchProjectKnowledge([deploy], { queryText: '这次发布要怎么上线？' })
  ok(deployHit.hits.length === 1, '中文查询能命中同主题条目', JSON.stringify(deployHit))
  ok(deployHit.reason === undefined, '有命中时不带 skip 原因')
  ok(
    deployHit.hits[0].reasons.includes('bigram') && deployHit.hits[0].reasons.includes('tag'),
    '命中依据里同时记了 bigram 与标签',
    JSON.stringify(deployHit.hits[0].reasons)
  )

  /* ── 无关条目：必须零注入 ──────────────────────────────────── */
  const unrelated = entry({ text: '前端图标统一用内置 Icon 组件', tags: ['样式'] })
  const none = searchProjectKnowledge([unrelated], { queryText: '把数据库连接池调大一点' })
  ok(none.hits.length === 0, '无关条目一条都不注入', JSON.stringify(none.hits))
  ok(none.reason === 'no-match', '不相关时给出 no-match 原因（不是静默空结果）')
  ok(renderKnowledgeBlock(none) === '', '零命中时材料块是空串（调用方据此什么都不发）')

  const empty = searchProjectKnowledge([deploy], { queryText: '   ' })
  ok(empty.reason === 'empty-query' && empty.hits.length === 0, '空查询直接零注入')

  /* ── 状态过滤：只有 active 参与打分 ───────────────────────── */
  const entries = [
    entry({ text: '上线统一走 npm run dist', tags: ['发布'], status: 'active' }),
    entry({ text: '上线统一走 npm run dist（旧）', tags: ['发布'], status: 'superseded' }),
    entry({ text: '上线统一走 npm run dist（候选）', tags: ['发布'], status: 'candidate' }),
    entry({ text: '上线统一走 npm run dist（删了）', tags: ['发布'], status: 'deleted' })
  ]
  const filtered = searchProjectKnowledge(entries, { queryText: '上线统一走哪个命令' })
  ok(filtered.considered === 1, 'considered 只统计 active 条目', String(filtered.considered))
  ok(filtered.hits.length === 1 && filtered.hits[0].text.includes('（旧）') === false, 'superseded 不出现在命中里')
  ok(
    !filtered.hits.some((h) => h.text.includes('候选') || h.text.includes('删了')),
    'candidate / deleted 也不进命中'
  )

  /* ── 标签：正文完全不提也算相关 ─────────────────────────── */
  const tagOnly = entry({ text: '这条正文与该查询没有直接关系', tags: ['发布流程'] })
  const weakText = entry({ text: '发布流程的细节记录在另外一份文档里', tags: [] })
  const ranked = searchProjectKnowledge([weakText, tagOnly], { queryText: '发布流程' })
  ok(ranked.hits.length === 2, '两条都命中时都返回', String(ranked.hits.length))
  const tagHit = ranked.hits.find((h) => h.id === tagOnly.id)
  ok(
    tagHit?.reasons.includes('tag') === true,
    '标签命中的依据被记下来（正文完全不提也命中）',
    JSON.stringify(tagHit?.reasons)
  )
  ok(ranked.hits[0].score >= ranked.hits[1].score, '命中按分数降序排列')
  /* 长查询靠「至少命中 2 个 bigram」也能进 ── 不然稍长一点的问句全被砍掉 */
  const twoBigrams = searchProjectKnowledge([entry({ text: '发布流程与上线流程共用同一套检查', tags: [] })], {
    queryText: '发布流程上线流程还有部署流程分别是什么'
  })
  ok(twoBigrams.hits.length === 1, '命中 2 个以上 bigram 的长查询不会被误判为无关', JSON.stringify(twoBigrams))

  /* ── limit：默认 top 8 ────────────────────────────────────── */
  const many = Array.from({ length: 12 }, (_, i) => entry({ text: `发布流程第 ${i} 条注意事项`, tags: ['发布'] }))
  const limited = searchProjectKnowledge(many, { queryText: '发布流程' })
  ok(limited.hits.length === PROJECT_KNOWLEDGE_SEARCH_DEFAULTS.limit, '默认最多注入 8 条', String(limited.hits.length))
  ok(limited.dropped === 12 - PROJECT_KNOWLEDGE_SEARCH_DEFAULTS.limit, '被截掉的条数如实记录', String(limited.dropped))
  const raised = searchProjectKnowledge(many, { queryText: '发布流程', limit: 20 })
  ok(raised.hits.length === 12, 'limit 可以提高（调用方可覆盖默认）', String(raised.hits.length))

  /* ── 预算：装不下就丢，不截半句 ───────────────────────────── */
  const tinyBudget = searchProjectKnowledge(
    [entry({ text: `发布流程${'很长的正文'.repeat(40)}`, tags: ['发布'] })],
    { queryText: '发布流程', tokenBudget: 5 }
  )
  ok(tinyBudget.hits.length === 0, '预算装不下时宁可不注入', JSON.stringify(tinyBudget))
  ok(tinyBudget.reason === 'over-budget', '预算不足与「不相关」是不同的原因')
  ok(tinyBudget.dropped === tinyBudget.considered, '超预算的条数记在 dropped 里')

  const huge = searchProjectKnowledge([entry({ text: `发布流程${'很长的正文'.repeat(400)}`, tags: ['发布'] })], {
    queryText: '发布流程'
  })
  ok(huge.hits.length === 0, '单条超过单条上限时也不注入（不截断半句）')

  /* ── validFor：需复核标记 ─────────────────────────────────── */
  const scoped = entry({ text: '发布流程只走 tag 构建', tags: ['发布'], validFor: { branch: 'release' } })
  const sameBranch = searchProjectKnowledge([scoped], {
    queryText: '发布流程',
    current: { branch: 'release' }
  })
  ok(sameBranch.hits[0].reviewNeeded === false, '分支一致时不标需复核')
  const otherBranch = searchProjectKnowledge([scoped], {
    queryText: '发布流程',
    current: { branch: 'main' }
  })
  ok(otherBranch.hits[0].reviewNeeded === true, '分支不一致时标需复核')
  const noCurrent = searchProjectKnowledge([scoped], { queryText: '发布流程' })
  ok(noCurrent.hits[0].reviewNeeded === false, '没给当前状态时不下「需复核」的结论（不猜）')

  /* ── 材料块：来源、有效范围、不作为授权 ───────────────────── */
  const block = renderKnowledgeBlock(
    searchProjectKnowledge([entry({ text: '发布流程走 npm run dist', tags: ['发布'], validFor: { branch: 'main' } })], {
      queryText: '发布流程',
      current: { branch: 'main' }
    })
  )
  ok(block.startsWith('<project-knowledge'), '材料块有明确的标签边界')
  ok(/id=k-/.test(block), '材料块里带来源 id（可追溯）')
  ok(/decision · user-confirmed/.test(block), '材料块里带类型与证据层级')
  ok(/不是授权/.test(block) && /不是当前指令/.test(block), '材料块写明「不作为授权 / 不是当前指令」')
  ok(/仅适用于 分支 main/.test(block), '材料块带有效范围')
  ok(/<\/project-knowledge>/.test(block), '材料块闭合')
  const blockReview = renderKnowledgeBlock(
    searchProjectKnowledge([scoped], { queryText: '发布流程', current: { branch: 'dev' } })
  )
  ok(/需复核/.test(blockReview), '需复核的条目在材料块里标出来')

  /* ── ASCII 项目（英文查询 / 词命中） ───────────────────────── */
  const english = entry({ text: 'Always run typecheck before packaging a release', tags: [] })
  const enHit = searchProjectKnowledge([english], { queryText: 'how do I make a release?' })
  ok(enHit.hits.length === 1, '英文查询能命中（按命中词的字符占比，不看词数）', JSON.stringify(enHit))
  ok(enHit.hits[0].reasons.includes('word'), '英文命中的依据是 word', JSON.stringify(enHit.hits[0]?.reasons))
  const enMiss = searchProjectKnowledge([english], { queryText: 'database pooling' })
  ok(enMiss.hits.length === 0, '英文无关查询同样零注入')
  const enTag = searchProjectKnowledge([entry({ text: 'unrelated body text', tags: ['release'] })], {
    queryText: 'how do I make a release?'
  })
  ok(enTag.hits.length === 1 && enTag.hits[0].reasons.includes('tag'), '英文标签自然也能命中')

  /* ── token 估算与确定性 ───────────────────────────────────── */
  ok(estimateKnowledgeTokens('发布流程') === 4, 'CJK 按 1 字 1 token', String(estimateKnowledgeTokens('发布流程')))
  ok(estimateKnowledgeTokens('abcd') === 1, 'ASCII 按 4 字符 1 token', String(estimateKnowledgeTokens('abcd')))
  ok(estimateKnowledgeTokens('') === 0, '空串 0 token')

  const first = JSON.stringify(searchProjectKnowledge(entries, { queryText: '上线统一走哪个命令' }))
  const second = JSON.stringify(searchProjectKnowledge(entries, { queryText: '上线统一走哪个命令' }))
  ok(first === second, '同一输入重复调用结果完全一致（纯函数）')
}
