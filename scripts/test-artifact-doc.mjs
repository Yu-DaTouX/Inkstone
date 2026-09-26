/**
 * 可编辑成果（实施-25 P06a）的单测：契约 / 版本推进 / **用户编辑不被覆盖** / 存储。
 *
 * 为什么最值得钉的是那一条不变量：
 *   「用户改过的段落被 agent 重写整篇时不能丢」——它错了不会报任何错，
 *   用户只会发现自己的修改在某次 agent 改写后不见了，而且无法恢复。
 */

export function runArtifactDocTests(ok, mod) {
  const {
    splitParagraphs,
    joinParagraphs,
    createArtifactDoc,
    applyUserEdit,
    applyAgentEdit,
    renameArtifact,
    addArtifactSource,
    assignArtifact,
    parseChecklist,
    toggleChecklistItem,
    checklistToText,
    isChecklistText,
    renderArtifactMarkdown,
    sanitizeArtifactDocument,
    currentTextOf,
    currentVersionOf,
    validateArtifactTitle,
    MAX_ARTIFACT_VERSIONS
  } = mod

  const mkDoc = (text = '第一段\n\n第二段\n\n第三段') => {
    const res = createArtifactDoc({ title: '研究报告', text, spaceId: 'sp1' }, 1000, () => 'ad_test1')
    ok(res.ok === true, '建成果成功', JSON.stringify(res))
    return res.doc
  }

  /* ---- 段落：作者的单位 ---- */
  ok(splitParagraphs('a\n\nb\n\nc').join('|') === 'a|b|c', '按空行分段')
  ok(splitParagraphs('a\nb').length === 1, '单换行不分段')
  ok(splitParagraphs('   ').length === 0, '空白正文没有段落')
  ok(joinParagraphs(['a', 'b']) === 'a\n\nb', '段落拼回正文')

  /* ---- 结构化清单（P06b）：勾选是用户编辑，不是界面私改 ---- */
  {
    const created = createArtifactDoc(
      { title: '清单', kind: 'checklist', text: '- [ ] 读一章\n- [x] 写笔记\n- [ ] 复习' },
      1000,
      () => 'ad_check1'
    )
    ok(created.ok === true && created.doc.kind === 'checklist', '建清单类成果', JSON.stringify(created))
    const text = currentTextOf(created.doc)
    const items = parseChecklist(text)
    ok(items.length === 3, '解析出 3 条', String(items.length))
    ok(items[0].done === false && items[1].done === true, '勾选状态解析正确')
    ok(isChecklistText(text) === true, '认得这是清单')

    const toggled = toggleChecklistItem(text, 0)
    ok(toggled.ok === true && toggled.text.startsWith('- [x] 读一章'), '勾选第 1 条', toggled.ok ? toggled.text : toggled.reason)
    ok(parseChecklist(toggled.text)[1].done === true, '勾一条不动其他条')
    ok(toggleChecklistItem(text, 9).ok === false, '越界勾选被拒')
    ok(checklistToText([{ text: 'a', done: true }, { text: 'b', done: false }]) === '- [x] a\n- [ ] b', '条目拼回 Markdown')

    /* 普通段落不能被误判成清单 */
    ok(parseChecklist('第一段\n\n第二段').length === 0, '普通段落解析不出条目')
    ok(isChecklistText('第一段') === false, '普通段落不认作清单')

    const bad = createArtifactDoc({ title: 'x', kind: 'pdf' }, 1000, () => 'ad_bad')
    ok(bad.ok === false, '未知成果类型被拒（不静默回落）')
  }

  /* ---- 导出（P06b）：Markdown + 来源，标题现取 ---- */
  {
    const doc = mkDoc()
    const md = renderArtifactMarkdown(doc, [{ sourceId: 'lib_a', version: 2, title: '行业报告' }])
    ok(md.startsWith('# 研究报告'), '导出以标题开头')
    ok(md.includes('第一段'), '导出带正文')
    ok(md.includes('## 来源') && md.includes('行业报告（lib_a@v2）'), '导出带来源标题与版本')
    ok(!renderArtifactMarkdown(doc, []).includes('## 来源'), '没有来源时不写来源小节')
    ok(renderArtifactMarkdown(doc, [{ sourceId: 'lib_b', version: 1 }]).includes('lib_b@v1'), '取不到标题时回落成 id')
  }

  /* ---- 来源引用带定位区间（P06b：「回原文」的底子） ---- */
  {
    const doc = mkDoc()
    const res = addArtifactSource(doc, { sourceId: 'lib_z', version: 3, locator: { start: 10, end: 20 } }, 2000)
    ok(res.ok === true && res.doc.sources[0].locator?.end === 20, '来源可带定位区间')
    const again = addArtifactSource(res.doc, { sourceId: 'lib_z', version: 3, locator: { start: 99, end: 120 } }, 3000)
    ok(again.ok === true && again.unchanged === true, '同一 sourceId+version 幂等（不重复堆叠）')
  }

  /* ---- 建成果 ---- */
  {
    const doc = mkDoc()
    ok(doc.id === 'ad_test1' && doc.spaceId === 'sp1', '稳定 ID 与归属空间')
    ok(doc.kind === 'markdown' && doc.currentVersion === 1, '第一版是 markdown')
    const v1 = currentVersionOf(doc)
    ok(v1?.editedBy === 'user', '第一版由用户建立')
    ok(v1?.userEditedParagraphs.length === 0, '初稿不算「用户改过的段落」（否则 agent 一个字都改不了）')
    ok(currentTextOf(doc) === '第一段\n\n第二段\n\n第三段', '正文正确')

    const bad = createArtifactDoc({ title: '   ' }, 1, () => 'x')
    ok(bad.ok === false && /标题/.test(bad.reason), '空标题被拒')
    ok(validateArtifactTitle('a'.repeat(500)).ok === false, '超长标题被拒')
  }

  /* ---- 用户编辑：新版本 + 记下改过的段落 ---- */
  {
    let doc = mkDoc()
    const saved = applyUserEdit(doc, '第一段\n\n第二段（用户改）\n\n第三段', 2000)
    ok(saved.ok === true, '用户保存成功')
    doc = saved.doc
    ok(doc.currentVersion === 2 && doc.versions.length === 2, '开了一个新版本')
    const v2 = currentVersionOf(doc)
    ok(v2.editedBy === 'user' && v2.basedOn === 1, '版本归属与基线正确')
    ok(v2.userEditedParagraphs.join(',') === '1', '记下用户改的是第 2 段（0 基）', v2.userEditedParagraphs.join(','))

    const same = applyUserEdit(doc, currentTextOf(doc), 3000)
    ok(same.ok === true && same.unchanged === true && same.doc.currentVersion === 2, '内容没变就不开新版本')

    /* 空文档里新写的段是「扩展内容」而非「改动」，不该把 agent 锁死 */
    const empty = createArtifactDoc({ title: '空白稿' }, 1, () => 'ad_empty').doc
    const written = applyUserEdit(empty, '甲\n\n乙', 2000)
    ok(written.ok === true, '空文档写入成功')
    ok(
      written.doc.versions.find((v) => v.version === 2).userEditedParagraphs.length === 0,
      '新增段落不算「用户改过」（否则 agent 整篇重写全被保护）'
    )
  }

  /* ---- 核心不变量：agent 重写整篇，用户改过的段落不丢 ---- */
  {
    let doc = mkDoc()
    doc = applyUserEdit(doc, '第一段\n\n第二段（用户改）\n\n第三段', 2000).doc

    const rewritten = applyAgentEdit(
      doc,
      { baseVersion: 2, mode: 'rewrite-all', text: '第一段（agent 改）\n\n第二段（agent 重写）\n\n第三段（agent 改）' },
      3000
    )
    ok(rewritten.ok === true, 'agent 整篇重写成功')
    doc = rewritten.doc
    const paragraphs = splitParagraphs(currentTextOf(doc))
    ok(paragraphs[1] === '第二段（用户改）', '用户改过的第 2 段被保留（不丢）', paragraphs[1])
    ok(paragraphs[0] === '第一段（agent 改）' && paragraphs[2] === '第三段（agent 改）', '其它段落按 agent 的新稿改')
    ok(rewritten.preserved?.join(',') === '1', '回报被保留的段落号', String(rewritten.preserved))
    ok(currentVersionOf(doc).editedBy === 'agent', '这一版是 agent 写的')

    /* 用户改过的段如果 agent 新稿没动它，不算「保留」 */
    const again = applyAgentEdit(doc, { baseVersion: 3, mode: 'rewrite-all', text: '第一段（agent 改）\n\n第二段（用户改）\n\n第三段（agent 再改）' }, 4000)
    ok(again.ok === true && (again.preserved?.length ?? 0) === 0, '新稿与用户版一致时无需保护')
  }

  /* ---- agent 定向改某段：显式修改，允许覆盖 ---- */
  {
    let doc = mkDoc()
    doc = applyUserEdit(doc, '第一段\n\n第二段（用户改）\n\n第三段', 2000).doc
    const targeted = applyAgentEdit(doc, { baseVersion: 2, mode: 'replace-paragraphs', paragraphs: [{ index: 1, text: '第二段（用户要求改成这样）' }] }, 3000)
    ok(targeted.ok === true, '定向替换成功')
    doc = targeted.doc
    ok(splitParagraphs(currentTextOf(doc))[1] === '第二段（用户要求改成这样）', '定向替换确实改了那一段')
    ok(!currentVersionOf(doc).userEditedParagraphs.includes(1), '被定向替换的段不再是「用户手写内容」')
  }

  /* ---- 基线 / 越界：显式拒绝 ---- */
  {
    const doc = mkDoc()
    const stale = applyAgentEdit(doc, { baseVersion: 1, mode: 'rewrite-all', text: 'x' }, 1)
    ok(stale.ok === true, '基线等于当前版本时可改')
    const stale2 = applyAgentEdit(doc, { baseVersion: 9, mode: 'rewrite-all', text: 'x' }, 1)
    ok(stale2.ok === false && /基线/.test(stale2.reason), '基线过期被拒')
    const out = applyAgentEdit(doc, { baseVersion: 1, mode: 'replace-paragraphs', paragraphs: [{ index: 5, text: 'x' }] }, 1)
    ok(out.ok === false && /越界/.test(out.reason), '段落序号越界被拒')
    const empty = applyAgentEdit(doc, { baseVersion: 1, mode: 'replace-paragraphs', paragraphs: [] }, 1)
    ok(empty.ok === false, '空替换被拒')
  }

  /* ---- 标题 / 归属 / 来源 ---- */
  {
    let doc = mkDoc()
    const renamed = renameArtifact(doc, '新标题', 2000)
    ok(renamed.ok === true && renamed.doc.title === '新标题' && renamed.doc.updatedAt === 2000, '改名')
    ok(renameArtifact(doc, '', 2000).ok === false, '空标题被拒')

    const assigned = assignArtifact(doc, { spaceId: null }, 2000)
    ok(assigned.ok === true && assigned.doc.spaceId === undefined, '能把成果移出空间')

    const added = addArtifactSource(doc, { sourceId: 'lib_1', version: 2 }, 2000)
    ok(added.ok === true && added.doc.sources.length === 1, '加来源引用')
    const again = addArtifactSource(added.doc, { sourceId: 'lib_1', version: 2 }, 3000)
    ok(again.ok === true && again.unchanged === true && again.doc.sources.length === 1, '同一条来源幂等')
    ok(addArtifactSource(doc, { sourceId: '', version: 1 }, 1).ok === false, '坏引用被拒')
  }

  /* ---- 读盘容错 ---- */
  {
    const doc = mkDoc()
    const good = sanitizeArtifactDocument({ version: 1, docs: [doc, { id: '' }, null, { ...doc, id: 'ad_2', versions: [] }] })
    ok(good.docs.length === 1 && good.docs[0].id === 'ad_test1', '坏条目被丢弃（空 id / 无版本）')
    const badCurrent = sanitizeArtifactDocument({ version: 1, docs: [{ ...doc, currentVersion: 99 }] })
    ok(badCurrent.docs[0].currentVersion === 1, 'currentVersion 指向不存在的版本时回落到最新版')
    ok(sanitizeArtifactDocument(null).docs.length === 0, '空文档不报错')
    ok(MAX_ARTIFACT_VERSIONS >= 100, '版本上限足够大（关闭重开后历史仍在）')
  }
}

/** 存储：真临时目录、真原子写、落盘后重读。 */
export async function runArtifactDocStoreTests(ok, mod, helpers) {
  const { ArtifactDocStore, artifactDocPath } = mod
  const { mkdtemp, readFile, rm } = helpers
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'yan-artifact-doc-'))
  try {
    const store = new ArtifactDocStore({ root, now: () => 1000, random: () => 0.5 })
    const created = await store.create({ title: '周报', text: '一\n\n二', spaceId: 'sp1' })
    ok(created.ok === true, '建成果并落盘')
    const id = created.doc.id

    await store.create({ title: '别的空间', text: 'x', spaceId: 'sp2' })
    ok(store.list('sp1').length === 1 && store.list('sp1')[0].id === id, '按空间筛成果')

    const saved = await store.saveUserEdit(id, '一（用户改）\n\n二')
    ok(saved.ok === true && saved.doc.currentVersion === 2, '保存用户编辑')
    const edited = await store.applyAgentEdit(id, { baseVersion: 2, mode: 'rewrite-all', text: '一（agent）\n\n二（agent）' })
    ok(edited.ok === true, 'agent 重写整篇')
    ok(edited.preserved?.join(',') === '0', '存储层同样保护用户改过的段', String(edited.preserved))
    ok((await store.applyAgentEdit(id, { baseVersion: 1, mode: 'rewrite-all', text: 'x' })).ok === false, '过期基线被拒')

    await store.addSource(id, { sourceId: 'lib_x', version: 1 })

    /* 清单勾选走用户编辑：开新版本、进保护集（P06b） */
    const listDoc = await store.create({ title: '清单', kind: 'checklist', spaceId: 'sp1', text: '- [ ] a\n- [ ] b' })
    const toggled = await store.toggleChecklist(listDoc.doc.id, 1)
    ok(toggled.ok === true && toggled.doc.currentVersion === 2, '勾选清单开新版本')
    ok(toggled.doc.versions[1].userEditedParagraphs.includes(0), '勾选进用户保护集')
    ok(toggled.doc.versions[1].text.includes('- [x] b'), '勾选结果在正文里')
    ok((await store.toggleChecklist(listDoc.doc.id, 5)).ok === false, '越界勾选如实失败')

    const md = store.markdownOf(listDoc.doc.id, [])
    ok(md.ok === true && md.markdown.includes('# 清单'), '存储层能导出 Markdown')
    ok(store.markdownOf('不存在', []).ok === false, '导出不存在的成果如实失败')
    await store.rename(id, '周报（改）')

    /* 关闭重开：新 store 从磁盘读回，版本与正文仍在 */
    const reopened = new ArtifactDocStore({ root })
    await reopened.load()
    const doc = reopened.find(id)
    ok(!!doc && doc.title === '周报（改）', '重开后标题仍在')
    ok(doc.currentVersion === 3 && doc.versions.length === 3, '重开后版本历史仍在', String(doc.versions.length))
    ok(doc.versions.map((v) => v.version).join(',') === '1,2,3', '版本号连续')
    ok(doc.versions.find((v) => v.version === doc.currentVersion).text.includes('一（用户改）'), '重开后正文正确（用户改动还在）')
    ok(doc.sources.length === 1 && doc.sources[0].sourceId === 'lib_x', '重开后来源引用仍在')

    /* 坏文档不拦启动 */
    await import('node:fs/promises').then((fs) => fs.writeFile(artifactDocPath(root), '{ 不是 JSON', 'utf8'))
    const tolerant = new ArtifactDocStore({ root })
    await tolerant.load()
    ok(tolerant.list().length === 0, '坏文档读成空列表（不抛错）')

    const removed = await store.remove(id)
    ok(removed.ok === true, '删除成果')
    ok((await store.remove('不存在')).ok === false, '删不存在的成果如实失败')

    const raw = JSON.parse(await readFile(artifactDocPath(root), 'utf8'))
    ok(Array.isArray(raw.docs), '磁盘上是 v1 文档结构')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
