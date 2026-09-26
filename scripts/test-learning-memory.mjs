/**
 * 学习记忆（实施-25 P11）—— 概念进度两条轴 / 笔记 / 存储 / 服务。
 *
 * 三条最值得钉住的（R7）：
 *   · **两轴不互斥**：「曾独立完成」与「建议复习」可以同时为真；
 *   · **升级要证据，降级不被单次噪声驱动**：两次不同练习的独立成功才稳定进独立完成，
 *     一次失败**不降级**、只加复习建议；
 *   · **用户自评与系统观察并存**：自评写另一个字段，不改 `level` / `review`。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 造一条证据（默认：提示下完成）。 */
function ev(over = {}) {
  return {
    at: over.at ?? 1000,
    exerciseId: over.exerciseId ?? 'ex_1',
    attemptId: over.attemptId ?? `at_${over.at ?? 1000}`,
    correct: over.correct === undefined ? true : over.correct,
    hintLevelSeen: over.hintLevelSeen ?? 'none',
    lookedAtSolution: over.lookedAtSolution ?? false,
    transfer: over.transfer ?? false,
    independent: over.independent ?? true
  }
}

export function runLearningMemoryTests(ok, mod) {
  const {
    summarizeProgress,
    applyProgress,
    evidenceFromAttempt,
    strongerLevel,
    validateNoteInput,
    createNote,
    updateNote,
    sanitizeLearningMemoryDocument,
    notesForCourse,
    progressExplanation
  } = mod

  /* ---- 观察层级：升级要证据 ---- */
  {
    const none = summarizeProgress({ evidence: [] })
    ok(none.level === 'unseen' && none.review === false, '没证据就是未接触')

    const assisted = summarizeProgress({ evidence: [ev({ hintLevelSeen: 'direction', independent: false })] })
    ok(assisted.level === 'with-hint', '一次提示下完成 → 提示层')

    const oneIndependent = summarizeProgress({ evidence: [ev()] })
    ok(oneIndependent.level === 'with-hint', '一次独立成功仍不算稳定独立（未满两次）')

    const twoIndependent = summarizeProgress({
      evidence: [ev({ exerciseId: 'ex_1', at: 1000 }), ev({ exerciseId: 'ex_2', at: 2000 })]
    })
    ok(twoIndependent.level === 'independent', '两次**不同练习**的独立成功 → 独立完成')

    /* 同一道题做两遍不算两次不同练习 */
    const sameTwice = summarizeProgress({
      evidence: [ev({ exerciseId: 'ex_1', at: 1000 }), ev({ exerciseId: 'ex_1', at: 2000 })]
    })
    ok(sameTwice.level === 'with-hint', '同一道题连做两次不算「两次不同练习」')

    const transfer = summarizeProgress({
      evidence: [ev({ exerciseId: 'ex_1', at: 1000 }), ev({ exerciseId: 'ex_3', at: 3000, transfer: true })]
    })
    ok(transfer.level === 'transfer', '新情境（应用题）独立成功 → 应用到新情境')

    const openOnly = summarizeProgress({ evidence: [ev({ correct: null, independent: false })] })
    ok(openOnly.level === 'unseen', '开放题（无客观判定）不作为能力证据')
  }

  /* ---- 降级不被单次噪声驱动 + 两轴同时成立 ---- */
  {
    const existing = {
      conceptId: 'c1',
      courseId: 'co1',
      level: 'independent',
      review: false,
      evidence: [],
      updatedAt: 0
    }
    const afterFail = summarizeProgress({
      evidence: [ev({ correct: false, independent: false, at: 5000 })],
      existing
    })
    ok(afterFail.level === 'independent', '一次失败不降级')
    ok(afterFail.review === true, '一次失败只加「建议复习」')

    const both = applyProgress(
      'c1',
      'co1',
      [ev({ exerciseId: 'ex_1', at: 1000 }), ev({ exerciseId: 'ex_2', at: 2000 }), ev({ correct: false, independent: false, at: 3000 })],
      existing,
      4000
    )
    ok(both.level === 'independent' && both.review === true, '两轴可以同时成立：独立完成 + 建议复习')

    /* 连续两次独立成功且历史上没有失败 → 收掉复习建议 */
    const cleared = summarizeProgress({
      evidence: [ev({ exerciseId: 'ex_1', at: 1000 }), ev({ exerciseId: 'ex_2', at: 2000 })],
      existing: { ...existing, review: true }
    })
    ok(cleared.review === false, '连续两次独立成功（无失败史）→ 收掉复习建议')
  }

  /* ---- 提示下完成会带出复习建议 ---- */
  {
    const hinted = summarizeProgress({ evidence: [ev({ hintLevelSeen: 'concept', independent: false })] })
    ok(hinted.review === true, '用了提示：建议复习')
    const peaked = summarizeProgress({ evidence: [ev({ lookedAtSolution: true, independent: false })] })
    ok(peaked.review === true, '看过完整解释：建议复习')
  }

  /* ---- 层级单调 + 证据换算 ---- */
  {
    ok(strongerLevel('transfer', 'unseen') === 'transfer', '取更强的层级')
    ok(strongerLevel('with-hint', 'independent') === 'independent', '层级比较按强弱')

    const exercise = { id: 'ex_9', kind: 'apply' }
    const attempt = { id: 'a1', at: 1, correct: true, hintLevelSeen: 'none', lookedAtSolution: false }
    const evidence = evidenceFromAttempt(exercise, attempt)
    ok(evidence.independent === true && evidence.transfer === true, '应用题独立成功：independent + transfer')
    const assistedEvidence = evidenceFromAttempt(exercise, { ...attempt, hintLevelSeen: 'direction' })
    /* `transfer` 是**题目的性质**（是不是应用题）；它只在这也是独立成功时才被当成转移证据。 */
    ok(
      assistedEvidence.independent === false && assistedEvidence.transfer === true,
      '用了提示：不算独立（虽然题目仍是应用题）'
    )
  }

  /* ---- 自评与系统观察并存 ---- */
  {
    const existing = {
      conceptId: 'c1',
      courseId: 'co1',
      level: 'independent',
      review: true,
      evidence: [ev()],
      selfAssessment: { kind: 'got-it', at: 900 },
      updatedAt: 900
    }
    const next = applyProgress('c1', 'co1', [ev({ at: 1200 })], existing, 1300)
    ok(next.selfAssessment?.kind === 'got-it', '重算进度时自评被保留')
    ok(next.level === 'independent' && next.review === true, '系统观察照旧（自评没有覆盖它）')
    ok(progressExplanation(next).includes('建议复习'), '解释性文案里带上第二条轴')
  }

  /* ---- 笔记纯逻辑 ---- */
  {
    const bad = validateNoteInput({ courseId: 'co1', body: '   ' })
    ok(bad.ok === false, '空笔记被拒')
    const good = validateNoteInput({ courseId: 'co1', body: '这一段讲了光合作用。', title: '第二段', kind: 'summary' })
    ok(good.ok === true && good.value.kind === 'summary', '笔记校验通过并保留类型')

    const note = createNote(good.value, 100, 'nt_1')
    const edited = updateNote(note, { body: '改过了' }, 200)
    ok(edited.ok === true && edited.note.body === '改过了' && edited.note.updatedAt === 200, '笔记可改且更新时间')
    ok(updateNote(note, { body: '' }, 300).ok === false, '不能把正文改成空')
    ok(updateNote(note, { kind: 'nope' }, 300).ok === false, '未知类型被拒')

    const doc = sanitizeLearningMemoryDocument({
      version: 1,
      notes: [
        { id: 'nt_1', courseId: 'co1', body: 'a', kind: 'note' },
        { id: 'nt_1', courseId: 'co1', body: '重复', kind: 'note' },
        { id: 'nt_bad', courseId: 'co1', body: '' }
      ],
      progress: [
        { conceptId: 'c1', courseId: 'co1', level: 'independent', review: true, evidence: [] },
        { conceptId: 'c1', courseId: 'co1', level: 'unseen', review: false, evidence: [] }
      ]
    })
    ok(doc.notes.length === 1, '坏笔记与重复 id 被丢掉')
    ok(doc.progress.length === 1, '同一课程同一概念只留一条')
    ok(notesForCourse(doc.notes, 'co1').length === 1 && notesForCourse(doc.notes, 'co2').length === 0, '按课程筛笔记')
  }
}

export function runLearningMemoryStoreTests(ok, mod, fs) {
  const { LearningMemoryStore } = mod
  return (async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'yan-mem-store-'))
    try {
      const store = new LearningMemoryStore({ root: dir })
      await store.load()
      await store.saveNote({ id: 'nt_1', courseId: 'co1', conceptIds: [], kind: 'note', body: '记一笔', sources: [], createdAt: 1, updatedAt: 1 })
      await store.saveProgress({ conceptId: 'c1', courseId: 'co1', level: 'with-hint', review: true, evidence: [], updatedAt: 2 })

      const reopened = new LearningMemoryStore({ root: dir })
      await reopened.load()
      ok(reopened.findNote('nt_1') !== null, '笔记读回来了')
      ok(reopened.findProgress('co1', 'c1')?.review === true, '概念进度读回来了（第二条轴也在）')

      /* 同一课程同一概念只留一条 */
      await reopened.saveProgress({ conceptId: 'c1', courseId: 'co1', level: 'independent', review: false, evidence: [], updatedAt: 3 })
      ok(reopened.progress('co1').length === 1, '再次保存同一概念是替换而不是追加')
      ok(reopened.findProgress('co1', 'c1')?.level === 'independent', '替换后的层级是新的')

      await reopened.removeCourse('co1')
      ok(reopened.notes().length === 0 && reopened.progress().length === 0, '删课程带走笔记与进度')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })()
}

export function runLearningMemoryServiceTests(ok, mod, fs) {
  const { LearningService, LearningMemoryStore } = mod
  return (async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'yan-mem-svc-'))
    try {
      let tick = 1000
      const course = {
        id: 'co1',
        title: '光合作用',
        goal: '讲清楚',
        units: [],
        concepts: [{ id: 'c1', name: '光反应' }]
      }
      const exercises = [
        { id: 'ex_1', courseId: 'co1', unitId: 'u1', conceptIds: ['c1'], kind: 'explain' },
        { id: 'ex_2', courseId: 'co1', unitId: 'u1', conceptIds: ['c1'], kind: 'cloze' },
        { id: 'ex_3', courseId: 'co1', unitId: 'u1', conceptIds: ['c1'], kind: 'apply' }
      ]
      let attempts = []
      const service = new LearningService({
        store: undefined,
        memoryStore: new LearningMemoryStore({ root: dir }),
        courses: { find: (id) => (id === 'co1' ? course : null) },
        attempts: async () => ({ exercises, attempts }),
        now: () => (tick += 1),
        random: () => 0.5
      })

      /* 笔记：存 / 改 / 删 */
      const saved = await service.saveNote({ courseId: 'co1', body: '第一遍没看懂。' })
      ok(saved.ok === true, '存笔记成功')
      const noteId = saved.note.id
      ok((await service.listNotes('co1')).length === 1, '列笔记')
      const edited = await service.updateNote(noteId, { body: '再看一遍懂了。' })
      ok(edited.ok === true && edited.note.body === '再看一遍懂了。', '改笔记')
      ok(await service.removeNote(noteId), '删笔记')
      ok((await service.listNotes('co1')).length === 0, '删完就没了')
      const missingCourse = await service.saveNote({ courseId: 'nope', body: 'x' })
      ok(missingCourse.ok === false, '课程不存在时不落笔记')

      /* 作答 → 进度：两次不同练习的独立成功才进「独立完成」 */
      attempts = [
        { id: 'a1', exerciseId: 'ex_1', courseId: 'co1', unitId: 'u1', raw: 'x', correct: true, hintLevelSeen: 'none', lookedAtSolution: false, at: 100 }
      ]
      await service.recordAttempt(attempts[0], exercises[0])
      let progress = await service.listProgress('co1')
      ok(progress.length === 1 && progress[0].level === 'with-hint', '一次独立成功：先停在提示层')
      ok(progress[0].review === false, '独立成功不带复习建议')

      attempts = [...attempts, { id: 'a2', exerciseId: 'ex_2', courseId: 'co1', unitId: 'u1', raw: 'y', correct: true, hintLevelSeen: 'none', lookedAtSolution: false, at: 200 }]
      await service.recordAttempt(attempts[1], exercises[1])
      progress = await service.listProgress('co1')
      ok(progress[0].level === 'independent', '两次不同练习的独立成功 → 独立完成')

      /* 自评：写另一个字段，不动系统观察 */
      const assessed = await service.setSelfAssessment({ courseId: 'co1', conceptId: 'c1', kind: 'got-it' })
      ok(assessed.ok === true && assessed.progress.level === 'independent', '自评后系统观察不变')
      ok(assessed.progress.selfAssessment?.kind === 'got-it', '自评写进 selfAssessment')

      /* 失败 → 只加复习建议，不降级 */
      attempts = [...attempts, { id: 'a3', exerciseId: 'ex_3', courseId: 'co1', unitId: 'u1', raw: 'z', correct: false, hintLevelSeen: 'none', lookedAtSolution: false, at: 300 }]
      await service.recordAttempt(attempts[2], exercises[2])
      progress = await service.listProgress('co1')
      ok(progress[0].level === 'independent', '一次失败不降级')
      ok(progress[0].review === true, '一次失败加复习建议')
      ok(progress[0].selfAssessment?.kind === 'got-it', '两轴与自评三者并存')

      /* 重新算：清掉观察记录 */
      ok(await service.resetProgress('co1', 'c1'), '清掉概念观察')
      ok((await service.listProgress('co1')).length === 0, '清完就没了')

      /* 删课程带走记忆 */
      await service.saveNote({ courseId: 'co1', body: 'x' })
      const removed = await service.removeMemory('co1')
      ok(removed.notes === 1, '删课程带走笔记')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })()
}
