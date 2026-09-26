/**
 * 资料库（实施-25 P03）的单测：契约纯逻辑 + 存储。
 *
 * 为什么这几条最值得钉死：
 *   · **版本推进规则**：内容变了必须新建版本、旧版本一字不改 ——
 *     「更新文件后旧报告的第 N 页仍打开旧版本」全靠它；
 *   · **判定优先级**：同一状态在界面/上下文/成果里必须得到同一个结论，
 *     否则会出现「列表说已移除、打开却报错」这类自相矛盾；
 *   · **孤儿引用保留**：读盘时把指向不存在版本的引用丢掉，等于把数据问题藏起来。
 */

export function runLibraryTests(ok, mod) {
  const {
    normalizeWebUrl,
    contentIdentity,
    sameRef,
    refKey,
    decideImport,
    validateImport,
    versionByRef,
    latestVersionOf,
    versionsOf,
    refOutcome,
    refReadable,
    activeSources,
    refsForOwner,
    ownersForSource,
    legacyMappingOf,
    EMPTY_LIBRARY
  } = mod

  /* ---- URL / identity 规范化 ---- */
  {
    ok(normalizeWebUrl('HTTPS://Example.COM/a/b/#frag') === 'https://example.com/a/b', 'URL：host 小写、去 fragment、去末尾斜杠', normalizeWebUrl('HTTPS://Example.COM/a/b/#frag'))
    ok(normalizeWebUrl('https://example.com/a/?q=1&x=2') === 'https://example.com/a?q=1&x=2', 'URL：query 是内容的一部分要保留')
    ok(normalizeWebUrl('https://example.com') === 'https://example.com/', 'URL：根路径规范成 /')
    ok(normalizeWebUrl('not a url') === 'not a url', 'URL：不是合法 URL 时按原样退化（不抛）')

    ok(
      contentIdentity('file', 'C:\\Docs\\A.PDF') === contentIdentity('file', 'c:/docs/a.pdf'),
      '文件 identity：分隔符与大小写不影响「是不是同一份」'
    )
    ok(contentIdentity('file', 'C:/a.pdf') !== contentIdentity('file', 'C:/b.pdf'), '文件 identity：不同路径是不同资料')
    ok(
      contentIdentity('web', 'https://e.com/x#a') === contentIdentity('web', 'https://e.com/x#b'),
      '网页 identity：只有 fragment 不同视为同一份'
    )
    ok(contentIdentity('text', 'sha256:abc') === 'text:sha256:abc', '文本 identity 直接带内容指纹')
  }

  /* ---- 引用 ---- */
  {
    const a = { sourceId: 'lib_1', version: 1 }
    ok(sameRef(a, { sourceId: 'lib_1', version: 1 }), '同 id 同版本是同一引用')
    ok(!sameRef(a, { sourceId: 'lib_1', version: 2 }), '**同 id 不同版本不是同一引用**（这是 T03-2 的核心）')
    ok(refKey(a) === 'lib_1@1', '引用键含版本')
  }

  /* ---- 导入决策 ---- */
  {
    const empty = { ...EMPTY_LIBRARY, sources: [], versions: [], refs: [], legacy: [] }
    const input = { kind: 'file', identity: 'file:c:/a.pdf', fingerprint: 'fp1', title: 'A', ref: 'C:/a.pdf' }
    ok(decideImport(empty, input).kind === 'new-source', '没见过的内容 → 新资料')

    const doc1 = {
      ...empty,
      sources: [{ id: 's1', kind: 'file', title: 'A', createdAt: 1, updatedAt: 1 }],
      versions: [{ sourceId: 's1', version: 1, identity: 'file:c:/a.pdf', ref: 'C:/a.pdf', title: 'A', fingerprint: 'fp1', addedAt: 1, available: true, parse: { status: 'pending', note: '', at: 1 } }]
    }
    ok(decideImport(doc1, input).kind === 'unchanged', '同内容同指纹 → 幂等（不产生第二版）')
    const changed = decideImport(doc1, { ...input, fingerprint: 'fp2' })
    ok(changed.kind === 'new-version' && changed.version === 2, '同内容指纹变了 → 推进到第 2 版', JSON.stringify(changed))
    ok(decideImport(doc1, { ...input, identity: 'file:c:/b.pdf' }).kind === 'new-source', '**标题相同但内容不同 → 两份资料**（不看标题）')
    ok(decideImport(doc1, { ...input, title: '' }).kind === 'rejected', '空标题被拒')
    ok(decideImport(doc1, { ...input, fingerprint: '' }).kind === 'rejected', '缺指纹被拒（无法判断内容是否变化）')
    ok(validateImport({ ...input, kind: 'exe' }).ok === false, '未知类型被拒')
  }

  /* ---- 查询与判定优先级 ---- */
  {
    const doc = {
      version: 1,
      sources: [
        { id: 's1', kind: 'file', title: 'A', createdAt: 1, updatedAt: 1 },
        { id: 's2', kind: 'file', title: 'B', createdAt: 1, updatedAt: 2, removedAt: 99 },
        { id: 's3', kind: 'file', title: 'C', createdAt: 1, updatedAt: 3 }
      ],
      versions: [
        { sourceId: 's1', version: 1, identity: 'file:c:/a.pdf', ref: 'C:/a.pdf', title: 'A', fingerprint: 'fp1', addedAt: 1, available: true, parse: { status: 'ok', textPath: 'library/text/s1-1.txt', note: '', at: 1 } },
        { sourceId: 's1', version: 2, identity: 'file:c:/a.pdf', ref: 'C:/a.pdf', title: 'A', fingerprint: 'fp2', addedAt: 2, available: true, parse: { status: 'pending', note: '', at: 2 } },
        { sourceId: 's2', version: 1, identity: 'file:c:/b.pdf', ref: 'C:/b.pdf', title: 'B', fingerprint: 'fb', addedAt: 1, available: true, parse: { status: 'ok', textPath: 'library/text/s2-1.txt', note: '', at: 1 } },
        { sourceId: 's3', version: 1, identity: 'file:c:/c.pdf', ref: 'C:/c.pdf', title: 'C', fingerprint: 'fc', addedAt: 1, available: false, parse: { status: 'unsupported', note: '扫描件，仅附件', at: 1 } }
      ],
      refs: [
        { owner: { kind: 'session', id: 'sess-1' }, ref: { sourceId: 's1', version: 1 }, at: 1 },
        { owner: { kind: 'session', id: 'sess-2' }, ref: { sourceId: 's1', version: 1 }, at: 2 },
        { owner: { kind: 'course', id: 'course-1' }, ref: { sourceId: 's1', version: 1 }, at: 3 }
      ],
      legacy: [{ legacyId: 'src-old', sessionId: 'sess-1', sourceId: 's1', version: 1, at: 1 }]
    }

    ok(versionsOf(doc, 's1').length === 2 && latestVersionOf(doc, 's1')?.version === 2, '版本按号排序、最新版可查')
    ok(versionByRef(doc, { sourceId: 's1', version: 1 })?.fingerprint === 'fp1', '旧引用取到的是**旧版本**（不是最新版）')
    ok(refOutcome(doc, { sourceId: 's1', version: 1 }) === 'ok', '旧版本仍可读')
    ok(refOutcome(doc, { sourceId: 's1', version: 9 }) === 'missing', '不存在的版本 → missing（不静默）')
    ok(refOutcome(doc, { sourceId: 's2', version: 1 }) === 'removed', '软移除 → removed（但仍能按引用取到版本）')
    ok(refOutcome(doc, { sourceId: 's3', version: 1 }) === 'unavailable', '原件不可用优先于解析状态', refOutcome(doc, { sourceId: 's3', version: 1 }))
    ok(refOutcome(doc, { sourceId: 's1', version: 2 }) === 'pending', '解析中 → pending')
    ok(refReadable(doc, { sourceId: 's1', version: 1 }) === true, '有正文才算可读')
    ok(refReadable(doc, { sourceId: 's2', version: 1 }) === true, '软移除不影响「按引用读正文」')
    ok(refReadable(doc, { sourceId: 's2', version: 9 }) === false, '不存在的版本不可读')

    ok(activeSources(doc).map((s) => s.id).join(',') === 's3,s1', '活动列表排除软移除、按更新时间倒序', activeSources(doc).map((s) => s.id).join(','))
    ok(refsForOwner(doc, { kind: 'session', id: 'sess-1' }).length === 1, '按引用方查引用')
    ok(ownersForSource(doc, 's1').length === 3, '**同一份资料被两个会话 + 一门课引用**', String(ownersForSource(doc, 's1').length))
    ok(legacyMappingOf(doc, 'src-old', 'sess-1')?.sourceId === 's1', '旧引用映射可查')
    ok(legacyMappingOf(doc, 'src-old', 'other-session') === undefined, '旧引用映射按会话区分')
  }

}

export async function runLibraryStoreTests(ok, mod, helpers) {
  const { LibraryStore, sanitizeLibraryDocument } = mod
  const { mkdtemp, readFile, rm } = helpers
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'yan-library-'))
  try {
    const store = new LibraryStore({ root, now: () => 1000, random: () => 0.5 })
    const paper = { kind: 'file', identity: 'file:c:/docs/paper.pdf', fingerprint: 'fp1', title: '论文', ref: 'C:/docs/paper.pdf', size: 1234 }
    const created = await store.importSource(paper)
    ok(created.ok === true && created.decision === 'new-source' && created.version === 1, '新资料建第 1 版')
    const sourceId = created.sourceId ?? ''

    /* ---- 幂等 ---- */
    const again = await store.importSource(paper)
    ok(again.decision === 'unchanged' && again.sourceId === sourceId, '同内容同指纹重复导入是幂等的')
    ok(store.document().versions.length === 1, '幂等导入不产生第二个版本', String(store.document().versions.length))

    /* ---- 内容变化 → 新版本，旧版本一字不改 ---- */
    const v1Before = JSON.stringify(store.document().versions.find((v) => v.version === 1))
    const updated = await store.importSource({ ...paper, fingerprint: 'fp2', size: 4321 })
    ok(updated.decision === 'new-version' && updated.version === 2, '内容变了推进到第 2 版')
    const v1After = JSON.stringify(store.document().versions.find((v) => v.version === 1))
    ok(v1Before === v1After, '**旧版本的内容事实一字未改**（identity / ref / 指纹）')

    /* ---- 落盘 + 读回 ---- */
    {
      const raw = JSON.parse(await readFile(join(root, 'library.json'), 'utf8'))
      ok(raw.version === 1 && raw.versions.length === 2, '文档结构落盘')
      const reloaded = new LibraryStore({ root })
      await reloaded.load()
      const doc = reloaded.document()
      ok(doc.versions.length === 2, '重启后版本仍在')
      ok(doc.versions.find((v) => v.version === 1)?.fingerprint === 'fp1', '重启后旧版本指纹仍是旧的')
    }

    /* ---- 解析状态：可变状态写入，不碰内容事实 ---- */
    ok(await store.setParse(sourceId, 2, { status: 'ok', textPath: 'library/text/x.txt', chars: 100, note: '', at: 2000 }), '写解析状态')
    ok(store.document().versions.find((v) => v.version === 2)?.parse.status === 'ok', '解析状态落库')
    ok(store.document().versions.find((v) => v.version === 2)?.identity === 'file:c:/docs/paper.pdf', 'setParse 不改内容事实')

    /* ---- 引用：同一份资料被两个会话 + 一门课引用 ---- */
    await store.addRef({ kind: 'session', id: 'sess-a' }, { sourceId, version: 1 })
    await store.addRef({ kind: 'session', id: 'sess-b' }, { sourceId, version: 1 })
    await store.addRef({ kind: 'course', id: 'course-1' }, { sourceId, version: 1 })
    await store.addRef({ kind: 'session', id: 'sess-a' }, { sourceId, version: 1 })
    ok(store.document().refs.length === 3, '两个会话 + 一门课引用同一份（重复登记幂等）', String(store.document().refs.length))
    ok(await store.removeRef({ kind: 'session', id: 'sess-b' }, { sourceId, version: 1 }), '撤引用')
    ok(store.document().refs.length === 2, '撤引用只删那一条', String(store.document().refs.length))

    /* ---- 验收核心：更新文件后，旧引用仍取到旧版本 ---- */
    {
      const doc = store.document()
      const oldVersion = doc.versions.find((v) => v.sourceId === sourceId && v.version === 1)
      const newVersion = doc.versions.find((v) => v.sourceId === sourceId && v.version === 2)
      ok(oldVersion?.fingerprint === 'fp1', '**旧引用按 id+version 取到的仍是旧内容（fp1）**')
      ok(newVersion?.fingerprint === 'fp2', '最新版本是更新后的内容（fp2）')
    }

    /* ---- 软移除：只打标记，版本与引用都留 ---- */
    await store.removeSource(sourceId)
    ok(store.document().sources.find((s) => s.id === sourceId)?.removedAt === 1000, '软移除只打标记')
    ok(store.document().versions.length === 2, '软移除不删版本')
    ok(store.document().refs.length === 2, '软移除不删引用')
    await store.importSource({ ...paper, fingerprint: 'fp2', size: 4321 })
    ok(store.document().sources.find((s) => s.id === sourceId)?.removedAt === undefined, '再次导入同一份 → 视为重新加入')

    /* ---- 原件可用性：如实标记，也能恢复 ---- */
    ok((await store.setAvailability([{ sourceId, version: 2, available: false }], 5000)) > 0, '写可用性探测结果')
    ok(store.document().versions.find((v) => v.version === 2)?.available === false, '版本标为不可用')
    ok(store.document().sources.find((s) => s.id === sourceId)?.unavailableAt === 5000, '资料级也记不可用时间')
    await store.setAvailability([{ sourceId, version: 2, available: true }], 6000)
    ok(store.document().sources.find((s) => s.id === sourceId)?.unavailableAt === undefined, '原件回来后清掉不可用标记')

    /* ---- 改名不回写历史标题 ---- */
    const renamed = await store.renameSource(sourceId, '论文（改名）')
    ok(renamed.ok === true && renamed.source?.title === '论文（改名）', '改展示标题')
    ok(store.document().versions.every((v) => v.title === '论文'), '**版本里的历史标题不被改名影响**')
    ok((await store.renameSource(sourceId, '   ')).ok === false, '空标题被拒')
    ok((await store.renameSource('nope', 'x')).ok === false, '改不存在的资料被拒')

    /* ---- 旧引用映射（T03-3） ---- */
    const legacy = await store.mapLegacy({ legacyId: 'src-1', sessionId: 'sess-a', sourceId, version: 1 })
    ok(legacy?.sourceId === sourceId, '旧引用首次被接管时建映射')
    const legacyAgain = await store.mapLegacy({ legacyId: 'src-1', sessionId: 'sess-a', sourceId, version: 1 })
    ok(legacyAgain?.at === legacy?.at, '映射重复建立返回已有那条')
    ok((await store.mapLegacy({ legacyId: 'src-x', sessionId: 'sess-a', sourceId: 'ghost', version: 1 })) === null, '给不存在的资料建映射返回 null')

    /* ---- 归档到空间 ---- */
    ok(await store.attachToSpace(sourceId, 'sp_1'), '资料可归档到空间')
    ok(store.document().sources.find((s) => s.id === sourceId)?.spaceId === 'sp_1', '空间归属落库')
  /* ---- 读盘容错 ---- */
  {
    const doc = sanitizeLibraryDocument({
      version: 1,
      sources: [
        { id: 's1', kind: 'file', title: 'A', createdAt: 1, updatedAt: 1 },
        { id: '', kind: 'file', title: 'bad id' },
        { id: 's2', kind: 'exe', title: 'bad kind' },
        { id: 's1', kind: 'file', title: 'dup' }
      ],
      versions: [
        { sourceId: 's1', version: 1, identity: 'file:c:/a.pdf', ref: 'C:/a.pdf', title: 'A', fingerprint: 'fp', addedAt: 1, available: true, parse: { status: 'ok', note: '', at: 1 } },
        { sourceId: 'ghost', version: 1, identity: 'file:c:/g.pdf', ref: 'C:/g.pdf', title: 'G', fingerprint: 'fg', addedAt: 1, available: true, parse: { status: 'pending', note: '', at: 1 } },
        { sourceId: 's1', version: 1, identity: 'file:c:/dup.pdf', ref: 'C:/dup.pdf', title: 'dup', fingerprint: 'fd', addedAt: 1, available: true, parse: { status: 'pending', note: '', at: 1 } }
      ],
      refs: [
        { owner: { kind: 'session', id: 'sess-1' }, ref: { sourceId: 's1', version: 1 }, at: 1 },
        { owner: { kind: 'session', id: 'sess-1' }, ref: { sourceId: 'ghost', version: 7 }, at: 1 },
        { owner: { kind: 'nope', id: 'x' }, ref: { sourceId: 's1', version: 1 }, at: 1 }
      ],
      legacy: [{ legacyId: 'l1', sessionId: 'sess-1', sourceId: 's1', version: 1, at: 1 }, { legacyId: '', sessionId: 'sess-1' }]
    })
    ok(doc.sources.length === 1, '坏 source 与重复 id 被丢弃', String(doc.sources.length))
    ok(doc.versions.length === 1, '孤儿版本与重复版本被丢弃', String(doc.versions.length))
    ok(doc.refs.length === 2, '非法 owner 被丢弃', String(doc.refs.length))
    ok(doc.refs.some((r) => r.ref.sourceId === 'ghost'), '**指向不存在版本的引用被保留**（它是「引用不可用」的证据，不能被藏掉）')
    ok(doc.legacy.length === 1, '坏旧引用映射被丢弃', String(doc.legacy.length))
  }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
