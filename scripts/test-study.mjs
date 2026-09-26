/**
 * 学习状态与继续（实施-25 P08）—— 阶段转移 / 恢复信息 / 存储 / 闸门。
 *
 * 三条最值得钉住的：
 *   · **自问自答是坏结果**：`waiting_for_learner` 只能由 `ask`（带问题）进入，
 *     只能由 `answer`（用户真的答了）离开；`advance` 两头都碰不到。
 *   · **等待是持久化的**：换一个 store / service 实例（等价于重启应用）读回来，
 *     闸门仍然拦得住 —— 这是 R3 验收里「强杀重启后续跑仍被阻断」的可自动化形态。
 *   · **闸门是文件**：薄层读的是 `study-gate/<runnerId>.json`，所以单测直接读那个文件，
 *     而不是只看服务的内存态。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
      sources: [{ sourceId: 'lib_1', version: 1, locator: { start: 10, end: 80 } }]
    },
    { id: 'u_2', title: '第二段', origin: 'model', note: '补充', estimateMinutes: 5, concepts: [], sources: [] }
  ]
})

export function runStudyTests(ok, mod) {
  const {
    planPhaseTransition,
    sanitizeStudyDocument,
    sanitizeStudySession,
    isWaitingForLearner,
    buildStudyResume,
    studyWhere,
    waitingNote,
    backgroundStudySummary,
    resumeStudySummary,
    findSessionForCourse,
    findSessionForRuntime,
    upsertSession,
    removeSession,
    MAX_QUESTION_CHARS,
    MAX_NEXT_STEP_CHARS
  } = mod

  /* ---- 阶段转移：自问自答的闸 ---- */
  {
    const t = (from, to, extra = {}) => planPhaseTransition({ from, to, ...extra })
    ok(t('preparing', 'explaining').ok === true, '准备 → 讲解（正常开工）')
    ok(t('preparing', 'summary').ok === true, '准备 → 小结（看一眼就说这门课不用学）')

    const noQuestion = t('explaining', 'waiting_for_learner')
    ok(noQuestion.ok === false && noQuestion.reason === 'no-question', '进等待必须带问题（不能空手停下）')
    ok(t('explaining', 'waiting_for_learner', { hasQuestion: true }).ok === true, '带问题就能进等待')

    /*
     * 这两条是 P08 的核心：模型不能自己把「还没答的题」翻过去，
     * 也不能跳过提问直接判「练过了」。
     */
    const cheating = t('waiting_for_learner', 'feedback')
    ok(cheating.ok === false && cheating.reason === 'awaiting-learner', '学习者没作答 → 不能进反馈（不是进度）')
    ok(/自问自答/.test(cheating.message), `拒绝理由要说得直白（${cheating.message}）`)
    ok(t('waiting_for_learner', 'feedback', { hasAnswer: true }).ok === true, '作答之后才能进反馈')
    ok(t('waiting_for_learner', 'summary').ok === false, '等待中也不能直接跳到小结')
    ok(t('explaining', 'feedback').ok === false, '讲解后不能直接到反馈（必须先提问等作答）')
    ok(t('explaining', 'applying').ok === false, '讲解后不能直接到应用')

    ok(t('feedback', 'applying').ok === true, '反馈 → 应用')
    ok(t('feedback', 'summary').ok === true, '反馈 → 小结（这节先到这儿）')
    ok(t('applying', 'waiting_for_learner', { hasQuestion: true }).ok === true, '应用里也能再问一句')
    ok(t('summary', 'explaining').ok === true, '小结后进入下一节')
    const same = t('explaining', 'explaining')
    ok(same.ok === false && same.reason === 'same-phase', '原地不动如实说明')
  }

  /* ---- 容错读盘 ---- */
  {
    const session = {
      id: 'st_1',
      courseId: 'co_1',
      unitId: 'u_1',
      runtimeKey: 'runner-a',
      phase: 'waiting_for_learner',
      pending: { question: '这一段在讲什么？', origin: 'material', askedAt: 5 },
      position: { unitIndex: 0, locator: { start: 10, end: 80 } },
      paused: false,
      startedAt: 1,
      updatedAt: 5
    }
    ok(sanitizeStudySession(session)?.phase === 'waiting_for_learner', '合法等待会话读回来还是等待')
    ok(sanitizeStudySession({ ...session, id: '' }) === null, '没有 id 的记录丢掉')
    ok(sanitizeStudySession({ ...session, courseId: '' }) === null, '没有课程的记录丢掉')
    ok(sanitizeStudySession({ ...session, phase: '乱写的' })?.phase === 'preparing', '坏阶段降级到准备')

    /*
     * 等待但没有问题 = 死锁（闸门一直拦，而模型手里没有可问的东西），
     * 所以读盘时把它降级成讲解 —— 宁可让用户重说一遍，也不要卡住。
     */
    const orphan = sanitizeStudySession({ ...session, pending: undefined })
    ok(orphan?.phase === 'explaining', '等待却没有问题 → 降级（防死锁）')

    const long = sanitizeStudySession({
      ...session,
      pending: { question: 'x'.repeat(MAX_QUESTION_CHARS + 100), origin: 'model', askedAt: 1 },
      nextStep: 'y'.repeat(MAX_NEXT_STEP_CHARS + 50)
    })
    ok(long.pending.question.length === MAX_QUESTION_CHARS, '问题正文截断到上限')
    ok(long.nextStep.length === MAX_NEXT_STEP_CHARS, '下一步说明截断到上限')

    const doc = sanitizeStudyDocument({
      sessions: [session, { ...session }, { ...session, id: 'st_2' }, null, { id: 'x' }]
    })
    ok(doc.sessions.length === 2, '重复 id 与坏记录被丢掉', String(doc.sessions.length))
    ok(sanitizeStudyDocument(null).sessions.length === 0, '空文档读成空列表')
  }

  /* ---- 闸门判据与索引 ---- */
  {
    const waiting = { id: 'st_1', courseId: 'co_1', runtimeKey: 'r1', phase: 'waiting_for_learner', paused: false }
    const paused = { ...waiting, id: 'st_2', paused: true }
    const other = { id: 'st_3', courseId: 'co_2', runtimeKey: 'r2', phase: 'explaining', paused: false }
    ok(isWaitingForLearner(waiting) === true, '等待阶段 → 闸门拦')
    ok(isWaitingForLearner(paused) === false, '用户暂停 → 不算等待（后台准备可以继续做）')
    ok(isWaitingForLearner(other) === false, '别的阶段不拦')
    ok(isWaitingForLearner(null) === false, '没有会话不拦')

    const sessions = [waiting, other]
    ok(findSessionForRuntime(sessions, 'r2')?.id === 'st_3', '按 runner 找到正在陪的课')
    ok(findSessionForRuntime(sessions, '不存在') === null, '找不到就是没有（不编一个）')
    ok(findSessionForCourse(sessions, 'co_1')?.id === 'st_1', '按课程找到学习状态')
    ok(upsertSession(sessions, { ...other, phase: 'summary' }).length === 2, '同 id 更新不新增')
    ok(upsertSession(sessions, { ...other, id: 'st_9' }).length === 3, '新 id 追加')
    ok(removeSession(sessions, 'st_1').length === 1, '按 id 删')
  }

  /* ---- 恢复信息（只带必要的，不带整份课程） ---- */
  {
    const course = fakeCourse()
    const session = {
      id: 'st_1',
      courseId: 'co_1',
      unitId: 'u_2',
      runtimeKey: 'r1',
      phase: 'waiting_for_learner',
      pending: { question: '为什么用 would？', origin: 'material', askedAt: 9 },
      nextStep: '等他答完再给反馈',
      position: { unitIndex: 1, locator: { start: 80, end: 200 } },
      paused: false,
      startedAt: 1,
      updatedAt: 9
    }
    const resume = buildStudyResume(session, course)
    ok(resume.unitIndex === 2 && resume.totalUnits === 2, '第几节 / 共几节', `${resume.unitIndex}/${resume.totalUnits}`)
    ok(resume.unitTitle === '第二段' && resume.courseTitle === '英语精读', '课程名与单元名都带上了')
    ok(resume.waiting === true && resume.phaseLabel === '等你作答', '等待状态如实投影')
    ok(resume.question === '为什么用 would？' && resume.nextStep === '等他答完再给反馈', '问题与下一步带上了')
    ok(!('units' in resume), '恢复信息里**没有**整份单元列表（只带位置）')
    ok(studyWhere(resume) === '《英语精读》·第 2/2 节「第二段」', `位置句子可读（${studyWhere(resume)}）`)

    const gone = buildStudyResume(session, null)
    ok(gone.courseTitle === '（课程已删除）', '课程被删也如实显示，不崩')
    const missingUnit = buildStudyResume({ ...session, unitId: 'u_x' }, course)
    ok(missingUnit.unitTitle === '（这一节已不在路线里）', '单元被删如实显示')
  }

  /* ---- 续行 / 提示正文（T08-6 的边界写进正文） ---- */
  {
    const resume = buildStudyResume(
      {
        id: 'st_1',
        courseId: 'co_1',
        unitId: 'u_1',
        runtimeKey: 'r1',
        phase: 'explaining',
        position: { unitIndex: 0 },
        paused: false,
        startedAt: 1,
        updatedAt: 1
      },
      fakeCourse()
    )
    const note = waitingNote(resume)
    ok(/等学习者作答/.test(note) && /不会自动继续/.test(note), `拦住续跑的说明写清后果（${note}）`)

    const background = backgroundStudySummary(resume)
    ok(/整理教材|备下一节|生成适量练习|整理笔记/.test(background), '后台允许做的事写清楚了')
    ok(/不要.*替学习者作答|不要替他作答/.test(background), '禁止替答写清楚了')
    ok(/不要.*进度往前提/.test(background), '禁止虚增进度写清楚了')

    const resumed = resumeStudySummary({ ...resume, phase: 'feedback', question: 'x', nextStep: '看他的答案' })
    ok(/接着学/.test(resumed) && /feedback|反馈/.test(resumed), '「接着学」带上次停在哪')
    ok(/不要从头重讲/.test(resumed), '要求不要重讲（恢复不是重来）')
  }
}

/** 存储：真临时目录 + 真闸门文件。 */
export async function runStudyStoreTests(ok, mod, helpers) {
  const { StudyStore, studyDocumentPath, studyGatePath } = mod
  const root = await mkdtemp(join(tmpdir(), 'yan-study-'))
  try {
    const store = new StudyStore({ root })
    await store.load()
    ok(store.list().length === 0, '空目录读成空列表')

    const session = {
      id: 'st_1',
      courseId: 'co_1',
      unitId: 'u_1',
      runtimeKey: 'runner-a',
      phase: 'waiting_for_learner',
      pending: { question: '解释一下这一段', origin: 'material', askedAt: 5 },
      position: { unitIndex: 0 },
      paused: false,
      startedAt: 1,
      updatedAt: 5
    }
    await store.save(session)
    ok(store.forCourse('co_1')?.id === 'st_1', '按课程找到')
    ok(store.forRuntime('runner-a')?.id === 'st_1', '按 runner 找到')

    /* 同一门课再存一条：替换而不是新增（一门课同时只有一个学习会话） */
    await store.save({ ...session, id: 'st_1', updatedAt: 6 })
    ok(store.list().length === 1, '同一门课不会存成两条')

    /*
     * 同一 runner 改陪另一门课：旧课那条要保留（位置还在），但**不能占着 runnerId**
     * —— 否则闸门按 runtimeKey 查会查到 A 课，把 B 课的学习也拦住。
     */
    await store.save({ ...session, id: 'st_2', courseId: 'co_2', unitId: 'u_9', runtimeKey: 'runner-a' })
    ok(store.forRuntime('runner-a')?.courseId === 'co_2', 'runner 只陪最新那门课')
    ok(store.forCourse('co_1')?.runtimeKey === '', '旧课保留但解绑 runner')

    /* 闸门文件：薄层读的就是这一份 */
    const gate = { version: 1, waiting: true, sessionId: 'st_2', courseId: 'co_2', unitId: 'u_9', where: '《x》·第 1/1 节「y」', at: 7 }
    await store.setGate('runner-a', gate)
    const rawGate = JSON.parse(await readFile(studyGatePath('runner-a', root), 'utf8'))
    ok(rawGate.waiting === true && rawGate.where === gate.where, '闸门落成文件（薄层据此拦截）')
    ok((await store.readGate('runner-a'))?.sessionId === 'st_2', '读回闸门')
    await store.setGate('runner-a', null)
    ok((await store.readGate('runner-a')) === null, '清闸门 = 真的删掉文件')
    ok((await store.remove('st_2')) === true, '删会话')
    ok((await store.remove('st_2')) === false, '删不存在的会话如实失败')

    /* 重开：数据在盘上，不是内存里的 */
    const reopened = new StudyStore({ root })
    await reopened.load()
    ok(reopened.forCourse('co_1')?.pending?.question === '解释一下这一段', '重开后等待中的问题还在')

    await import('node:fs/promises').then((fs) => fs.writeFile(studyDocumentPath(root), '{ 不是 JSON', 'utf8'))
    const tolerant = new StudyStore({ root })
    await tolerant.load()
    ok(tolerant.list().length === 0, '坏文档读成空列表（不拦启动）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 服务：阶段推进 + 闸门同步 + 持久化（R3 的闸门验证）。 */
export async function runStudyServiceTests(ok, mod, helpers) {
  const { LearningService, StudyStore } = mod
  const root = await mkdtemp(join(tmpdir(), 'yan-learn-'))
  const course = fakeCourse()
  const courses = { find: (id) => (id === course.id ? course : null) }
  const make = (r) =>
    new LearningService({
      store: new StudyStore({ root: r }),
      courses,
      now: () => 1000,
      random: () => 0.5
    })
  try {
    const svc = make(root)
    ok((await svc.waitingForLearner('runner-a')) === false, '还没开始学 → 不拦')

    const missing = await svc.start({ courseId: 'nope', runtimeKey: 'runner-a' })
    ok(missing.ok === false, '找不到课程 → 拒绝')
    ok((await svc.start({ courseId: course.id, unitId: 'u_x', runtimeKey: 'runner-a' })).ok === false, '单元不在路线 → 拒绝')

    const started = await svc.start({ courseId: course.id, runtimeKey: 'runner-a' })
    ok(started.ok === true && started.session.phase === 'preparing', '开始 → 准备阶段')
    ok(started.session.unitId === 'u_1' && started.session.position.locator?.start === 10, '默认从第一节开始，位置取自单元的出处区间')
    const sid = started.session.id

    const again = await svc.start({ courseId: course.id, runtimeKey: 'runner-b' })
    ok(again.session.id === sid, '同一门课再开始 → 还是那个会话（「接着学」）')
    ok(again.session.runtimeKey === 'runner-b', '绑定换到新会话（换会话不受影响）')
    ok((await svc.waitingForLearner('runner-a')) === false, '旧会话不再被绑着')
    await svc.start({ courseId: course.id, runtimeKey: 'runner-a' })

    /* 没开始学习就提问 */
    ok((await svc.ask({ runtimeKey: 'runner-none', question: 'x' })).ok === false, '没开始学习 → 不能提问')
    ok((await svc.ask({ runtimeKey: 'runner-a', question: '   ' })).ok === false, '空问题 → 拒绝')

    await svc.advance({ runtimeKey: 'runner-a', to: 'explaining' })
    const asked = await svc.ask({
      runtimeKey: 'runner-a',
      question: '这一段在讲什么？',
      expectation: '用自己的话说',
      origin: 'material',
      sources: [{ sourceId: 'lib_1', version: 1, locator: { start: 10, end: 80 } }],
      nextStep: '等他答完再给反馈'
    })
    ok(asked.ok === true && asked.session.phase === 'waiting_for_learner', '提问 → 等你作答')
    ok(asked.session.pending?.question === '这一段在讲什么？', '等待里存着问题本身')
    ok(asked.session.pending?.origin === 'material', '记下问题来自教材还是模型补充')

    /* 闸门：内存判据 + 盘上的文件（薄层读的就是它） */
    ok((await svc.waitingForLearner('runner-a')) === true, '闸门判据：正在等作答')
    const gate = JSON.parse(await readFile(join(root, 'study-gate', 'runner-a.json'), 'utf8'))
    ok(gate.waiting === true && gate.courseId === course.id, '闸门文件已写（薄层据此拦下续行）')
    ok(/第 1\/2 节/.test(gate.where), `闸门里带位置（${gate.where}）`)

    /* T08-7：模型不能自己把等待翻过去 */
    const jumped = await svc.advance({ runtimeKey: 'runner-a', to: 'feedback' })
    ok(jumped.ok === false && /自问自答|作答/.test(jumped.reason), '等待中 advance 到反馈被拒（自问自答不算进度）')
    ok((await svc.advance({ runtimeKey: 'runner-a', to: 'summary' })).ok === false, '等待中也不能跳到小结')

    /* 重启等价：换一套 store / service 读盘，闸门仍然拦得住（T08-2） */
    const restarted = make(root)
    ok((await restarted.waitingForLearner('runner-a')) === true, '换个实例（等价重启）后闸门仍然拦得住')
    const status = await restarted.status('runner-a')
    ok(status.waiting === true && status.resume?.question === '这一段在讲什么？', '重启后恢复信息带着上次的问题')
    ok(status.gate?.waiting === true, '重启后盘上的闸门也还在')

    /* 用户作答 → 唯一能离开等待的路 */
    ok((await svc.answer({ runtimeKey: 'runner-none', text: 'x' })).ok === false, '没在等 → 作答被拒')
    const answered = await svc.answer({ runtimeKey: 'runner-a', text: '在讲他小时候的一个春天。' })
    ok(answered.ok === true && answered.session.phase === 'feedback', '作答 → 反馈')
    ok(answered.session.pending === undefined && answered.session.lastAnswer?.text.includes('春天'), '转存作答、清掉待答')
    ok((await svc.waitingForLearner('runner-a')) === false, '作答后闸门放行（自动续跑可以继续了）')
    ok((await svc.answer({ runtimeKey: 'runner-a', text: '再说一句' })).ok === false, '已经进反馈 → 再作答被拒')

    ok((await svc.advance({ runtimeKey: 'runner-a', to: 'applying' })).ok === true, '反馈 → 应用（模型可推进）')
    ok((await svc.advance({ runtimeKey: 'runner-a', to: 'explaining' })).ok === true, '应用 → 讲解（继续讲）')
    ok((await svc.advance({ runtimeKey: 'runner-a', to: 'nope' })).ok === false, '未知阶段被拒')

    /* 暂停 / 恢复 / 停止 */
    await svc.ask({ runtimeKey: 'runner-a', question: '那 would 呢？', origin: 'model', nextStep: '等他答' })
    ok((await svc.waitingForLearner('runner-a')) === true, '再问一次 → 又进等待')
    ok((await svc.pause('runner-a')).ok === true, '暂停')
    ok((await svc.waitingForLearner('runner-a')) === false, '暂停后不再算等待（后台准备可以继续）')
    ok((await svc.resume('runner-a')).ok === true && (await svc.waitingForLearner('runner-a')) === true, '恢复 → 等待也恢复')
    const stopped = await svc.stop('runner-a')
    ok(stopped.ok === true && stopped.session.runtimeKey === '', '停止 → 解绑会话但保留位置')
    ok((await svc.waitingForLearner('runner-a')) === false, '停止后闸门也收掉')
    const restartedAgain = make(root)
    ok((await restartedAgain.statusOfCourse(course.id)).session?.phase === 'waiting_for_learner', '停止不影响已保存的阶段（下次接着学）')

    ok((await svc.remove(course.id)) === true, '删掉一门课的学习状态')
    ok((await svc.remove(course.id)) === false, '再删如实说没有')
    ok((await svc.list()).length === 0, '删完列表为空')

    await rm(root, { recursive: true, force: true })
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
