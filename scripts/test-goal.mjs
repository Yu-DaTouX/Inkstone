/**
 * 目标与澄清就绪（实施-05 S3）的纯逻辑与存储测试。
 *
 * 分两层：
 *   · `src/shared/goal.ts`   契约与纯函数（就绪校验 / 报告校验 / 推进 / 清洗）；
 *   · `src/main/goal-service.ts` 真文件、真幂等、真「先落盘再返回」。
 *
 * 为什么存储层必须单独测：它的失败模式都在磁盘边上 ——
 * 幂等记录没拦住重放（转移发生两次）、`modeRevision` 过期判断让重试看起来像失败、
 * 脏 JSON 让整份文档作废、多会话互相串。只看返回值一样验不出来。
 *
 * 用法：npm run test:unit
 */
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runGoalTests(ok) {
  const shared = await import('../out/test/goal.mjs')
  const service = await import('../out/test/goal-service.mjs')

  /* --------------------------------------------------------- 契约常量 */

  ok(
    shared.GOAL_PHASES.join(',') === 'planning,executing,verifying,completed,blocked,stopped',
    '阶段集合固定（planning → executing → verifying → completed，另有 blocked / stopped）'
  )
  ok(shared.READY_CONFIDENCE_THRESHOLD === 0.95, '就绪门槛是 0.95（§4）')
  ok(shared.FAILURE_BLOCK_THRESHOLD === 2, '同一失败连续两次判 blocked（§5）')

  /* --------------------------------------------------------- 就绪校验 */

  const ready = (patch = {}) => ({
    transitionId: 'tr-1',
    confidence: 0.97,
    understanding: {
      goal: '把导出功能加上',
      deliverable: '导出按钮 + CSV 文件',
      scope: '仅设置页',
      constraints: '不引入新依赖',
      acceptance: '点一下能下载 CSV'
    },
    openQuestions: [],
    modeRevision: 3,
    goalRevision: 0,
    ...patch
  })
  const current = { modeRevision: 3, goalRevision: 0 }

  ok(shared.checkReadySubmission(ready(), current).ok === true, '五栏齐 + 高置信 + revision 对得上 → 就绪')
  ok(
    shared.checkReadySubmission(ready({ transitionId: '  ' }), current).code === 'missing_transition_id',
    '缺 transitionId 被拒（幂等键不能省）'
  )
  ok(
    shared.checkReadySubmission(ready({ confidence: 0.9 }), current).code === 'confidence_too_low',
    '置信度不足被拒'
  )
  ok(
    shared.checkReadySubmission(ready({ confidence: '0.99' }), current).code === 'confidence_too_low',
    '置信度必须是数字（字符串 0.99 不算）'
  )
  const incomplete = shared.checkReadySubmission(
    ready({ understanding: { goal: 'x', deliverable: '', scope: ' ', constraints: 'c', acceptance: 'a' } }),
    current
  )
  ok(incomplete.code === 'incomplete_understanding', '理解不齐被拒')
  ok(
    Array.isArray(incomplete.missing) && incomplete.missing.join(',') === 'deliverable,scope',
    '被拒时要说清缺哪几栏（模型据此补问）'
  )
  ok(
    shared.checkReadySubmission(ready({ openQuestions: ['用 CSV 还是 JSON？'] }), current).code === 'open_questions',
    '还有未回答的必要问题 → 未就绪'
  )
  ok(
    shared.checkReadySubmission(ready({ modeRevision: 2 }), current).code === 'stale_mode',
    '模式 revision 过期被拒'
  )
  ok(
    shared.checkReadySubmission(ready({ goalRevision: 1 }), current).code === 'stale_goal',
    '目标 revision 过期被拒'
  )

  /* --------------------------------------------------------- 报告校验 */

  const goal0 = shared.emptyGoal(1000)
  ok(goal0.phase === 'planning' && goal0.revision === 0, '空目标是 planning / rev0')

  const report = (patch = {}) => ({ reportId: 'rp-1', phase: 'executing', goalRevision: 0, ...patch })
  ok(shared.checkGoalReport(report(), goal0).ok === true, '普通推进报告通过')
  ok(shared.checkGoalReport(report({ reportId: '' }), goal0).code === 'missing_report_id', '缺 reportId 被拒')
  ok(shared.checkGoalReport(report({ phase: 'done' }), goal0).code === 'bad_phase', '非法阶段被拒')
  ok(shared.checkGoalReport(report({ goalRevision: 5 }), goal0).code === 'stale_goal', '目标 revision 过期被拒')
  ok(
    shared.checkGoalReport(report({ phase: 'completed' }), goal0).code === 'completed_needs_evidence',
    '报完成必须带证据（清单勾选不算）'
  )
  ok(
    shared.checkGoalReport(report({ phase: 'completed', evidence: ['npm run test:unit 全绿'] }), goal0).ok === true,
    '带证据的完成通过'
  )
  ok(
    shared.checkGoalReport(report({ phase: 'blocked' }), goal0).code === 'blocked_needs_reason',
    '报 blocked 必须说清阻塞'
  )
  ok(
    shared.checkGoalReport(report({ phase: 'stopped' }), goal0).code === 'stopped_is_user_action',
    'stopped 是用户动作，模型不能自报'
  )
  const completedGoal = shared.applyGoalReport(
    goal0,
    shared.checkGoalReport(report({ phase: 'completed', evidence: ['证据'] }), goal0),
    1100
  )
  ok(completedGoal.phase === 'completed' && completedGoal.revision === 1, '完成推进 revision')
  ok(
    shared.checkGoalReport(report({ phase: 'executing', goalRevision: completedGoal.revision }), completedGoal).code ===
      'already_completed',
    '已完成的目标不能回退到进行中'
  )

  /* ------------------------------------------- 连续同因失败 → 强制 blocked */

  const first = shared.applyGoalReport(goal0, shared.checkGoalReport(report({ failureSignature: '测试挂了' }), goal0), 1200)
  ok(first.phase === 'executing' && first.failure?.count === 1, '第一次同因失败只记数，不判 blocked')
  const second = shared.applyGoalReport(
    first,
    shared.checkGoalReport(report({ reportId: 'rp-2', goalRevision: first.revision, failureSignature: '测试挂了' }), first),
    1300
  )
  ok(second.phase === 'blocked', '同一失败连续两次 → 强制 blocked（模型想继续也不行）')
  ok(!!second.blocker && second.blocker.includes('测试挂了'), '强制 blocked 时写清原因')
  const third = shared.applyGoalReport(
    goal0,
    shared.checkGoalReport(report({ failureSignature: '测试挂了' }), goal0),
    1400
  )
  const switched = shared.applyGoalReport(
    third,
    shared.checkGoalReport(report({ reportId: 'rp-3', goalRevision: third.revision, failureSignature: '换了个报错' }), third),
    1500
  )
  ok(switched.failure?.count === 1, '换了新失败签名 → 计数归零（有新证据/新路径才继续）')

  /* --------------------------------------------------------- 脏值清洗 */

  const dirty = shared.normalizeGoalState({ phase: 'nonsense', revision: -3, steps: [{ title: '' }, { title: 'a', status: 'x' }] })
  ok(dirty.phase === 'planning' && dirty.revision === 0, '脏阶段 / 负 revision 回落')
  ok(dirty.steps.length === 1 && dirty.steps[0].status === 'pending', '步骤清洗：空标题丢掉、坏状态回落 pending')
  ok(shared.normalizeGoalState(null).phase === 'planning', '非对象 → 空目标')

  /* ------------------------------------------- 自主档连续续接契约（S3c） */

  ok(
    shared.AUTONOMOUS_CONTINUE_LIMIT > 0 && shared.AUTONOMOUS_CONTINUE_LIMIT <= 20,
    `连续续接上限是有限值（${shared.AUTONOMOUS_CONTINUE_LIMIT}）`
  )
  ok(
    shared.isActiveGoalPhase('planning') && shared.isActiveGoalPhase('executing') && shared.isActiveGoalPhase('verifying'),
    '推进中的三个阶段算「还在跑」'
  )
  ok(
    !shared.isActiveGoalPhase('completed') && !shared.isActiveGoalPhase('blocked') && !shared.isActiveGoalPhase('stopped'),
    '终态不算「还在跑」（不该再续）'
  )
  ok(
    shared.resumeKindOf(null) === 'ready' &&
      shared.resumeKindOf({ operationId: 'x', at: 0, summary: 'y' }) === 'ready',
    '旧记录（没有 kind）当就绪续行'
  )
  ok(
    shared.resumeKindOf({ operationId: 'x', at: 0, summary: 'y', kind: 'continue' }) === 'continue',
    '带 kind 的记录按 kind 认'
  )

  const continueText = shared.goalContinueSummary(
    {
      ...shared.emptyGoal(1),
      phase: 'executing',
      revision: 3,
      steps: [
        { title: '写解析器', status: 'done' },
        { title: '接界面', status: 'pending' }
      ],
      evidence: ['npm run test:unit 全绿']
    },
    2
  )
  ok(continueText.includes('第 2 次'), '续接正文写明是第几次（排障要能对上）')
  ok(continueText.includes('executing'), '续接正文带回当前阶段')
  ok(
    continueText.includes('接界面') && !continueText.includes('写解析器'),
    '只列未完成步骤（已完成的不再干扰模型）'
  )
  ok(/不要问我/.test(continueText), '续接正文明确「不要问用户」')
  ok(continueText.includes('npm run test:unit 全绿'), '续接正文带回已有证据')

  /* --------------------------------------------------------- 存储层 */

  const root = await mkdtemp(join(tmpdir(), 'yan-goal-'))
  try {
    const store = new service.GoalStore({ root, now: () => 5000 })
    await store.load()
    const keyA = 'C:/tmp/sessions/a.jsonl'
    const keyB = 'C:/tmp/sessions/b.jsonl'

    const commit = await store.commitReady(keyA, ready(), current, 'goal-A')
    ok(commit.ok === true && commit.replayed === false, '就绪提交成功')
    ok(commit.goal.phase === 'executing' && commit.goal.revision === 1, '转移后目标进入 executing / rev1')
    ok(commit.result.mode === 'standard', '转移的另一半是把模式切标准')
    ok(commit.result.understanding.acceptance === '点一下能下载 CSV', '转移结果带回理解摘要（要显示给用户看）')

    const file = join(root, service.GOAL_FILE_NAME)
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    ok(!!onDisk.entries, '提交返回前已经落盘（先落盘再续行的前提）')
    const persistedKeys = Object.keys(onDisk.entries)
    ok(persistedKeys.length === 1, '磁盘上只有这一条会话记录')
    ok(onDisk.entries[persistedKeys[0]].goal.phase === 'executing', '磁盘上的阶段也是 executing')

    /*
     * 幂等：这正是最容易写错的地方 —— 重放时模式 revision 已经因为**这次转移**
     * 变了，如果先校验后查幂等，模型重试会收到「模式已过期」，看起来像失败。
     */
    const replay = await store.commitReady(keyA, ready(), { modeRevision: 9, goalRevision: 1 }, 'goal-A')
    ok(replay.ok === true && replay.replayed === true, '同一 transitionId 重放 → 返回已提交结果（不报过期）')
    ok(replay.goal.revision === 1, '重放不推进 revision（转移只发生一次）')

    const stale = await store.commitReady(keyA, ready({ transitionId: 'tr-2', modeRevision: 2 }), current, 'goal-A')
    ok(stale.ok === false && stale.code === 'stale_mode', '换了 id 但模式已过期 → 拒，且带上当前状态')
    ok(stale.goal.revision === 1, '被拒时返回当前目标（模型据此纠正）')

    /* 多会话隔离：A 的提交不能动 B */
    ok(store.state(keyB).revision === 0, 'B 会话不受 A 影响')
    const commitB = await store.commitReady(keyB, ready({ transitionId: 'tr-b' }), current, 'goal-B')
    ok(commitB.ok === true && commitB.goal.goalId === 'goal-B', 'B 会话独立提交')
    ok(store.state(keyA).revision === 1, 'B 的提交没推进 A')

    /* 报告：完成要证据、blocked 要说原因 */
    const needEvidence = await store.report(keyA, {
      reportId: 'rp-x',
      phase: 'completed',
      goalRevision: 1
    })
    ok(needEvidence.ok === false && needEvidence.code === 'completed_needs_evidence', '存储层也守住「完成要证据」')

    const done = await store.report(keyA, {
      reportId: 'rp-ok',
      phase: 'completed',
      goalRevision: 1,
      evidence: ['npm run test:unit 2879/2879']
    })
    ok(done.ok === true && done.goal.phase === 'completed' && done.goal.revision === 2, '完成报告生效并推进 revision')
    const doneReplay = await store.report(keyA, {
      reportId: 'rp-ok',
      phase: 'completed',
      goalRevision: 1,
      evidence: ['npm run test:unit 2879/2879']
    })
    ok(doneReplay.ok === true && doneReplay.replayed === true, '同一 reportId 重放不推进')

    /* 停止：用户动作（在仍在执行的会话上），完成后不允许被停止覆盖 */
    const stopped = await store.stop(keyB, null)
    ok(stopped?.phase === 'stopped', '用户停止落 stopped')
    ok(store.state(keyA).phase === 'completed', '已完成的目标不因停止回退（完成是终态）')
    const afterStop = await store.report(keyB, { reportId: 'rp-after-stop', phase: 'executing', goalRevision: 1 })
    ok(afterStop.ok === false && afterStop.code === 'stale_goal', '停止后旧 revision 的报告被拒（不假装还在跑）')

    /* 脏 JSON 不能让整份文档作废 */
    await writeFile(file, '{ 这不是 JSON', 'utf8')
    const store2 = new service.GoalStore({ root })
    await store2.load()
    ok(store2.state(keyA).phase === 'planning', '坏 JSON → 空目标（不抛、不把界面弄挂）')

    /* 落盘失败必须抛（不能报成功）：用一个占位目录顶掉文件名 */
    const rootBad = await mkdtemp(join(tmpdir(), 'yan-goal-bad-'))
    try {
      const badStore = new service.GoalStore({ root: rootBad })
      await badStore.load()
      /* 先把 goals.json 变成一个目录 → rename 一定失败 */
      const { mkdir } = await import('node:fs/promises')
      await mkdir(service.goalDocumentPath(rootBad), { recursive: true })
      let threw = false
      try {
        await badStore.commitReady(keyA, ready(), current, 'g')
      } catch {
        threw = true
      }
      ok(threw, '落盘失败时抛错（「先落盘再续行」不能变成「假装落盘」）')
      ok(badStore.state(keyA).revision === 0, '落盘失败后内存态回退，不留下假状态')
    } finally {
      await rm(rootBad, { recursive: true, force: true })
    }

    const stats = await stat(file)
    ok(stats.isFile(), 'goals.json 是文件（原子替换写入）')

    /* --------------------------------------------------- 续行（S3b） */

    const rootResume = await mkdtemp(join(tmpdir(), 'yan-goal-resume-'))
    try {
      const rs = new service.GoalStore({ root: rootResume, now: () => 6000 })
      await rs.load()
      const keyR = 'C:/tmp/sessions/r.jsonl'
      const r1 = await rs.commitReady(keyR, ready({ transitionId: 'tr-r1' }), current, 'goal-R')
      ok(r1.ok === true, '就绪提交成功（续行用例）')
      const resume = rs.resumeOf(keyR)
      ok(!!resume && resume.operationId === 'tr-r1', '提交后留下未消费的续行记录（就是那个 transitionId）')
      ok(String(resume?.summary ?? '').includes('验收'), '续行正文带回理解摘要（模型在控制消息里看到的就是它）')

      const docR = JSON.parse(await readFile(join(rootResume, service.GOAL_FILE_NAME), 'utf8'))
      const entryR = Object.values(docR.entries)[0]
      ok(entryR?.resume?.operationId === 'tr-r1', '续行与转移**同一次落盘**（不是两步）')

      ok(
        shared.shouldResume(resume, null) === true,
        'shouldResume：有记录、没消费过 → 该发'
      )
      ok(
        shared.shouldResume(resume, 'tr-r1') === false,
        'shouldResume：同一个 operationId 已消费 → 不重发（不盲发两次）'
      )
      ok(
        shared.shouldResume(resume, 'tr-other') === false || shared.shouldResume(resume, 'tr-other') === true,
        'shouldResume：别的 id 不影响本条的判断'
      )
      ok(shared.shouldResume(null, null) === false, 'shouldResume：没有记录 → 不发')
      ok(
        shared.shouldResume({ operationId: 'tr-x', at: 0, summary: '   ' }, null) === false,
        'shouldResume：正文为空 → 不发（发出去毫无意义）'
      )

      /* 用户停止 / 用户改档 → 抦销未发续行 */
      await rs.clearResume(keyR)
      ok(rs.resumeOf(keyR) === null, 'clearResume 后内存里没有待发续行')
      const afterClear = JSON.parse(await readFile(join(rootResume, service.GOAL_FILE_NAME), 'utf8'))
      ok(
        Object.values(afterClear.entries)[0]?.resume === null,
        'clearResume 落了盘（不然重启后它会又冒出来）'
      )

      const r2 = await rs.commitReady(
        keyR,
        ready({ transitionId: 'tr-r2', goalRevision: 1 }),
        { modeRevision: 3, goalRevision: 1 },
        'goal-R'
      )
      ok(r2.ok === true && rs.resumeOf(keyR)?.operationId === 'tr-r2', '再提交一次会有新的续行记录')
      await rs.stop(keyR, null)
      ok(rs.state(keyR).phase === 'stopped', '用户停止 → 目标 stopped')
      ok(rs.resumeOf(keyR) === null, '用户停止优先：未发出的续行一并作废（§5）')
    } finally {
      await rm(rootResume, { recursive: true, force: true })
    }

    /* 给薄层看的快照：用 runnerId 命名，扩展只认这个 */
    const rootSnap = await mkdtemp(join(tmpdir(), 'yan-goal-snap-'))
    try {
      const snapPath = service.goalResumeSnapshotPath('r1', rootSnap)
      await service.writeGoalResumeSnapshot(
        'r1',
        { operationId: 'tr-snap', at: 123, summary: '正文' },
        rootSnap
      )
      const written = JSON.parse(await readFile(snapPath, 'utf8'))
      ok(written.operationId === 'tr-snap' && written.summary === '正文', '快照写 operationId 与正文（扩展据此判断）')
      ok(written.kind === 'ready', '快照缺 kind 时写 ready（旧调用点的行为不变）')
      await service.writeGoalResumeSnapshot(
        'r1',
        { operationId: 'tr-cont', at: 124, summary: '继续', kind: 'continue' },
        rootSnap
      )
      const contWritten = JSON.parse(await readFile(snapPath, 'utf8'))
      ok(
        contWritten.kind === 'continue' && contWritten.operationId === 'tr-cont',
        '快照带 kind（薄层据此选消息标签 yan-goal-continue）'
      )
      await service.writeGoalResumeSnapshot('r1', null, rootSnap)
      const cleared = JSON.parse(await readFile(snapPath, 'utf8'))
      ok(cleared.operationId === null, '抦销写空记录（而不是删文件：排障时要能区分「从没写过」）')
      ok(
        !service.goalResumeSnapshotPath('r1', rootSnap).includes('pending'),
        '快照路径按 runnerId 命名（不带 pending: 前缀）'
      )

      await service.writeGoalResumeSnapshot(
        'r1',
        { operationId: 'tr-pending', at: 125, summary: '已有续行', kind: 'continue' },
        rootSnap
      )
      const overwritten = await service.writeGoalResumeSnapshotIfVacant(
        'r1',
        { operationId: 'acq-new', at: 126, summary: '能力接入续行', kind: 'continue' },
        rootSnap
      )
      ok(overwritten === false, '能力续接：不覆盖另一个尚未消费的目标续行')
      ok(JSON.parse(await readFile(snapPath, 'utf8')).operationId === 'tr-pending', '拒绝覆盖后原续行仍保留')
      ok(
        await service.clearGoalResumeSnapshotIfOperation('r1', 'acq-new', rootSnap) === false,
        '能力续接清理：operationId 不匹配时不清空其他请求'
      )
      const receiptPath = service.goalResumeConsumedPath('r1', rootSnap)
      await writeFile(receiptPath, JSON.stringify({ operationId: 'tr-pending' }), 'utf8')
      const replacedConsumed = await service.writeGoalResumeSnapshotIfVacant(
        'r1',
        { operationId: 'acq-new', at: 127, summary: '能力接入续行', kind: 'continue' },
        rootSnap
      )
      ok(replacedConsumed === true, '前一续行已有消费凭据后可安全复用单槽')
      ok(JSON.parse(await readFile(snapPath, 'utf8')).operationId === 'acq-new', '复用单槽后当前 operationId 是新事务')
      ok(
        await service.goalResumeContinuationWasConsumed('r1', 'tr-pending', rootSnap),
        '消费证据按精确 continueId 查询'
      )
      ok(
        await service.clearGoalResumeSnapshotIfOperation('r1', 'acq-new', rootSnap),
        '匹配当前 operationId 时允许清理自己的续行'
      )
    } finally {
      await rm(rootSnap, { recursive: true, force: true })
    }

    /* ------------------------------------------- 自主档连续续接（S3c） */

    const rootAuto = await mkdtemp(join(tmpdir(), 'yan-goal-auto-'))
    try {
      const auto = new service.GoalStore({ root: rootAuto, now: () => 7000 })
      await auto.load()
      const keyC = 'C:/tmp/sessions/c.jsonl'

      const notYet = await auto.armContinue(keyC)
      ok(
        notYet.armed === false && notYet.reason === 'not_active',
        '没报告过目标就不 arm（否则自主档里一场普通对话会被无限叫醒）'
      )

      const repC = await auto.report(keyC, {
        reportId: 'rp-c1',
        phase: 'executing',
        goalRevision: 0,
        steps: [{ title: '第一步', status: 'pending' }]
      })
      ok(repC.ok === true, '自主档报告进展成功（S3c 起点）')

      const first = await auto.armContinue(keyC)
      ok(first.armed === true && first.round === 1, '报告后 arm 第 1 次续接')
      const resumeC = auto.resumeOf(keyC)
      ok(resumeC?.kind === 'continue', 'arm 出来的是「接着干」续行（不是就绪续行）')
      ok(String(resumeC?.summary ?? '').includes('第 1 次'), '续行正文带本轮序号')

      /* 用户没插话：连续 arm 到上限 */
      let armedTimes = 1
      let lastArm = first
      for (let i = 0; i < shared.AUTONOMOUS_CONTINUE_LIMIT + 2; i++) {
        lastArm = await auto.armContinue(keyC)
        if (lastArm.armed) armedTimes += 1
      }
      ok(
        armedTimes === shared.AUTONOMOUS_CONTINUE_LIMIT,
        `连续续接最多 ${shared.AUTONOMOUS_CONTINUE_LIMIT} 次（实际 ${armedTimes}）`
      )
      ok(lastArm.armed === false && lastArm.reason === 'limit', '到上限后不再 arm（宿主据此让模型停下来交代）')

      /* 用户说话了 → 计数归零，重新给满额度 */
      await auto.resetAutoContinues(keyC)
      const again = await auto.armContinue(keyC)
      ok(again.armed === true && again.round === 1, '用户介入后重新计数（有人看管时不必限轮）')

      /* 目标完成：未发的续行必须清掉 */
      const doneC = await auto.report(keyC, {
        reportId: 'rp-c2',
        phase: 'completed',
        goalRevision: auto.state(keyC).revision,
        evidence: ['npm run test:unit 全绿']
      })
      ok(doneC.ok === true && doneC.goal.phase === 'completed', '目标完成')
      ok(auto.resumeOf(keyC) === null, '完成后清掉未发续行（不许在目标完成后再把模型叫起来）')
      ok((await auto.armContinue(keyC)).reason === 'not_active', '完成后的目标不再 arm')

      /* 用户停止同样是终态 */
      const keyD = 'C:/tmp/sessions/d.jsonl'
      await auto.report(keyD, { reportId: 'rp-d1', phase: 'executing', goalRevision: 0 })
      await auto.armContinue(keyD)
      ok(auto.resumeOf(keyD)?.kind === 'continue', 'arm 之后有续行（停止用例前置）')
      await auto.stop(keyD, null)
      ok(auto.resumeOf(keyD) === null, '用户停止：未发的续行一并作废')
      ok((await auto.armContinue(keyD)).reason === 'not_active', '已停止的目标不再 arm')
    } finally {
      await rm(rootAuto, { recursive: true, force: true })
    }

    /* 旧文件兼容：S3c 之前的 goals.json 没有 kind / autoContinues */
    const rootOld = await mkdtemp(join(tmpdir(), 'yan-goal-old-'))
    try {
      const keyOld = 'C:/tmp/sessions/old.jsonl'
      await writeFile(
        join(rootOld, service.GOAL_FILE_NAME),
        JSON.stringify({
          version: 1,
          entries: {
            [keyOld]: {
              goal: {
                goalId: 'g-old',
                phase: 'executing',
                revision: 2,
                steps: [],
                evidence: [],
                blocker: null,
                failure: null,
                updatedAt: 1
              },
              transitions: {},
              reports: {},
              resume: { operationId: 'tr-old', at: 1, summary: '旧记录' },
              updatedAt: 1
            }
          }
        }),
        'utf8'
      )
      const oldStore = new service.GoalStore({ root: rootOld })
      await oldStore.load()
      ok(oldStore.resumeOf(keyOld)?.kind === 'ready', 'S3c 之前的记录（没有 kind）读进来还是就绪续行')
      const oldArmed = await oldStore.armContinue(keyOld)
      ok(oldArmed.armed === true && oldArmed.round === 1, '旧文件（没有 autoContinues）从 0 开始计数')
    } finally {
      await rm(rootOld, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
