/**
 * 错题与复习（实施-25 P12）—— 调度规则 / 挑题 / 存储 / 服务。
 *
 * 三条最值得钉住的：
 *   · **再练换同概念的新例子**：做过的原题不再端回来，宁可如实说「没有新例子」；
 *   · **复习只到提醒与挑题**：服务不自动开始学习、不自动推进 `StudySession`；
 *   · **间隔是排期，不是掌握证明**：独立成功往后延、出错或提示回到最近一档，
 *     但逾期不乘倍（断三天回来看到三条，不是九条）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DAY = 86400000

function item(over = {}) {
  return {
    id: over.id ?? 'rv_1',
    courseId: over.courseId ?? 'co1',
    ...(over.conceptId ? { conceptId: over.conceptId } : {}),
    reason: over.reason ?? 'wrong-answer',
    prompt: over.prompt ?? '这道题做过一遍',
    dueAt: over.dueAt ?? DAY,
    stage: over.stage ?? 0,
    priority: over.priority ?? 'normal',
    streak: over.streak ?? 0,
    seenCount: over.seenCount ?? 1,
    createdAt: over.createdAt ?? 0,
    updatedAt: over.updatedAt ?? 0,
    ...(over.source ? { source: over.source } : {}),
    ...(over.exerciseId ? { exerciseId: over.exerciseId } : {})
  }
}

export function runReviewTests(ok, mod) {
  const {
    scheduleReview,
    intervalDaysForStage,
    dueReviews,
    replanMissed,
    planReview,
    reviewKey,
    upsertReviewIn,
    sanitizeReview,
    reviewWhenText,
    reviewRuleText,
    REVIEW_INTERVAL_DAYS
  } = mod

  /* ---- 调度规则：透明、可解释 ---- */
  {
    const wrong = scheduleReview({ reason: 'wrong-answer', correct: false, independent: false, now: 0 })
    ok(wrong.stage === 0 && wrong.priority === 'high' && wrong.dueAt === DAY, '做错：回到最近一档 + 优先', JSON.stringify(wrong))

    const hinted = scheduleReview({ reason: 'hinted', correct: true, independent: false, now: 0 })
    ok(hinted.stage === 0 && hinted.priority === 'normal', '用了提示才完成：近期，但不加优先')

    const first = scheduleReview({ reason: 'wrong-answer', correct: true, independent: true, stage: 0, now: 0 })
    ok(first.stage === 1 && first.dueAt === 3 * DAY, '独立完成：延后一档（3 天）')

    const applied = scheduleReview({ reason: 'wrong-answer', correct: true, independent: true, transfer: true, stage: 0, now: 0 })
    ok(applied.stage === 2 && applied.dueAt === 7 * DAY, '在新情境里也独立完成：再延后一档（7 天）')

    const open = scheduleReview({ reason: 'repeated-question', correct: null, independent: false, now: 0 })
    ok(open.stage === 0 && open.priority === 'normal', '没判定（开放题）：按 1 天排，不当成学会了')

    const confused = scheduleReview({
      reason: 'confused',
      correct: false,
      independent: false,
      prerequisiteConceptId: 'c_pre',
      now: 0
    })
    ok(confused.priority === 'high' && confused.stage === 0, '出现混淆：补前置 + 优先')

    ok(intervalDaysForStage(0) === 1 && intervalDaysForStage(3) === 14, '档位对应 1/3/7/14 天')
    ok(intervalDaysForStage(99) === 14, '档位越界夹到最后一档')
    ok(REVIEW_INTERVAL_DAYS.join('/') === '1/3/7/14', '默认间隔就是 1/3/7/14（规则不是效果保证）')
  }

  /* ---- 排序与「逾期不乘倍」 ---- */
  {
    const items = [
      item({ id: 'rv_low', priority: 'low', dueAt: 0 }),
      item({ id: 'rv_high', priority: 'high', dueAt: 10 * DAY }),
      item({ id: 'rv_normal', priority: 'normal', dueAt: 0 })
    ]
    ok(dueReviews(items, 2 * DAY)[0].id === 'rv_normal', '优先高的先出（同为到期时按优先级）')
    ok(dueReviews(items, 2 * DAY).some((i) => i.id === 'rv_low'), '到期的低优先项也在列表里')

    const missed = replanMissed(items, 30 * DAY)
    ok(missed.length === items.length, '错过很久也只是「现在可以做」（一条是一条，不复制）')
    ok(missed.every((i) => i.dueAt <= 30 * DAY), '逾期项的到期时间如实留在过去')

    ok(reviewWhenText(item({ dueAt: 0 }), DAY) === '现在可以复习', '到期文案')
    ok(reviewWhenText(item({ dueAt: 2 * DAY }), DAY) === '明天再看一眼', '明天的文案')
    ok(/不代表/.test(reviewRuleText()), '规则文案明说「不代表已经掌握」')
  }

  /* ---- 挑题：换同概念的新例子 ---- */
  {
    const exercises = [
      { id: 'ex_old', courseId: 'co1', unitId: 'u1', conceptIds: ['c1'], kind: 'choice' },
      { id: 'ex_new', courseId: 'co1', unitId: 'u1', conceptIds: ['c1'], kind: 'apply' },
      { id: 'ex_other', courseId: 'co1', unitId: 'u1', conceptIds: ['c2'], kind: 'choice' }
    ]
    const reviews = [item({ id: 'rv_c1', conceptId: 'c1', dueAt: 0 })]

    const withOldOnly = planReview({
      items: reviews,
      exercises,
      attempts: [{ id: 'a1', exerciseId: 'ex_new', courseId: 'co1', unitId: 'u1', raw: 'x', correct: true, hintLevelSeen: 'none', lookedAtSolution: false, at: 1 }],
      now: DAY
    })
    ok(withOldOnly.entries.length === 1 && withOldOnly.entries[0].exerciseId === 'ex_old', '没做过的那道题就是「新例子」', withOldOnly.entries[0]?.exerciseId)

    const noneFresh = planReview({
      items: reviews,
      exercises,
      attempts: [
        { id: 'a1', exerciseId: 'ex_old', courseId: 'co1', unitId: 'u1', raw: 'x', correct: false, hintLevelSeen: 'none', lookedAtSolution: false, at: 1 },
        { id: 'a2', exerciseId: 'ex_new', courseId: 'co1', unitId: 'u1', raw: 'y', correct: false, hintLevelSeen: 'none', lookedAtSolution: false, at: 2 }
      ],
      now: DAY
    })
    ok(noneFresh.entries.length === 0 && noneFresh.needsNewExercise.length === 1, '都做过了就如实说「没有新例子」，不复用原题')
    ok(noneFresh.dueCount === 1, '到期数照样报（不是「没事了」）')

    const reading = planReview({
      items: [item({ id: 'rv_read', reason: 'misread', source: { sourceId: 'lib_1', version: 1 }, dueAt: 0 })],
      exercises: [],
      attempts: [],
      now: DAY
    })
    ok(reading.entries.length === 1 && reading.entries[0].exerciseId === undefined, '「没看懂原文」给一个重看条目，不假装有题')

    const quick = planReview({
      items: [item({ id: 'rv_a', conceptId: 'c1', dueAt: 0 }), item({ id: 'rv_b', conceptId: 'c2', dueAt: 0 }), item({ id: 'rv_c', conceptId: 'c3', dueAt: 0 })],
      exercises: exercises.slice(0, 1),
      attempts: [],
      now: DAY,
      mode: 'quick',
      minutesBudget: 5
    })
    ok(quick.entries.length === 1 && quick.minutes === 3, '「今天十分钟」卡在时间预算内', JSON.stringify({ n: quick.entries.length, m: quick.minutes }))

    const notDue = planReview({ items: [item({ dueAt: 10 * DAY, conceptId: 'c1' })], exercises, attempts: [], now: DAY })
    ok(notDue.entries.length === 0 && notDue.dueCount === 0, '没到期的不进 plan（首页也就不会催）')
  }

  /* ---- 合并键与容错 ---- */
  {
    ok(reviewKey(item({ conceptId: 'c1' })) === 'co1:concept:c1', '同概念用同一个键（覆盖而不是堆积）')
    const merged = upsertReviewIn([item({ id: 'rv_a', conceptId: 'c1', stage: 1 })], item({ id: 'rv_b', conceptId: 'c1', stage: 2 }))
    ok(merged.length === 1 && merged[0].stage === 2, '同概念的新记录替换旧的')

    const bad = sanitizeReview({ id: 'rv', courseId: 'co1', reason: 'nope', prompt: 'x' })
    ok(bad === null, '未知来因的复习项被丢掉')
    const clamped = sanitizeReview({ id: 'rv', courseId: 'co1', reason: 'hinted', prompt: 'x', stage: 99, priority: 'weird' })
    ok(clamped?.stage === 3 && clamped?.priority === 'normal', '档位夹紧、未知优先级回落到 normal')
    const noPrompt = sanitizeReview({ id: 'rv', courseId: 'co1', reason: 'hinted', prompt: '   ' })
    ok(noPrompt === null, '没有说明的复习项读不回来（宁可丢，也不要一条看不懂的记录）')
  }
}

export function runReviewStoreTests(ok, mod, fs) {
  const { LearningMemoryStore } = mod
  return (async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'yan-review-store-'))
    try {
      const store = new LearningMemoryStore({ root: dir })
      await store.load()
      ok(store.reviews().length === 0, '新文档里没有复习项（旧文档读回来也要补上这个字段）')
      await store.saveReview(item({ id: 'rv_1', courseId: 'co1', conceptId: 'c1', dueAt: DAY }))
      await store.saveReview(item({ id: 'rv_2', courseId: 'co1', conceptId: 'c2', dueAt: DAY, priority: 'high' }))

      const reopened = new LearningMemoryStore({ root: dir })
      await reopened.load()
      ok(reopened.reviews().length === 2, '复习项落盘了')
      ok(reopened.reviews('co1').length === 2 && reopened.reviews('co2').length === 0, '按课程筛复习项')
      ok(reopened.findReview('rv_2')?.priority === 'high', '按 id 找得到')

      await reopened.saveReview(item({ id: 'rv_3', courseId: 'co1', conceptId: 'c1', stage: 2, dueAt: 7 * DAY }))
      ok(reopened.reviews('co1').length === 2, '同概念是替换而不是追加')
      ok(reopened.findReview('rv_3')?.stage === 2, '替换后留下的是新的那条')

      ok(await reopened.removeReview('rv_2'), '删一条')
      ok(await reopened.removeReview('rv_2') === false, '再删同一条如实返回没删到')

      const removed = await reopened.removeCourse('co1')
      ok(removed.reviews === 1, '删课程带走复习项', JSON.stringify(removed))
      ok(reopened.reviews().length === 0, '删完就没了')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })()
}

export function runReviewServiceTests(ok, mod, fs) {
  const { LearningService, LearningMemoryStore } = mod
  return (async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'yan-review-svc-'))
    try {
      let tick = 1000
      const course = { id: 'co1', title: '光合作用', goal: '讲清楚', units: [], concepts: [{ id: 'c1', name: '光反应' }] }
      const exercises = [
        { id: 'ex_1', courseId: 'co1', unitId: 'u1', conceptIds: ['c1'], kind: 'choice', prompt: '光反应在哪里进行？' },
        { id: 'ex_2', courseId: 'co1', unitId: 'u1', conceptIds: ['c1'], kind: 'choice', prompt: '光反应的产物是什么？' },
        { id: 'ex_3', courseId: 'co1', unitId: 'u1', conceptIds: ['c1'], kind: 'apply', prompt: '如果把光遮住会发生什么？' }
      ]
      let attempts = []
      const service = new LearningService({
        memoryStore: new LearningMemoryStore({ root: dir }),
        courses: { find: (id) => (id === 'co1' ? course : null) },
        attempts: async () => ({ exercises, attempts }),
        now: () => (tick += 1000),
        random: () => 0.5
      })
      const submit = async (exercise, over) => {
        const attempt = {
          id: `a${attempts.length + 1}`,
          exerciseId: exercise.id,
          courseId: 'co1',
          unitId: 'u1',
          raw: 'x',
          correct: true,
          hintLevelSeen: 'none',
          lookedAtSolution: false,
          at: tick,
          ...over
        }
        attempts = [...attempts, attempt]
        await service.recordAttempt(attempt, exercise)
        return attempt
      }

      /* 做错 → 建一条复习（来因 = 做错过，优先） */
      await submit(exercises[0], { correct: false })
      let reviews = await service.listReviews('co1')
      ok(reviews.length === 1 && reviews[0].reason === 'wrong-answer', '做错建一条复习', JSON.stringify(reviews[0]?.reason))
      ok(reviews[0].priority === 'high' && reviews[0].stage === 0, '做错：优先 + 最近一档')
      ok(reviews[0].prompt.includes('光反应'), '复习项带着题面，用户知道要复习什么')

      /* 用了提示才做对 → 来因是「用了提示」，不是「做错」 */
      const hintedAttempt = await submit(exercises[1], { correct: true, hintLevelSeen: 'direction' })
      reviews = await service.listReviews('co1')
      ok(reviews[0].reason === 'hinted', '用提示完成：来因跟着变（同概念仍是一条）')
      ok(reviews[0].stage === 0, '用提示不加进度档')

      /* 新情境做错 → 「不会迁移」 */
      attempts = attempts.filter((a) => a.id !== hintedAttempt.id)
      await submit(exercises[2], { correct: false })
      reviews = await service.listReviews('co1')
      ok(reviews[0].reason === 'not-transferable', '应用题做错 → 来因是「不会迁移」')

      /* 挑题：不复用做过的原题 */
      const plan = await service.planToday('co1')
      ok(plan.entries.length === 0 || plan.entries.every((e) => e.exerciseId !== undefined), '挑出来的都带具体题目')
      ok(
        plan.entries.every((e) => !attempts.some((a) => a.exerciseId === e.exerciseId)),
        '挑的题都不是做过的原题'
      )

      /* 连续两次独立成功 → 收掉 */
      const fresh = [
        { id: 'ex_9', courseId: 'co1', unitId: 'u1', conceptIds: ['c1'], kind: 'choice', prompt: '新例子' },
        { id: 'ex_10', courseId: 'co1', unitId: 'u1', conceptIds: ['c1'], kind: 'choice', prompt: '又一个新例子' }
      ]
      exercises.push(...fresh)
      await submit(fresh[0], { correct: true })
      ok((await service.listReviews('co1')).length === 1, '一次独立成功还留着（只往后延）')
      await submit(fresh[1], { correct: true })
      ok((await service.listReviews('co1')).length === 0, '连续两次独立成功就把这条收掉')

      /* 开放题（没判定）不建复习，也不推进 */
      const open = { ...exercises[0], id: 'ex_open', kind: 'explain' }
      exercises.push(open)
      await submit(open, { correct: null })
      ok((await service.listReviews('co1')).length === 0, '开放题没判定：既不建错题，也不当成学会了')

      /* 反复问：第一次 low，第二次 high */
      await service.flagQuestion({ courseId: 'co1', conceptId: 'c1' })
      reviews = await service.listReviews('co1')
      ok(reviews[0].reason === 'repeated-question' && reviews[0].priority === 'low', '第一次问：轻轻记下')
      await service.flagQuestion({ courseId: 'co1', conceptId: 'c1' })
      reviews = await service.listReviews('co1')
      ok(reviews.length === 1 && reviews[0].priority === 'high' && reviews[0].seenCount === 2, '第二次问：提上来（还是一条）')

      /* 没看懂的原文：不带题 */
      const reading = await service.flagReading({
        courseId: 'co1',
        sourceId: 'lib_1',
        version: 2,
        locator: { start: 10, end: 60 },
        note: '这段没看懂'
      })
      ok(reading.ok === true && reading.review.reason === 'misread', '登记「这段没看懂」')
      ok(reading.review.source?.sourceId === 'lib_1' && reading.review.source?.version === 2, '带上出处的那一版')

      /* 挪期 / 删掉 */
      const moved = await service.rescheduleReview(reviews[0].id, { dueAt: tick + 5 * DAY, priority: 'low' })
      ok(moved.ok === true && moved.review.priority === 'low', '挪期只动时间与优先级')
      ok((await service.dismissReview(reviews[0].id)) === true, '可以手动去掉一条')
      ok((await service.listReviews('co1')).length === 1, '去掉之后只剩「没看懂的原文」那条')

      /* 课程不存在时不落数据 */
      ok((await service.flagQuestion({ courseId: 'nope', conceptId: 'c1' })).ok === false, '课程不存在时不落复习项')

      const cleaned = await service.removeMemory('co1')
      ok(cleaned.reviews === 1, '删课程带走复习项', JSON.stringify(cleaned))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })()
}
