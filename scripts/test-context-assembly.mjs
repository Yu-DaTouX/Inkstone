/**
 * 上下文装配（实施-25 P05 / T05-3）的单测。
 *
 * 两部分：
 *   · `shared/context-assembly.ts` 是纯逻辑 —— 预算、顺序、引用标注；
 *   · `main/context-assembler.ts` 读真实资料库 —— 片段必须来自会话登记过的
 *     `{ sourceId, version }`，并且引用区间能**原地取回同一段正文**（验收口径）。
 */

export function runContextAssemblyTests(ok, mod) {
  const {
    assembleContext,
    renderContextSection,
    citationToken,
    parseCitationTokens,
    DEFAULT_CONTEXT_BUDGET,
    SOURCES_BUDGET_RATIO,
    MIN_SOURCE_CHARS
  } = mod

  const src = (id, version, title, text, start = 0) => ({
    ref: { sourceId: id, version },
    title,
    text,
    start
  })

  /* ---- 顺序与骨架 ---- */
  {
    const assembly = assembleContext({
      activity: 'research',
      requirement: '比较这几份资料',
      task: '目标：写一份对比',
      space: '产品调研',
      preference: '中文',
      sources: [src('s1', 1, '资料一', 'A'.repeat(400))]
    })
    const order = assembly.fragments.map((f) => f.section).join(',')
    ok(
      order === 'requirement,task,sources,space,preference',
      '输出顺序对齐设计稿（要求 → 任务 → 来源 → 空间 → 偏好）',
      order
    )
    ok(assembly.citations.length === 1, '来源片段带一条引用')
    ok(assembly.citations[0].locator.start === 0 && assembly.citations[0].locator.end === 400, '引用区间覆盖该片段')
    ok(assembly.budget.used === assembly.fragments.reduce((n, f) => n + f.text.length, 0), 'used 与片段正文总长一致')
  }

  /* ---- 引用标注往返（界面「跳回原文」靠它） ---- */
  {
    const token = citationToken({ sourceId: 'src-9', version: 3, title: 'x', locator: { start: 10, end: 42 } })
    ok(token === '⟦src-9@3#10-42⟧', '引用标注格式固定', token)
    const parsed = parseCitationTokens(`结论甲 ${token} 结论乙 ${citationToken({ sourceId: 'src-1', version: 2, title: 'y' })}`)
    ok(parsed.length === 2, '能从文本里解析回两条引用')
    ok(parsed[0].sourceId === 'src-9' && parsed[0].version === 3, '解析回 sourceId / version')
    ok(parsed[0].locator.start === 10 && parsed[0].locator.end === 42, '解析回字符区间')
    ok(parsed[1].locator === undefined, '没有区间的引用不带 locator')
    ok(parseCitationTokens('没有引用的普通文本').length === 0, '普通文本解析结果为空')
  }

  /* ---- 预算：来源有独立上限，骨架不被挤没 ---- */
  {
    const many = Array.from({ length: 8 }, (_, i) => src(`s${i}`, 1, `资料${i}`, 'B'.repeat(3000)))
    const assembly = assembleContext({ activity: 'research', task: '任务', space: '空间', sources: many })
    const usedBySources = assembly.fragments
      .filter((f) => f.section === 'sources')
      .reduce((n, f) => n + f.text.length, 0)
    ok(usedBySources <= Math.floor(DEFAULT_CONTEXT_BUDGET * SOURCES_BUDGET_RATIO), '来源总占用不超过 60% 预算', String(usedBySources))
    ok(assembly.fragments.some((f) => f.section === 'task' && f.text === '任务'), '骨架（任务）没被来源挤掉')
    ok(assembly.fragments.some((f) => f.section === 'space'), '骨架（空间）没被来源挤掉')
    ok(assembly.budget.dropped > 0, '放不下的来源计入 dropped')
    ok(assembly.budget.truncated > 0, '被裁短的来源计入 truncated')
  }

  /* ---- 小预算下：来源整条不带，也不给半句话 ---- */
  {
    const assembly = assembleContext(
      { activity: 'research', task: '任务', sources: [src('s1', 1, '资料', 'C'.repeat(1000))] },
      MIN_SOURCE_CHARS + 20
    )
    const sourceChars = assembly.fragments.filter((f) => f.section === 'sources').reduce((n, f) => n + f.text.length, 0)
    ok(sourceChars === 0 || sourceChars >= MIN_SOURCE_CHARS, '不是半句话（要么整条，要么不带）', String(sourceChars))
  }

  /* ---- 渲染：空装配不注入空分区 ---- */
  {
    ok(renderContextSection(assembleContext({ activity: 'answer' })) === null, '没有内容时返回 null（不注入空分区）')
    const rendered = renderContextSection(
      assembleContext({ activity: 'research', task: '任务', sources: [src('s1', 2, '资料一', '正文片段')] })
    )
    ok(typeof rendered === 'string' && rendered.includes('来源片段'), '渲染出「来源片段」分区')
    ok(rendered.includes('⟦s1@2#0-4⟧'), '渲染文本里带引用标注（可被解析回原文）', rendered)
  }
}

/** 读盘部分：真实资料库 → 装配 → 快照。 */
export async function runContextAssemblerTests(ok, mod, helpers) {
  const { ContextAssembler, writeContextSnapshot, readContextSnapshot, contextSnapshotPath } = mod
  const { mkdtemp, rm } = helpers
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { LibraryService } = await import('../out/test/library-service.mjs')

  const root = await mkdtemp(join(tmpdir(), 'yan-ctx-'))
  try {
    const library = new LibraryService({ root })
    const body = '第一段是关于预算的说明。\n第二段是关于来源绑定的说明。\n第三段是结论。'
    const imported = await library.import({
      kind: 'text',
      ref: 'note-1',
      title: '研究笔记',
      content: body,
      owner: { kind: 'session', id: 'sess-1' }
    })
    ok(imported.ok && imported.sourceId, '导入一份文本资料')
    const ref = { sourceId: imported.sourceId, version: imported.version }

    const assembler = new ContextAssembler({ root, library })

    /* ---- 会话登记过的引用才进上下文，且正文可原地取回 ---- */
    const assembly = await assembler.assemble({ activity: 'research', sessionId: 'sess-1', task: '目标：核对来源' })
    ok(assembly.fragments.some((f) => f.section === 'task'), '任务分区存在')
    ok(assembly.citations.length === 1, '装配出 1 条来源引用')
    const citation = assembly.citations[0]
    ok(citation.sourceId === ref.sourceId && citation.version === ref.version, '引用指向登记的那一版')

    const opened = await library.openRef(ref, { maxChars: 100_000 })
    const sliced = (opened.text ?? '').slice(citation.locator.start, citation.locator.end)
    const fragment = assembly.fragments.find((f) => f.section === 'sources')
    ok(sliced === fragment.text, '按引用区间取回的正文与注入片段逐字一致（「跳回原文」的语义）')

    /* ---- 没登记引用的会话不带来源 ---- */
    const other = await assembler.assemble({ activity: 'research', sessionId: 'sess-other' })
    ok(other.citations.length === 0, '没有登记引用的会话不带来源片段')
    ok(other.fragments.every((f) => f.section !== 'sources'), '不凭空造来源')

    /* ---- 没有正文的引用不进上下文（附件 / 无法提取） ---- */
    await library.import({ kind: 'image', ref: 'pic', title: '扫描件', content: 'fake-bytes', owner: { kind: 'session', id: 'sess-1' } })
    const afterImage = await assembler.assemble({ activity: 'research', sessionId: 'sess-1' })
    ok(afterImage.citations.length === 1, '图片（unsupported）不进上下文，只有文本那条进来', String(afterImage.citations.length))

    /* ---- 快照写读往返 ---- */
    await writeContextSnapshot('runner-1', assembly, root)
    const snapshot = await readContextSnapshot('runner-1', root)
    ok(!!snapshot, '快照写得进去也读得回来')
    ok(snapshot.section?.includes('来源片段') === true, '快照里是渲染好的注入文本')
    ok(snapshot.citations.length === 1, '快照带着引用（界面 / 诊断可用）')
    ok(contextSnapshotPath('runner-1', root).endsWith(join('agent-context', 'runner-1.json')), '快照路径与扩展读取口径一致')

    /* ---- 写盘失败不抛（上下文是增强） ---- */
    const bad = new ContextAssembler({ root: join(root, 'file-not-dir'), library })
    const still = await bad.assemble({ activity: 'answer' })
    ok(still.activity === 'answer', '无法写盘时装配本身仍然返回')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
