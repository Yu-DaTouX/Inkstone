/**
 * 练习与反馈（实施-25 P10）—— 契约 / 判分 / 提示层级 / 存储 / 服务。
 *
 * 三条最值得钉住的：
 *   · **答案不随题目走**：`exerciseView` 里没有答案，`revealSolution` 才会给；
 *   · **「看过解释」不算独立完成**：`isIndependent` 要求没要提示、没看解释；
 *   · **判分与帮助层级由服务记**：界面自报「我没看提示」不会影响记录。
 */

import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeCourse = () => ({
  id: 'co_1',
  title: '英语精读',
  goal: '读完并复述',
  units: [
    {
      id: 'u_1',
      title: '第一段',
      origin: 'material',
      estimateMinutes: 5,
      concepts: [],
      sources: [{ sourceId: 'lib_1', version: 1, locator: { start: 0, end: 120 } }]
    },
    { id: 'u_2', title: '补充', origin: 'model', note: '补充说明', estimateMinutes: 5, concepts: [], sources: [] }
  ]
})

const SAMPLE_TEXT = [
  '光合作用是植物把光能变成化学能的过程。',
  '',
  '叶绿体里的叶绿素负责吸收光，水被分解并放出氧气。',
  '',
  '生成的糖分被植物用来生长。'
].join('\n')

export function runExerciseTests(ok, mod) {
  const {
    gradeResponse,
    normalizeAnswer,
    exerciseView,
    revealHints,
    highestHint,
    isIndependent,
    validateExerciseInput,
    createExercise,
    draftExercisesFromText,
    buildFeedback,
    sanitizeExerciseDocument,
    sanitizeExercise,
    dedupeHints,
    exerciseNeedsVision,
    MAX_EXERCISE_IMAGES
  } = mod

  /* ---- 题目里的图（实施-25 P19） ---- */
  {
    const base = { courseId: 'co_1', unitId: 'u_1', kind: 'explain', prompt: '看这张图回答。' }
    const withImage = validateExerciseInput({ ...base, images: [{ sourceId: 'lib_img', version: 2, caption: '第 3 页的图' }] })
    ok(withImage.ok && withImage.value.images.length === 1, '题干可以带资料库图片引用')
    ok(withImage.value.images[0].caption === '第 3 页的图', '图的说明保留')

    const dirty = validateExerciseInput({
      ...base,
      images: [
        { sourceId: '', version: 1 },
        { sourceId: 'lib_a', version: 0 },
        { sourceId: 'lib_b', version: 1.5 },
        { sourceId: 'lib_c', version: 3 },
        'nope',
        null
      ]
    })
    ok(dirty.ok && dirty.value.images.length === 1 && dirty.value.images[0].sourceId === 'lib_c', '坏引用丢掉（只留合法的）', JSON.stringify(dirty.ok ? dirty.value.images : dirty.reason))

    const many = validateExerciseInput({ ...base, images: Array.from({ length: MAX_EXERCISE_IMAGES + 3 }, (_, i) => ({ sourceId: 'lib_' + i, version: 1 })) })
    ok(many.value.images.length === MAX_EXERCISE_IMAGES, '一道题最多带几张图（超出不报错、上限截断）')

    const created = createExercise({ ...base, images: [{ sourceId: 'lib_img', version: 2 }] }, 1000, () => 'ex_img')
    ok(created.ok && created.exercise.images.length === 1, '新建的题带上图')
    ok(exerciseNeedsVision(created.exercise) && !exerciseNeedsVision({ images: [] }), '「这道题要不要看图」的判据')

    /* 题面视图带出图，但仍然**不含答案与解释** */
    const view = exerciseView(created.exercise)
    ok(view.images && view.images.length === 1, '题面视图带出图片引用')
    ok(!('answer' in view) && !('solution' in view), '题面视图仍然不含答案与解释（P10 的硬规则不因加图而破）')

    /* 读盘往返 */
    const doc = sanitizeExerciseDocument({
      exercises: [{ ...created.exercise, images: [{ sourceId: 'lib_img', version: 2 }, { sourceId: '', version: 1 }] }],
      attempts: []
    })
    ok(doc.exercises.length === 1 && doc.exercises[0].images.length === 1, '读盘时把合法图片引用带回、坏引用丢掉')

    const stripped = sanitizeExercise({ ...created.exercise, images: [{ sourceId: '', version: 9 }] })
    ok(!!stripped && stripped.images === undefined, '整题只有坏图时：题还在，图没有（不因此丢掉整道题）')
  }

  /* ---- 归一化与判分 ---- */
  {
    ok(normalizeAnswer('  Hello，World! ') === 'helloworld', '归一化去掉空白与中英标点、忽略大小写')

    const choice = {
      kind: 'choice',
      answer: { kind: 'choice', optionId: 'b' },
      options: [
        { id: 'a', text: '甲' },
        { id: 'b', text: '乙' }
      ]
    }
    ok(gradeResponse(choice, { kind: 'choice', optionId: 'b' }) === true, '选择题：选对')
    ok(gradeResponse(choice, { kind: 'choice', optionId: 'a' }) === false, '选择题：选错')

    const cloze = { kind: 'cloze', answer: { kind: 'cloze', blanks: ['叶绿素', '氧气'] } }
    ok(gradeResponse(cloze, { kind: 'cloze', blanks: ['叶绿素', '氧气'] }) === true, '填空题：全对')
    ok(gradeResponse(cloze, { kind: 'cloze', blanks: ['叶绿素', '二氧化碳'] }) === false, '填空题：有一空不对就不算对')
    ok(gradeResponse(cloze, { kind: 'cloze', blanks: ['叶绿素'] }) === false, '填空题：空数不符判错')

    const match = {
      kind: 'match',
      answer: {
        kind: 'match',
        pairs: [
          { left: '水', right: '被分解' },
          { left: '光', right: '被吸收' }
        ]
      }
    }
    ok(
      gradeResponse(match, {
        kind: 'match',
        pairs: [
          { left: '光', right: '被吸收' },
          { left: '水', right: '被分解' }
        ]
      }) === true,
      '配对题：顺序无关'
    )
    ok(gradeResponse(match, { kind: 'match', pairs: [{ left: '水', right: '被吸收' }] }) === false, '配对题：配错判错')

    const derive = { kind: 'derive', answer: { kind: 'text', accepted: ['2', '二'] } }
    ok(gradeResponse(derive, { kind: 'text', text: ' 2 ' }) === true, '文本题：接受多个答案')
    ok(gradeResponse(derive, { kind: 'text', text: '3' }) === false, '文本题：不在接受集合里判错')

    const open = { kind: 'explain', answer: { kind: 'open' } }
    ok(gradeResponse(open, { kind: 'open', text: '随便说说' }) === null, '开放题不判定（不强行打数字分）')
    ok(gradeResponse(cloze, { kind: 'open', text: '文本' }) === null, '作答形态对不上时不假装判错')
  }

  /* ---- 题目视图不含答案 ---- */
  {
    const made = createExercise(
      {
        courseId: 'co_1',
        unitId: 'u_1',
        kind: 'choice',
        prompt: '哪个负责吸收光？',
        options: [
          { id: 'a', text: '叶绿素' },
          { id: 'b', text: '线粒体' }
        ],
        answer: { kind: 'choice', optionId: 'a' },
        hints: [{ level: 'direction', text: '看第二段' }],
        solution: '叶绿素负责吸收光。'
      },
      1000,
      () => 'ex_1'
    )
    ok(made.ok === true, '建题成功')
    const view = exerciseView(made.exercise, [])
    ok(!('answer' in view), '题目视图里没有答案字段')
    ok(JSON.stringify(view).includes('叶绿素') === true, '选项文本照常给（那是题面的一部分）')
    ok(view.hints.length === 0 && view.hasMoreHints === true, '未揭示时不给提示')
    ok(view.hasSolution === true, '知道有没有完整解释（但拿不到它）')
    ok(!JSON.stringify(view).includes('叶绿素负责吸收光'), '完整解释不出现在题目视图里')

    ok(revealHints(made.exercise, 'concept').length === 1, '只有方向层时，揭示「关键概念」也只给已有的那层')
    ok(revealHints(made.exercise, 'bogus').length === 0, '未知层级不给')
    ok(highestHint(['direction', 'next-step']) === 'next-step', '最高提示层取最深的那个')
    ok(highestHint([]) === 'none', '没要提示就是 none')
  }

  /* ---- 独立完成的三条硬条件 ---- */
  {
    const base = { correct: true, hintLevelSeen: 'none', lookedAtSolution: false }
    ok(isIndependent(base) === true, '判对 + 没提示 + 没看解释 = 独立完成')
    ok(isIndependent({ ...base, hintLevelSeen: 'direction' }) === false, '用了提示就不算独立完成')
    ok(isIndependent({ ...base, lookedAtSolution: true }) === false, '看过解释就不算独立完成')
    ok(isIndependent({ ...base, correct: false }) === false, '答错当然不算')
    ok(isIndependent({ correct: null, hintLevelSeen: 'none', lookedAtSolution: false }) === false, '开放题永远不算独立完成')
  }

  /* ---- 建题校验 ---- */
  {
    ok(validateExerciseInput({ courseId: 'c', unitId: 'u', kind: 'choice', prompt: 'p', options: [{ id: 'a', text: 'A' }], answer: { kind: 'choice', optionId: 'a' } }).ok === false, '选择题少于两个选项被拒')
    ok(validateExerciseInput({ courseId: 'c', unitId: 'u', kind: 'cloze', prompt: 'p' }).ok === false, '客观题必须给参考答案')
    const open = validateExerciseInput({ courseId: 'c', unitId: 'u', kind: 'explain', prompt: 'p', answer: { kind: 'choice', optionId: 'a' } })
    ok(open.ok === true && open.value.answer.kind === 'open', '开放题即使传了答案也落成 open')
    ok(validateExerciseInput({ courseId: 'c', unitId: 'u', kind: 'nope', prompt: 'p' }).ok === false, '未知题型被拒')
    ok(dedupeHints([{ level: 'direction', text: '一' }, { level: 'direction', text: '二' }]).length === 1, '同一层提示只留第一条')
  }

  /* ---- 从材料出题（确定性） ---- */
  {
    const drafts = draftExercisesFromText(SAMPLE_TEXT, { unitTitle: '光合作用' })
    ok(drafts.length >= 2, `至少出到解释题与填空题（实际 ${drafts.length}）`)
    ok(drafts[0].kind === 'explain', '第一道是用自己的话解释')
    const cloze = drafts.find((d) => d.kind === 'cloze')
    ok(!!cloze && cloze.answer.kind === 'cloze', '填空题的答案形状对')
    const blank = cloze.answer.blanks[0]
    ok(SAMPLE_TEXT.includes(blank) === true, `填空答案就在原文里（${blank}）`)
    ok(cloze.prompt.includes('____') === true, '题面把那个词挖成空')
    ok(drafts.every((d) => d.origin === 'material') === true, '宿主规则出的题标成 material')
    ok(draftExercisesFromText('   ').length === 0, '空正文不出题')
  }

  /* ---- 反馈规则 ---- */
  {
    const exercise = { hints: [{ level: 'direction', text: '看第二段' }] }
    const correct = buildFeedback(exercise, { correct: true, hintLevelSeen: 'none', lookedAtSolution: false })
    ok(correct.verdict === true && correct.assisted === false, '独立做对：assisted=false')
    const assisted = buildFeedback(exercise, { correct: true, hintLevelSeen: 'concept', lookedAtSolution: false })
    ok(assisted.assisted === true, '用了提示的做对：assisted=true')
    ok(assisted.nextPractice.includes('提示'), '用了提示会建议再做一遍同类题（不给虚假掌握）')
    const wrong = buildFeedback(exercise, { correct: false, hintLevelSeen: 'none', lookedAtSolution: false })
    ok(wrong.verdict === false && wrong.howToFix.length > 0, '答错给「怎么改」')
    const open = buildFeedback(exercise, { correct: null, hintLevelSeen: 'none', lookedAtSolution: false })
    ok(open.verdict === null && open.needsModel === true, '开放题交给模型补具体反馈')
  }

  /* ---- 容错读盘 ---- */
  {
    const doc = sanitizeExerciseDocument({
      version: 1,
      exercises: [
        { id: 'ex_1', courseId: 'c', unitId: 'u', kind: 'explain', prompt: 'p', answer: { kind: 'open' } },
        { id: 'ex_1', courseId: 'c', unitId: 'u', kind: 'explain', prompt: '重复', answer: { kind: 'open' } },
        { id: 'ex_bad', courseId: 'c', unitId: 'u', kind: 'choice', prompt: '缺答案' }
      ],
      attempts: [{ id: 'at_1', exerciseId: 'ex_1', courseId: 'c', unitId: 'u', raw: 'x', correct: null, hintLevelSeen: 'none', lookedAtSolution: false, at: 1 }]
    })
    ok(doc.exercises.length === 1, '坏题与重复题被丢掉')
    ok(doc.attempts.length === 1, '作答正常读回')
    ok(sanitizeExercise({ id: 'x', courseId: 'c', unitId: 'u', kind: 'cloze', prompt: 'p', answer: { kind: 'cloze', blanks: ['a'] } }) !== null, '填空题形状对能读回')
  }
}

export function runExerciseStoreTests(ok, mod, fs) {
  const { ExerciseStore } = mod

  ok(typeof ExerciseStore === 'function', 'ExerciseStore 可构造')
  return (async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'yan-ex-store-'))
    try {
      const store = new ExerciseStore({ root: dir })
      await store.load()
      const exercise = {
        id: 'ex_1',
        courseId: 'co_1',
        unitId: 'u_1',
        conceptIds: [],
        kind: 'choice',
        prompt: '哪个？',
        options: [
          { id: 'a', text: '甲' },
          { id: 'b', text: '乙' }
        ],
        answer: { kind: 'choice', optionId: 'a' },
        hints: [],
        origin: 'material',
        sources: [],
        createdAt: 1,
        updatedAt: 1
      }
      await store.saveExercise(exercise)
      await store.addAttempt({
        id: 'at_1',
        exerciseId: 'ex_1',
        courseId: 'co_1',
        unitId: 'u_1',
        raw: 'b',
        correct: false,
        hintLevelSeen: 'none',
        lookedAtSolution: false,
        at: 2
      })

      /* 换一个实例读回来（等价于重开应用） */
      const reopened = new ExerciseStore({ root: dir })
      await reopened.load()
      ok(reopened.findExercise('ex_1') !== null, '题目读回来了')
      ok(reopened.attemptsOf('ex_1').length === 1, '作答读回来了')

      /* 纠正：原判定保留，纠正并存 */
      const corrected = await reopened.correctAttempt({ attemptId: 'at_1', text: '我选的是对的', correct: true, at: 3 })
      ok(corrected !== null && corrected.correct === true, '纠正把判定改了')
      ok(corrected.correction && corrected.correction.text === '我选的是对的', '纠正内容记下来了')

      const raw = JSON.parse(await readFile(join(dir, 'exercises.json'), 'utf8'))
      ok(raw.attempts[0].correct === true && raw.attempts[0].correction.text === '我选的是对的', '落盘里纠正与原判定并存')

      /* 删题带走作答 */
      await reopened.removeExercise('ex_1')
      const after = new ExerciseStore({ root: dir })
      await after.load()
      ok(after.findExercise('ex_1') === null && after.listAttempts().length === 0, '删题会把它的作答一起带走')

      /* 删课程 */
      await after.saveExercise({ ...exercise, id: 'ex_2', courseId: 'co_2' })
      const removed = await after.removeCourse('co_2')
      ok(removed === 1 && after.listExercises().length === 0, '删课程带走它的题目')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })()
}

export function runExerciseServiceTests(ok, mod, fs) {
  const { ExerciseService, ExerciseStore } = mod
  const library = {
    async openRef() {
      return { outcome: 'ok', text: SAMPLE_TEXT }
    }
  }
  const courses = { find: (id) => (id === 'co_1' ? fakeCourse() : null) }

  return (async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'yan-ex-svc-'))
    try {
      let tick = 1000
      const service = new ExerciseService({
        store: new ExerciseStore({ root: dir }),
        courses,
        library,
        now: () => (tick += 1),
        random: () => 0.5
      })

      /* 出题：课程 / 单元必须存在 */
      const missing = await service.create({ courseId: 'co_1', unitId: 'nope', kind: 'explain', prompt: 'p' })
      ok(missing.ok === false, '不在路线里的单元不能出题')
      const made = await service.create({
        courseId: 'co_1',
        unitId: 'u_1',
        kind: 'choice',
        prompt: '哪个吸收光？',
        options: [
          { id: 'a', text: '叶绿素' },
          { id: 'b', text: '线粒体' }
        ],
        answer: { kind: 'choice', optionId: 'a' },
        hints: [
          { level: 'direction', text: '看第二段' },
          { level: 'concept', text: '和颜色有关' }
        ],
        solution: '叶绿素。'
      })
      ok(made.ok === true, '出题成功')
      const id = made.exercise.id

      const views = await service.listForUnit('co_1', 'u_1')
      ok(views.length === 1 && !('answer' in views[0]), '列表给的是不含答案的视图')

      /* 从这一节出题（假资料） */
      const drafted = await service.createFromUnit({ courseId: 'co_1', unitId: 'u_1' })
      ok(drafted.ok === true && drafted.created >= 2, '从材料出题成功')
      const modelUnit = await service.createFromUnit({ courseId: 'co_1', unitId: 'u_2' })
      ok(modelUnit.ok === false, '补充单元没有材料，如实拒绝')

      /* 提示逐层；看解释 -->
         下次作答不再算独立 */
      const firstHint = await service.revealHint({ exerciseId: id, upto: 'direction' })
      ok(firstHint.ok === true && firstHint.hints.length === 1, '揭示方向层')
      const secondHint = await service.revealHint({ exerciseId: id, upto: 'concept' })
      ok(secondHint.ok === true && secondHint.hints.length === 2, '揭示到关键概念层（前面那层也带上）')
      const wrongLevel = await service.revealHint({ exerciseId: id, upto: 'example' })
      ok(wrongLevel.ok === true && wrongLevel.hints.length === 2, '没有 example 层时不硬凑')

      const solution = await service.revealSolution(id)
      ok(solution.ok === true && solution.solution === '叶绿素。', '看完整解释返回原文')

      /* 提交：服务自己记「看了多少帮助」 */
      const submitted = await service.submit({ exerciseId: id, response: { kind: 'choice', optionId: 'a' } })
      ok(submitted.ok === true && submitted.attempt.correct === true, '判分正确')
      ok(submitted.attempt.hintLevelSeen === 'concept', '记录到最高提示层（服务自己算，不信界面）')
      ok(submitted.attempt.lookedAtSolution === true, '看过解释也记下来了')
      ok(submitted.feedback.assisted === true, '反馈如实说这次用了帮助')

      /* 用户纠正 */
      const corrected = await service.correct({ attemptId: submitted.attempt.id, text: '其实我是想选 A 的' })
      ok(corrected.id === submitted.attempt.id && corrected.correction, '纠正被记录')
      const reversed = await service.correct({ attemptId: submitted.attempt.id, text: '判错了' })
      ok(reversed.correct === true, '不传 correct 时按「反过来」记')

      /* 删课程带走练习 */
      const removed = await service.removeCourse('co_1')
      ok(removed >= 1, '删课程带走题目')
      ok((await service.listForCourse('co_1')).length === 0, '列表随之清空')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })()
}
