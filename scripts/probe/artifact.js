/**
 * 可编辑成果（实施-25 P06a）—— 真实窗口里走一遍。
 *
 * 覆盖 P06a 的出口：
 *   · 新建 → 编辑 → 保存 → 版本推进；
 *   · **关闭重开**后版本与正文仍正确（数据在宿主，不是内存里的草稿）；
 *   · **核心不变量**：用户在 agent 稿上改过的段落，被 agent 整篇重写时不丢
 *     （`preserved` 回报）；同时确认「用户新写的段」不会把 agent 锁死。
 *
 * agent 那一步直接调 IPC（`window.yan.artifactDoc.applyAgentEdit`）模拟模型侧调用 ——
 * 真实模型是否照着写需要额度，本场景 cost 0，不跑模型。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const S = () => store.getState()

  /** React 受控输入：必须走原生 setter + input 事件 */
  const setInput = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const pressEnter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(400)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 24; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  log('=== 1. 日常 + 空间归属 ===')
  const modeSwitch = q('[data-testid="mode-switch"]')
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  ok(S().workspaceMode === 'daily', '已切到日常模式', String(S().workspaceMode))

  const space = await S().createSpace('探针空间（成果）')
  ok(!!space, '建空间成功', space?.id)
  if (!space) return out.join('\n')

  const current = S().session
  let target = S().sessions.find((x) => x.id === current?.sessionId || x.path === current?.sessionFile)
  if (!target) {
    log('  · 当前会话是新建未落盘的（不在列表里）→ 切到列表里的真实会话')
    const fallback = S().sessions[0]
    if (fallback) {
      await S().switchSession(fallback.path)
      await sleep(900)
      target = S().sessions.find((x) => x.path === fallback.path)
    }
  }
  if (target) {
    await S().setSessionSpace(target.id, space.id)
    await sleep(500)
  }

  log('=== 2. 打开成果页 ===')
  click(q('[data-testid="view-space"]'))
  await sleep(500)
  click(q('[data-testid="space-tab-artifact"]'))
  await sleep(600)
  ok(!!q('[data-testid="space-artifact"]'), '成果页渲染（不再是占位）')

  log('=== 3. 新建成果 ===')
  const titleInput = q('[data-testid="space-art-new-title"]')
  if (!titleInput) return out.join('\n') + '\n✗ 找不到新建标题输入'
  setInput(titleInput, '探针报告')
  await sleep(150)
  pressEnter(titleInput)
  await sleep(700)
  const title = q('[data-testid="space-art-title"]')?.value ?? ''
  ok(title === '探针报告', '新建后编辑器打开该成果', JSON.stringify(title))
  const editorDoc = S().artifactDocs.find((d) => d.title === '探针报告')
  ok(!!editorDoc, 'store 里有这份成果')
  if (!editorDoc) return out.join('\n')
  const id = editorDoc.id

  log('=== 4. 用户写初稿：新增内容不算「用户改过」（否则 agent 会被锁死） ===')
  const userDraft = '第一段：背景。\n\n第二段：我先写的这段。\n\n第三段：结论。'
  const body = q('[data-testid="space-art-body"]')
  setInput(body, userDraft)
  await sleep(200)
  ok(!!q('[data-testid="space-art-dirty"]'), '改动后标记「未保存」')
  click(q('[data-testid="space-art-save"]'))
  await sleep(700)
  let doc = S().artifactDocs.find((d) => d.id === id)
  ok(doc?.currentVersion === 2, '保存开了一个新版本（v2）', String(doc?.currentVersion))
  ok(doc?.versions.find((v) => v.version === 2)?.editedBy === 'user', '这一版记为用户编辑')
  ok(
    (doc?.versions.find((v) => v.version === 2)?.userEditedParagraphs.length ?? -1) === 0,
    '新写的段落不被当成「用户改过」（agent 仍能整篇重写）',
    JSON.stringify(doc?.versions.find((v) => v.version === 2)?.userEditedParagraphs)
  )

  log('=== 5. agent 写一版（此时无保护，能改） ===')
  const agentV1 = '第一段：背景（agent）。\n\n第二段：agent 的写法。\n\n第三段：结论（agent）。'
  const first = await window.yan.artifactDoc.applyAgentEdit(id, { baseVersion: 2, mode: 'rewrite-all', text: agentV1 })
  ok(first?.ok === true, 'agent 整篇重写成功', JSON.stringify(first?.error))
  ok((first?.preserved?.length ?? -1) === 0, '没有需要保护的段落', JSON.stringify(first?.preserved))
  ok(first?.doc?.currentVersion === 3, 'agent 那一版落盘（v3）', String(first?.doc?.currentVersion))

  log('=== 6. 用户在 agent 稿上改一段 → 该段进入保护 ===')
  const userEdited = '第一段：背景（agent）。\n\n第二段：不，我要这么写。\n\n第三段：结论（agent）。'
  const saved = await S().saveArtifactText(id, userEdited)
  ok(saved?.ok === true, '用户保存修改')
  doc = S().artifactDocs.find((d) => d.id === id)
  ok(doc?.currentVersion === 4, '用户修改开新版本（v4）', String(doc?.currentVersion))
  ok(
    JSON.stringify(doc?.versions.find((v) => v.version === 4)?.userEditedParagraphs) === '[1]',
    '只把「改过的既有段」记为受保护（第 2 段）',
    JSON.stringify(doc?.versions.find((v) => v.version === 4)?.userEditedParagraphs)
  )

  log('=== 7. agent 再整篇重写：用户改过的那段不丢 ===')
  const agentV2 = '第一段：背景（agent v2）。\n\n第二段：agent v2 又想重写。\n\n第三段：结论（agent v2）。'
  const second = await window.yan.artifactDoc.applyAgentEdit(id, { baseVersion: 4, mode: 'rewrite-all', text: agentV2 })
  ok(second?.ok === true, 'agent 第二次整篇重写成功', JSON.stringify(second?.error))
  ok(second?.preserved?.join(',') === '1', '回报被保留的用户段落（第 2 段）', JSON.stringify(second?.preserved))
  const v5text = second?.doc?.versions.find((v) => v.version === 5)?.text ?? ''
  const paragraphs = v5text.split('\n\n')
  ok(paragraphs[1] === '第二段：不，我要这么写。', '第 2 段仍是用户写的那段（没有被 agent 覆盖）', JSON.stringify(paragraphs[1]))
  ok(paragraphs[0].includes('agent v2'), '其它段落按 agent 的新稿改了')

  log('=== 8. 关闭重开：版本与正文仍在（数据在宿主） ===')
  click(q('[data-testid="space-close"]'))
  await sleep(400)
  click(q('[data-testid="view-space"]'))
  await sleep(600)
  click(q('[data-testid="space-tab-artifact"]'))
  await sleep(700)
  const reopened = S().artifactDocs.find((d) => d.id === id)
  ok(reopened?.currentVersion === 5, '重开后当前版本是 v5', String(reopened?.currentVersion))
  const reopenedBody = q('[data-testid="space-art-body"]')?.value ?? ''
  ok(reopenedBody.includes('第二段：不，我要这么写。'), '重开后正文从磁盘读回（用户改动还在）')

  log('=== 9. 结构化清单：勾选就是一次用户编辑（P06b） ===')
  const cl = await S().createArtifactDoc({
    title: '探针清单',
    kind: 'checklist',
    spaceId: space.id,
    text: '- [ ] 第一步\n- [ ] 第二步'
  })
  ok(!!cl && cl.kind === 'checklist', '新建清单类成果', cl?.id)
  if (cl) {
    await sleep(400)
    click(q(`[data-testid="space-art-item-${cl.id}"]`))
    await sleep(600)
    ok(!!q('[data-testid="space-art-checklist"]'), '清单渲染成勾选列表')
    const box0 = q('[data-testid="space-art-check-0"]')
    ok(!!box0, '第一项有复选框')
    const beforeToggle = S().artifactDocs.find((d) => d.id === cl.id)?.currentVersion ?? 0
    /* checkbox 必须用真 click()：dispatchEvent 不受信，不会切换 checked / 不触发 change */
    if (box0) box0.click()
    await sleep(800)
    const afterToggle = S().artifactDocs.find((d) => d.id === cl.id)
    const lastVer = afterToggle?.versions[afterToggle.versions.length - 1]
    ok((afterToggle?.currentVersion ?? 0) === beforeToggle + 1, '勾选开了一个新版本', `${beforeToggle}→${afterToggle?.currentVersion}`)
    ok((lastVer?.text ?? '').includes('- [x] 第一步'), '正文里那一项被勾上', JSON.stringify(lastVer?.text))
    ok(JSON.stringify(lastVer?.userEditedParagraphs ?? []) === '[0]', '勾选进用户保护集（agent 整篇重写不会抹掉）', JSON.stringify(lastVer?.userEditedParagraphs))

    const boxAgain = q('[data-testid="space-art-check-0"]')
    if (boxAgain) boxAgain.click()
    await sleep(800)
    const backDoc = S().artifactDocs.find((d) => d.id === cl.id)
    ok((backDoc?.versions[backDoc.versions.length - 1]?.text ?? '').includes('- [ ] 第一步'), '再点一次取消勾选')
    ok((await S().removeArtifactDoc(cl.id)) === true, '清理清单成果')
    await sleep(300)
  }

  log('=== 10. 来源引用可回到原文（P06b） ===')
  const lib = window.yan.library
  const cwd = String(S().settings?.cwd ?? '').replace(/[\/]+$/, '')
  let importedId = ''
  if (!lib) {
    log('  ⤺ 跳过：preload 里没有 library 桥')
  } else {
    const imported = await lib.import({
      kind: 'file',
      ref: `${cwd}/README.md`,
      title: 'README（成果来源）',
      owner: { kind: 'session', id: 'probe-artifact' }
    })
    if (!imported?.ok || !imported.sourceId) {
      log(`  ⤺ 跳过：导入 README.md 失败（${imported?.error ?? '未知'}）`)
    } else {
      importedId = imported.sourceId
      await S().refreshLibrary()
      await sleep(400)
      const added = await S().addArtifactSource(id, { sourceId: imported.sourceId, version: imported.version ?? 1 })
      ok(added === true, '给成果加一条来源引用')
      click(q(`[data-testid="space-art-item-${id}"]`))
      await sleep(500)
      const srcBtn = q('[data-testid="space-art-source-0"]')
      ok(!!srcBtn, '来源列表渲染出来')
      click(srcBtn)
      await sleep(900)
      const prev = q('[data-testid="space-art-source-text"]')
      ok(!!prev && (prev.textContent ?? '').length > 20, '预览显示原文正文（按引用时那一版打开）', JSON.stringify((prev?.textContent ?? '').slice(0, 40)))
      ok(!!q('[data-testid="space-art-source-close"]'), '预览可关闭')
      click(q('[data-testid="space-art-source-close"]'))
      await sleep(300)
      ok(!q('[data-testid="space-art-source-preview"]'), '关掉后预览消失')
    }
  }

  log('=== 11. 导出按钮（真实落盘要弹保存框，由人点；单测钉渲染） ===')
  ok(!!q('[data-testid="space-art-export"]'), '导出按钮在')
  ok(!!q('[data-testid="space-art-new-kind"]'), '新建时可以选类型（文档 / 清单）')

  log('=== 12. 用于学习：成果 → 学习材料（T06b-4） ===')
  const beforeCourses = S().courses.length
  /* 先给成果一段确定正文（前面步骤里它被改过好几轮） */
  await window.yan.artifactDoc.saveUserEdit(id, '光合作用把光能转成化学能。\n\n这是用来学习的成果正文。')
  await S().refreshArtifactDocs()
  await sleep(400)
  click(q(`[data-testid="space-art-item-${id}"]`))
  await sleep(500)
  ok(!!q('[data-testid="space-art-tolearn"]'), '成果页有「用于学习」按钮')
  click(q('[data-testid="space-art-tolearn"]'))
  await sleep(300)
  ok(!!q('[data-testid="space-art-tolearn-panel"]'), '展开目标输入')
  ok(q('[data-testid="space-art-tolearn-go"]')?.disabled === true, '没填目标时不能生成（不建一门没方向的课）')
  const goalEl = q('[data-testid="space-art-tolearn-goal"]')
  if (goalEl) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(goalEl, '看懂光合作用')
    goalEl.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await sleep(200)
  click(q('[data-testid="space-art-tolearn-go"]'))
  await sleep(2200)
  const course = S().courses.find((c) => c.title === '探针报告')
  ok(!!course, '生成了课程', course?.id)
  ok(S().courses.length === beforeCourses + 1, '只多了一门课')
  if (course) {
    ok(course.units.length > 0, '有学习单元（材料单元指回正文）')
    ok(course.units.every((u) => u.origin === 'material' && u.sources.length > 0), '单元都是带出处的材料单元')
    const listed = await window.yan.library.list({ spaceId: space.id })
    const fromArtifact = (listed?.sources ?? []).find((s) => String(s.title ?? '').startsWith('成果：'))
    ok(!!fromArtifact, '资料库里多了一份「成果：…」来源', fromArtifact?.id)
    ok(!!q('[data-testid="space-learn-panel"]'), '界面切到了学习页')
    await S().removeCourse(course.id)
  }

  log('=== 13. 来源变化提示 + 多来源对照（P13） ===')
  /* 步骤 12 的「用于学习」把界面切到了学习页 —— 先回成果页再继续。 */
  S().openSpaceView('artifact')
  await sleep(700)
  const srcA = await window.yan.library.import({
    kind: 'text',
    ref: 'probe://research-a',
    identity: 'text:probe-research-a',
    title: '材料 A',
    content: '这个说法成立。'
  })
  const srcB = await window.yan.library.import({
    kind: 'text',
    ref: 'probe://research-b',
    identity: 'text:probe-research-b',
    title: '材料 B',
    content: '这个说法不成立。'
  })
  ok(srcA?.ok === true && srcB?.ok === true, '导入两份对照材料', `${srcA?.sourceId}/${srcB?.sourceId}`)
  if (srcA?.ok && srcB?.ok) {
    const addedA = await S().addArtifactSource(id, { sourceId: srcA.sourceId, version: srcA.version ?? 1 })
    const addedB = await S().addArtifactSource(id, { sourceId: srcB.sourceId, version: srcB.version ?? 1 })
    ok(addedA === true && addedB === true, '把两份材料加为成果来源')
    await S().refreshArtifactDocs()
    await sleep(400)
    click(q(`[data-testid="space-art-item-${id}"]`))
    await sleep(600)
    ok(!!q('[data-testid="space-art-sources"]'), '成果页回显（sources 区在）')

    /* 同一 identity 换了内容 → 新版本（旧引用仍指着 v1） */
    const srcA2 = await window.yan.library.import({
      kind: 'text',
      ref: 'probe://research-a',
      identity: 'text:probe-research-a',
      title: '材料 A',
      content: '这个说法成立（改过一版）。'
    })
    ok(srcA2?.version === 2, '材料 A 出了 v2', String(srcA2?.version))
    await S().refreshArtifactSourceStatus(id)
    await sleep(600)
    const changed = q('[data-testid="space-art-source-changed"]')
    ok(!!changed && /新版本/.test(String(changed.textContent ?? '')), '成果页提示「来源已更新」', String(changed?.textContent ?? ''))
    const statusEls = [...document.querySelectorAll('[data-testid^="space-art-source-status-"]')]
    ok(statusEls.length === 1, '只有那条有新版本的来源标状态（没变的不报噪声）', String(statusEls.length))
    ok(/仍指着 v1/.test(String(statusEls[0]?.textContent ?? '')), '说清引用还指着旧版', String(statusEls[0]?.textContent ?? ''))

    /* 带立场的对照（模型经 yan research compare 提交的就是这个形状） */
    const cmp = await window.yan.research.compare({
      question: '这个说法成立吗？',
      refs: [
        { sourceId: srcA.sourceId, version: 1, stance: '支持' },
        { sourceId: srcB.sourceId, version: 1, stance: '反对' }
      ]
    })
    ok(cmp?.ok === true && cmp.comparison?.groups?.length === 2, '两组立场各自成组')
    ok(cmp?.comparison?.conflicts?.length === 1, '列出一条不一致（不合并结论）')
    ok(/引用原文/.test(String(cmp?.text ?? '')), '导出文本标出「引用原文」')

    /* 读不到的来源不进对照 */
    const skipped = await window.yan.research.compare({
      question: '读不到的那份',
      refs: [{ sourceId: 'lib_not_there', version: 1, stance: '支持' }]
    })
    ok(skipped?.ok === true && skipped.skipped?.length === 1, '读不到的来源列进 skipped')
    ok(skipped.comparison?.groups?.length === 0, '不把读不到的当有效证据排进对照')

    /* 界面上点「多来源对照」：没有立场标签 → 未标注、无冲突 */
    click(q('[data-testid="space-art-compare"]'))
    await sleep(1000)
    ok(!!q('[data-testid="space-art-compare-view"]'), '成果页显示对照视图')
    ok(!!q('[data-testid="space-art-compare-group-0"]'), '有一组（未标注立场）')
    ok(!q('[data-testid="space-art-compare-conflicts"]'), '未标注立场时不制造冲突')

    await window.yan.library.remove(srcA.sourceId)
    await window.yan.library.remove(srcB.sourceId)
  }

  log('=== 14. 删除成果（清理） ===')
  ok((await S().removeArtifactDoc(id)) === true, '删除成功')
  if (importedId) await window.yan.library.remove(importedId)
  await S().updateSpace(space.id, { archived: true })

  return out.join('\n')
})()
