/**
 * 跨资料研究（实施-25 P13）—— 引用状态 / 多来源对照 / 片段切片。
 *
 * 三条最值得钉住的：
 *   · **旧引用按版本保留**：来源更新后只提示「已有新版本」，不改引用；
 *   · **不合并结论**：不同立场的两组并排列出，未标注立场的不算冲突；
 *   · **读不到的来源不进对照**：宁可少一份证据，也不把读不到的说成有效。
 */

/** 造一份最小可用的资料库文档（只带一个来源与它的版本）。 */
function libDoc(over = {}) {
  const source = {
    id: over.sourceId ?? 'lib_1',
    kind: 'text',
    title: over.title ?? '对照材料 A',
    createdAt: 0,
    updatedAt: 0,
    ...(over.removedAt !== undefined ? { removedAt: over.removedAt } : {})
  }
  const versions = (over.versions ?? [
    { version: 1, parse: { status: 'ok', textPath: 'library/text/lib_1-v1.txt' } }
  ]).map((v) => ({
    sourceId: source.id,
    version: v.version,
    identity: `text:${source.id}`,
    ref: `${source.id}-v${v.version}`,
    title: source.title,
    fingerprint: `fp-${v.version}`,
    addedAt: v.version,
    available: v.available !== false,
    parse: { note: '', at: 0, ...v.parse }
  }))
  return {
    version: 1,
    sources: over.noSource ? [] : [source],
    versions: over.noVersion ? [] : versions,
    refs: [],
    legacy: []
  }
}

export function runResearchTests(ok, mod) {
  const {
    sourceStatus,
    artifactSourceStatuses,
    sourceChangeSummary,
    buildComparison,
    comparisonText,
    excerptText,
    excerptReadable,
    provenanceLabel,
    COMPARISON_NOTE,
    UNLABELED_STANCE
  } = mod

  /* ---- 引用状态（T13-4） ---- */
  {
    const current = sourceStatus(libDoc(), { sourceId: 'lib_1', version: 1 })
    ok(current.status === 'current' && current.title === '对照材料 A', '能读到的当前版本：current', JSON.stringify(current))

    const outdated = sourceStatus(
      libDoc({ versions: [{ version: 1, parse: { status: 'ok', textPath: 'a' } }, { version: 2, parse: { status: 'ok', textPath: 'b' } }] }),
      { sourceId: 'lib_1', version: 1 }
    )
    ok(outdated.status === 'outdated' && outdated.latestVersion === 2, '有新版：outdated，并带上最新版本号')
    ok(/来源已更新到 v2/.test(outdated.note) && /仍指着 v1/.test(outdated.note), '文案说清「哪一版是新的、引用还指着哪一版」')

    const removed = sourceStatus(libDoc({ removedAt: 123 }), { sourceId: 'lib_1', version: 1 })
    ok(removed.status === 'removed' && /旧版本仍能打开/.test(removed.note), '来源移除：仍然能打开旧版本（P03 不变量）')

    ok(sourceStatus(libDoc(), { sourceId: 'nope', version: 1 }).status === 'missing', '找不到这条来源：missing')
    ok(sourceStatus(libDoc({ noVersion: true }), { sourceId: 'lib_1', version: 9 }).status === 'missing', '这一版不存在：missing')

    const unreadable = sourceStatus(
      libDoc({ versions: [{ version: 1, parse: { status: 'unsupported' } }] }),
      { sourceId: 'lib_1', version: 1 }
    )
    ok(unreadable.status === 'unreadable', '没有可读正文：unreadable')

    /* 变化汇总：没有变化就返回 null（界面上不制造噪声） */
    ok(sourceChangeSummary([current]) === null, '全都正常时不产生提示')
    const summary = sourceChangeSummary([outdated, removed])
    ok(!!summary && /1 条来源已有新版本/.test(summary) && /1 条来源已找不到/.test(summary), '变化汇总分开数「有新版本」与「找不到」', String(summary))

    const statuses = artifactSourceStatuses(libDoc(), [
      { sourceId: 'lib_1', version: 1, locator: { start: 3, end: 9 } },
      { sourceId: 'lib_gone', version: 2 }
    ])
    ok(statuses.length === 2 && statuses[0].status === 'current' && statuses[1].status === 'missing', '成果的两条引用各自独立判定')
    ok(statuses[0].ref.locator?.start === 3, 'locator 原样带回来（界面上要能标出位置）')
  }

  /* ---- 片段切片 ---- */
  {
    const body = '零一二三四五六七八九十'
    ok(excerptText(body, { start: 2, end: 5 }, 100).text === '二三四', '有 locator 就切那一段')
    ok(excerptText(body, undefined, 3).text === '零一二', '没有 locator 取开头一段')
    ok(excerptText(body, undefined, 3).truncated === true, '被截断要如实标出来')
    ok(excerptText(body, { start: 99, end: 200 }, 100).text === '', '越界的 locator 切成空（不抛错）')
    ok(excerptText('', undefined, 10).text === '', '空正文返回空')
  }

  /* ---- 对照：分组、不合并、provenance ---- */
  {
    const a = { sourceId: 'lib_a', version: 1, title: '材料 A', provenance: 'material', text: '这个说法成立。', stance: '支持' }
    const b = { sourceId: 'lib_b', version: 2, title: '材料 B', provenance: 'material', text: '这个说法不成立。', stance: '反对' }
    const c = { sourceId: 'lib_c', version: 1, title: '模型补的一段', provenance: 'model', text: '还有一种可能：条件不同。' }

    const comparison = buildComparison({ question: '这个说法成立吗？', excerpts: [a, b, c] })
    ok(comparison.groups.length === 3, '三种立场各自成组（含未标注）', JSON.stringify(comparison.groups.map((g) => g.label)))
    ok(comparison.groups.some((g) => g.label === UNLABELED_STANCE), '没给 stance 的归到「未标注立场」')
    ok(comparison.conflicts.length === 1, '两个显式且不同的立场 → 一条冲突')
    ok(/「支持」与「反对」/.test(comparison.conflicts[0].label), '冲突只说「不一致」，不下结论', comparison.conflicts[0].label)
    ok(comparison.provenance.material === 2 && comparison.provenance.model === 1, '来源构成分开统计')
    ok(comparison.note === COMPARISON_NOTE, 'note 写成「没有合并成一个结论」')

    const text = comparisonText(comparison)
    ok(/【支持】/.test(text) && /【反对】/.test(text), '导出文本里两组都在')
    ok(/引用原文/.test(text) && /模型补充/.test(text), '导出文本标出「引用原文 / 模型补充」的区别')
    ok(text.includes(COMPARISON_NOTE), '导出文本也带上「不合并」的说明')

    /* 未标注之间的两份不构成冲突（我们不知道它们是不是在讲同一件事） */
    const sameOnly = buildComparison({
      question: 'q',
      excerpts: [c, { ...c, sourceId: 'lib_d' }]
    })
    ok(sameOnly.conflicts.length === 0 && sameOnly.groups.length === 1, '都没有立场标签时不制造冲突')

    const empty = buildComparison({ question: 'q', excerpts: [] })
    ok(empty.groups.length === 0 && empty.provenance.material === 0, '没有摘录时如实给空结果')

    ok(provenanceLabel('model') === 'model' && provenanceLabel(undefined) === 'material', '未知 provenance 一律按「引用原文」（宁可保守）')
    ok(excerptReadable('current') && excerptReadable('outdated'), '当前版与旧版本都能作为证据读')
    ok(!excerptReadable('removed') && !excerptReadable('missing') && !excerptReadable('unreadable'), '移除 / 找不到 / 读不到的都不进对照')
    ok(excerptReadable(undefined), '没查状态时不拦（调用方自己负责）')
  }
}
