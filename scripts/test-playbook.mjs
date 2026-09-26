/**
 * 办事模板（实施-25 P14）—— 契约 / 授权点 / 存储 / 服务。
 *
 * 四条最值得钉住的：
 *   · **写步骤必须写清范围**：没有范围就不许存、不许复用（这是「不静默动文件」的入口）；
 *   · **宿主不执行**：`plan` 只返回说明，没有任何写盘 / 发消息的副作用；
 *   · **范围组数与需要确认的步骤数必须对上**：少填一组不猜、不自动补；
 *   · **起步模板不落盘**：只有用户真的存 / 用过的才进 playbooks.json。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function step(over = {}) {
  return {
    title: over.title ?? '做一件事',
    effect: over.effect ?? 'read',
    ...(over.detail ? { detail: over.detail } : {}),
    ...(over.scope ? { scope: over.scope } : {})
  }
}

function input(over = {}) {
  return {
    kind: over.kind ?? 'files',
    title: over.title ?? '整理目录',
    goal: over.goal ?? '把散落的文件归好',
    steps: over.steps ?? [step({ title: '列目录' })],
    ...(over.io ? { io: over.io } : {}),
    ...(over.spaceId !== undefined ? { spaceId: over.spaceId } : {}),
    ...(over.origin ? { origin: over.origin } : {}),
    ...(over.source ? { source: over.source } : {})
  }
}

export function runPlaybookTests(ok, mod) {
  const {
    parsePlaybookSteps,
    parseStepLines,
    parsePlaybookIO,
    validatePlaybookInput,
    createPlaybook,
    applyPlaybookPatch,
    scopeSummary,
    needsConfirmation,
    confirmationPoints,
    confirmationText,
    playbookStepsText,
    playbookRunNote,
    effectNeedsConfirmation,
    stepEffectNote,
    isPlaceholderScope,
    stepScopeUnfilled,
    sanitizePlaybook,
    sanitizePlaybookDocument,
    upsertPlaybookIn,
    removePlaybookFrom,
    removeSpacePlaybooksFrom,
    playbooksForSpace,
    findPlaybook,
    withSeedPlaybooks,
    seedPlaybooks,
    emptyPlaybookDocument,
    PLAYBOOK_LIMITS
  } = mod

  /* ---- 步骤校验：写步骤必须有范围 ---- */
  {
    const parsed = parsePlaybookSteps([step(), step({ title: '重命名', effect: 'write', scope: ['<目录>'] })])
    ok(parsed.ok && parsed.steps.length === 2, '两步（一只读一写）能过', JSON.stringify(parsed))

    const noScope = parsePlaybookSteps([step({ title: '改文件', effect: 'write' })])
    ok(!noScope.ok && noScope.code === 'missing_scope', '会改东西但没写范围：直接拒掉', JSON.stringify(noScope))
    const externalNoScope = parsePlaybookSteps([step({ title: '发消息', effect: 'external' })])
    ok(!externalNoScope.ok && externalNoScope.code === 'missing_scope', '会对外发但没写范围：同样拒掉')
    const emptyScope = parsePlaybookSteps([step({ title: '改文件', effect: 'write', scope: ['  '] })])
    ok(!emptyScope.ok && emptyScope.code === 'missing_scope', '范围全是空白也算没写')

    ok(!parsePlaybookSteps([]).ok, '零步不是模板')
    const badEffect = parsePlaybookSteps([step({ effect: 'burn' })])
    ok(!badEffect.ok && badEffect.code === 'bad_effect', '认不出的影响报 bad_effect')
    ok(!parsePlaybookSteps([{ title: '  ', effect: 'read' }]).ok, '空标题的一步：拒掉')

    const tooMany = parsePlaybookSteps(Array.from({ length: PLAYBOOK_LIMITS.maxSteps + 1 }, () => step()))
    ok(!tooMany.ok && tooMany.code === 'too_many_steps', '超过步数上限：如实报错，不静默截断')

    /* 去重：同一范围写两遍只算一处 */
    const dedup = parsePlaybookSteps([step({ effect: 'write', scope: ['a.md', 'a.md', 'b.md'] })])
    ok(dedup.ok && dedup.steps[0].scope.length === 2, '范围去重')

    ok(effectNeedsConfirmation('write') && effectNeedsConfirmation('external') && !effectNeedsConfirmation('read'), '只有写 / 外发需要确认')
    ok(/不改任何东西/.test(stepEffectNote('read')) && /范围/.test(stepEffectNote('write')), '影响说明写清了含义')

    /* 占位写法不算「已填」（起步模板靠它挡住「直接就发」） */
    ok(isPlaceholderScope('<要整理的目录>') && !isPlaceholderScope('docs/'), '尖括号包住的是占位')
    ok(stepScopeUnfilled(step({ effect: 'write', scope: ['<要整理的目录>'] })), '全是占位 → 还没填')
    ok(stepScopeUnfilled(step({ effect: 'write', scope: ['docs/', '<别的>'] })), '掺了占位就算没填完（宁可多看一眼）')
    ok(!stepScopeUnfilled(step({ effect: 'write', scope: ['docs/'] })), '给了真范围 → 已填')
    ok(stepScopeUnfilled(step({ effect: 'write' })), '没范围 → 没填')
  }

  /* ---- 文本步骤（界面上的「自己写一个」）---- */
  {
    const parsed = parseStepLines('列目录\n重命名 | 会改 | docs、tmp\n发出去 | 对外发 | 邮件')
    ok(parsed.ok && parsed.steps.length === 3, '三行文本 → 三步', JSON.stringify(parsed))
    ok(parsed.steps[0].effect === 'read', '不写影响就是只读（保守默认）')
    ok(parsed.steps[1].scope.join(',') === 'docs,tmp', '顿号分隔的范围')

    const missing = parseStepLines('重命名 | 会改')
    ok(!missing.ok && missing.code === 'missing_scope', '文本里只写「会改」不给范围：同样拒掉')
    ok(!parseStepLines('   ').ok, '空文本：拒掉')
    const badWord = parseStepLines('做什么 | 随便写')
    ok(!badWord.ok && badWord.code === 'bad_effect', '认不出的影响词给出可读错误', badWord.message)
    ok(parseStepLines('做什么 | write | a.md').steps[0].effect === 'write', '英文影响名也认')
  }

  /* ---- 输入校验 ---- */
  {
    ok(validatePlaybookInput(input()).ok, '最小合法输入能过')
    const noTitle = validatePlaybookInput({ ...input(), title: '  ' })
    ok(!noTitle.ok && noTitle.code === 'bad_title', '没名字：拒掉')
    const noGoal = validatePlaybookInput({ ...input(), goal: '' })
    ok(!noGoal.ok && noGoal.code === 'bad_goal', '没目标：拒掉')
    const badKind = validatePlaybookInput({ ...input(), kind: 'magic' })
    ok(!badKind.ok && badKind.code === 'bad_kind', '认不出的 kind：拒掉')

    const fromTaskNoSource = validatePlaybookInput({ ...input(), origin: 'from-task' })
    ok(!fromTaskNoSource.ok && fromTaskNoSource.code === 'missing_source', '说「从任务存下来」却没给来源：拒掉')
    const fromTask = validatePlaybookInput({
      ...input(),
      origin: 'from-task',
      source: { kind: 'session', id: 's.jsonl', round: 3 }
    })
    ok(fromTask.ok && fromTask.value.source.id === 's.jsonl' && fromTask.value.source.round === 3, '带来源的 from-task 能过')

    const badIO = validatePlaybookInput({ ...input(), io: { inputs: 'a.md' } })
    ok(!badIO.ok && badIO.code === 'bad_io', 'io.inputs 不是数组：拒掉')
    const goodIO = parsePlaybookIO({ inputs: ['目录', '目录'], outputs: ['清单'] })
    ok(goodIO.ok && goodIO.io.inputs.length === 1, 'io 去重')

    const tooLong = validatePlaybookInput({ ...input(), title: 'x'.repeat(PLAYBOOK_LIMITS.maxTitle + 1) })
    ok(!tooLong.ok && tooLong.code === 'title_too_long', '名字超长：如实报错')
  }

  /* ---- 授权点与确认文案（T14-3）---- */
  {
    const readOnly = createPlaybook(
      validatePlaybookInput(input({ steps: [step({ title: '读原文' }), step({ title: '摘录' })] })).value,
      { id: 'pb_1', now: 1 }
    )
    ok(!needsConfirmation(readOnly.steps) && confirmationPoints(readOnly.steps).length === 0, '全只读：不需要确认')
    ok(/都是只读/.test(confirmationText(readOnly)), '只读模板的确认文案说清「不改任何东西」', confirmationText(readOnly))

    const risky = createPlaybook(
      validatePlaybookInput(
        input({
          steps: [
            step({ title: '读目录' }),
            step({ title: '重命名', effect: 'write', scope: ['docs/a.md', 'docs/b.md'] }),
            step({ title: '发邮件', effect: 'external', scope: ['abc@example.com'] })
          ]
        })
      ).value,
      { id: 'pb_2', now: 1 }
    )
    const summary = scopeSummary(risky.steps)
    ok(summary.read === 1 && summary.write === 1 && summary.external === 1, '读取 / 写入 / 外发分别计数', JSON.stringify(summary))
    ok(summary.targets.join(',') === 'docs/a.md,docs/b.md,abc@example.com', '范围按首次出现顺序汇总')
    ok(confirmationPoints(risky.steps).length === 2, '两个需要确认的步骤')

    const text = confirmationText(risky)
    ok(/会改东西 1 步/.test(text) && /会对外发出 1 步/.test(text), '文案说清「会改」「会发」各几步', text)
    ok(/docs\/a\.md/.test(text), '文案列出具体范围')
    ok(/确认之前不会动任何东西/.test(text), '文案明确「确认之前不动」')
    ok(!/已获授权|已经允许/.test(text), '文案**不**替用户宣布已授权', text)

    const stepsText = playbookStepsText(risky)
    ok(/\[会改东西\]（范围：docs\/a\.md、docs\/b\.md）/.test(stepsText), '交给模型的说明带影响与范围', stepsText)
    ok(/不要把动作面扩大/.test(stepsText), '说明里写明边界')
    ok(/只读，不要修改任何文件/.test(playbookStepsText(readOnly)), '只读模板的说明写明只读')

    ok(playbookRunNote(readOnly) === '还没用过', '没跑过时的说明')
    const ran = { ...readOnly, runs: 3, lastRunAt: Date.parse('2026-09-20T00:00:00Z') }
    ok(/用过 3 次/.test(playbookRunNote(ran)), '跑过之后只报次数与时间，不承诺效果')
  }

  /* ---- 修改与容错读盘 ---- */
  {
    const pb = createPlaybook(validatePlaybookInput(input()).value, { id: 'pb_3', now: 100 })
    const patched = applyPlaybookPatch(pb, { title: '改个名' }, 200)
    ok(patched.ok && patched.playbook.title === '改个名' && patched.playbook.updatedAt === 200, '改名会推后 updatedAt')
    ok(patched.playbook.createdAt === 100 && patched.playbook.runs === 0, '改名不动创建时间与计数')
    const badPatch = applyPlaybookPatch(pb, { steps: [step({ effect: 'write' })] }, 200)
    ok(!badPatch.ok && badPatch.code === 'missing_scope', '改步骤时同样挡住没范围的写步骤')

    /* 读盘：写步骤没范围的那份整份丢掉 —— 留着比丢掉危险 */
    const doc = sanitizePlaybookDocument({
      playbooks: [
        { ...pb, steps: [{ title: '改文件', effect: 'write' }] },
        { ...pb, id: 'pb_keep' },
        { id: 'pb_broken' },
        null
      ]
    })
    ok(doc.playbooks.length === 1 && doc.playbooks[0].id === 'pb_keep', '读盘时丢掉坏模板（含无范围的写步骤）', JSON.stringify(doc.playbooks.map((p) => p.id)))
    ok(sanitizePlaybookDocument('nope').playbooks.length === 0, '整份文档坏掉：给空文档而不是抛错')
    ok(sanitizePlaybook({ ...pb, kind: 'weird' }).kind === 'custom', '认不出的 kind 退回 custom')
    ok(sanitizePlaybook({ ...pb, runs: -1 }).runs === 0, '负数计数退回 0')

    /* 集合操作 */
    let d = emptyPlaybookDocument()
    d = upsertPlaybookIn(d, pb)
    d = upsertPlaybookIn(d, { ...pb, title: '第二版' })
    ok(d.playbooks.length === 1 && d.playbooks[0].title === '第二版', '同 id 覆盖而不是追加')
    d = upsertPlaybookIn(d, { ...pb, id: 'pb_4', spaceId: 'sp2', title: '别的空间' })
    ok(d.playbooks.length === 2 && findPlaybook(d, 'pb_4').spaceId === 'sp2', '不同 id 追加')
    ok(playbooksForSpace(d, 'sp2').length === 2, '本空间能看到自己的 + 不挑空间的')
    ok(playbooksForSpace(d, 'sp1').length === 1, '别的空间看不到它（但看得到不挑空间的）')
    ok(playbooksForSpace(d, undefined).length === 2, '不挑空间时全给')
    const removed = removeSpacePlaybooksFrom(d, 'sp2')
    ok(removed.removed === 1 && removed.doc.playbooks.length === 1, '删空间带走属于它的模板')
    ok(removePlaybookFrom(d, 'pb_3').playbooks.length === 1, '按 id 删')

    /* 起步模板 */
    const seeds = seedPlaybooks(1000)
    ok(seeds.length === 3, '三个起步模板（整理文件 / 汇总材料 / 改写内容）')
    ok(seeds.every((p) => p.seeded === true), '起步模板都带 seeded 标记')
    ok(seeds.every((p) => needsConfirmation(p.steps)), '起步模板都含写步骤（所以都要确认）')
    ok(
      seeds.every((p) => confirmationPoints(p.steps).every((s) => s.scope && s.scope.length > 0)),
      '起步模板的写步骤都写了范围（用占位写法）'
    )
    const merged = withSeedPlaybooks({ version: 1, playbooks: [{ ...seeds[0], title: '我改过的' }] }, 1000)
    ok(merged.length === 3, '合起来仍是三份（同 id 不重复）')
    ok(merged.find((p) => p.id === seeds[0].id).title === '我改过的', '同 id 以落盘的那份为准')
    ok(withSeedPlaybooks(emptyPlaybookDocument(), 1000).length === 3, '没落盘任何模板时列表里也有三个起步模板')
  }
}

export function runPlaybookServiceTests(ok, mod, fs) {
  const { PlaybookService, PlaybookStore } = mod
  return (async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'yan-playbook-svc-'))
    try {
      let tick = 1000
      let seq = 0
      const store = new PlaybookStore({ root: dir })
      const service = new PlaybookService({ store, now: () => (tick += 1000), idFactory: () => `pb_generated${++seq}` })

      /* 起步模板在列表里，但**没有落盘** */
      const initial = await service.list()
      ok(initial.length === 3 && initial.every((p) => p.seeded), '初始列表 = 三个起步模板')
      ok(store.snapshot().playbooks.length === 0, '起步模板不落盘（用户数据目录里不凭空多出三条）')

      /* 存一份自己的 */
      const saved = await service.save(
        input({
          title: '我的整理流程',
          steps: [step({ title: '列目录' }), step({ title: '重命名', effect: 'write', scope: ['<目录>'] })]
        })
      )
      ok(saved.ok && saved.playbook.id === 'pb_generated1', '存下来拿到 id', JSON.stringify(saved))
      ok(store.snapshot().playbooks.length === 1, '存了才落盘')

      /* 复用前：给的范围组数必须对上 */
      const tooFew = await service.plan(saved.playbook.id, { scopes: [] })
      ok(!tooFew.ok && tooFew.code === 'bad_scope', '少给范围组：报错而不是猜', JSON.stringify(tooFew))
      const planned = await service.plan(saved.playbook.id, { scopes: [['docs']] })
      ok(planned.ok && planned.needsConfirmation && planned.points.length === 1, '按真实范围做复用前的说明')
      ok(planned.unansweredScope === 0, '范围填完了')
      ok(/docs/.test(planned.confirmationText), '确认文案用**用户给的那份范围**', planned.confirmationText)
      ok(/按这个模板做/.test(planned.text), '返回一段可直接发出去的说明')

      /* 不给范围时：起步模板的占位仍在，如实报「还没填」 */
      const bare = await service.plan('pb_seed_files')
      ok(bare.ok && bare.unansweredScope > 0, '起步模板还没填范围时如实上报', String(bare.ok ? bare.unansweredScope : bare.error))

      const missing = await service.plan('pb_nope')
      ok(!missing.ok && missing.code === 'not_found', '找不到模板给出可读错误')

      /* 改与删 */
      const renamed = await service.update(saved.playbook.id, { title: '改名了' })
      ok(renamed.ok && renamed.playbook.title === '改名了' && renamed.playbook.updatedAt > saved.playbook.updatedAt, '改名成功且推后 updatedAt')
      const badUpdate = await service.update(saved.playbook.id, { steps: [step({ effect: 'write' })] })
      ok(!badUpdate.ok && badUpdate.code === 'missing_scope', '改步骤时挡住没范围的写步骤')
      const removedMissing = await service.remove('pb_nope')
      ok(removedMissing.ok === false, '删不存在的模板：如实失败')

      /* 起步模板用过一次 → 落盘、带上计数、不再是「内置」 */
      const seedId = 'pb_seed_files'
      const ran = await service.recordRun(seedId)
      ok(ran.ok && ran.playbook.runs === 1 && ran.playbook.lastRunAt > 0, '记一次「开始用」')
      ok(ran.playbook.seeded === undefined, '用过之后就不再是「内置起步模板」（用户可以删它了）')
      ok(store.snapshot().playbooks.some((p) => p.id === seedId), '用过的起步模板落盘（计数得留住）')

      /* 空间过滤 + 删空间 */
      const inSpace = await service.save(input({ title: '空间内的模板', spaceId: 'sp_a' }))
      ok((await service.list('sp_a')).some((p) => p.id === inSpace.playbook.id), '空间内能看到自己的模板')
      ok((await service.list('sp_b')).every((p) => p.id !== inSpace.playbook.id), '别的空间看不到它')
      ok((await service.list('sp_a')).every((p) => !p.spaceId || p.spaceId === 'sp_a'), '不挑空间的模板在任何空间都看得到')
      const cleared = await service.removeSpace('sp_a')
      ok(cleared === 1, '删空间带走一份模板')

      /* 重开一次：落盘的还在，计数还在 */
      const reopened = new PlaybookService({ store: new PlaybookStore({ root: dir }), now: () => 999999 })
      const after = await reopened.list()
      ok(after.some((p) => p.title === '改名了'), '重开后落盘的模板还在')
      ok(after.find((p) => p.id === seedId).runs === 1, '重开后计数还在')
      ok(!after.some((p) => p.id === inSpace.playbook.id), '被删空间的模板不会回来')

      /* id 查重：随机撞车不覆盖已有模板 */
      const dupe = new PlaybookService({ store, now: () => 1234567, idFactory: () => 'pb_generated1' })
      const secondSave = await dupe.save(input({ title: '同 id 撞车', spaceId: null }))
      ok(secondSave.ok && secondSave.playbook.id !== 'pb_generated1', '撞车时换一个新 id', secondSave.ok ? secondSave.playbook.id : secondSave.error)
      ok(store.snapshot().playbooks.find((p) => p.id === 'pb_generated1').title === '改名了', '已有的那份没被静默覆盖')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })()
}
