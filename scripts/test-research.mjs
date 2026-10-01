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
    excerptText,
    excerptReadable
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

  /* ---- 读得到才算证据 ---- */
  {
    ok(excerptReadable('current') && excerptReadable('outdated'), '当前版与旧版本都能作为证据读')
    ok(!excerptReadable('removed') && !excerptReadable('missing') && !excerptReadable('unreadable'), '移除 / 找不到 / 读不到的都不算有效证据')
    ok(excerptReadable(undefined), '没查状态时不拦（调用方自己负责）')
  }
}
