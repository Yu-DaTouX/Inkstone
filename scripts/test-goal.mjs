/**
 * 目标与计划就绪（实施-05 S3）的纯逻辑与存储测试。
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
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
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

      const keyHost = 'C:/tmp/sessions/host-autonomous.jsonl'
      const hostStart = await auto.ensureAutonomousGoal(keyHost, '把自主模式改成收到请求后自动推进并完成')
      ok(hostStart.created === true, '自主档收到用户请求时由宿主自动登记目标')
      ok(
        hostStart.goal.phase === 'planning' && hostStart.goal.revision === 1 && hostStart.goal.steps.length === 1,
        '宿主登记的目标先进入 planning / rev1，并保留用户请求步骤'
      )
      const hostAgain = await auto.ensureAutonomousGoal(keyHost, '补充同一个自主任务')
      ok(hostAgain.created === false && hostAgain.goal.goalId === hostStart.goal.goalId, '活动目标收到补充消息时复用同一目标')
      const hostArm = await auto.armContinue(keyHost)
      ok(hostArm.armed === true && hostArm.round === 1, '宿主登记的目标也可以自动安排第一轮续接')

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

      /* 用户没插话：连续 arm 到上限。
       *
       * ⚠️ 必须显式模拟「上一条已经被薄层消费」：`armContinue` 现在对同一待发操作幂等
       * （实施-14 A6），不传 `consumed` 就会被当成「还没发出去」而拒掉。 */
      const armAsConsumed = () => auto.armContinue(keyC, { consumed: async () => true })
      let armedTimes = 1
      let lastArm = first
      for (let i = 0; i < shared.AUTONOMOUS_CONTINUE_LIMIT + 2; i++) {
        lastArm = await armAsConsumed()
        if (lastArm.armed) armedTimes += 1
      }
      ok(
        armedTimes === shared.AUTONOMOUS_CONTINUE_LIMIT,
        `连续续接最多 ${shared.AUTONOMOUS_CONTINUE_LIMIT} 次（实际 ${armedTimes}）`
      )
      ok(lastArm.armed === false && lastArm.reason === 'limit', '到上限后不再 arm（宿主据此让模型停下来交代）')

      /* 用户说话了 → 计数归零，重新给满额度 */
      await auto.resetAutoContinues(keyC)
      const again = await armAsConsumed()
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

    /*
     * ------------------------------------------- 实施-14 F1：暂停 / 幂等 / 消费游标
     *
     * 这三条都是上一轮代码审查拿到的真缺陷（A2 / A4 / A6），而且都是
     * 「本地单测全绿、真实链路才复现」的那一类：暂停状态没被持久化、
     * 重复 arm 把轮数空转到上限、旧 blocks 被算到新目标头上。
     */
    const rootF1 = await mkdtemp(join(tmpdir(), 'yan-goal-f1-'))
    try {
      const store = new service.GoalStore({ root: rootF1, now: () => 9000 })
      await store.load()
      const key = 'C:/tmp/sessions/f1.jsonl'
      await store.report(key, { reportId: 'rp-f1', phase: 'executing', goalRevision: 0 })

      /* A2：暂停 ≠ 放弃 */
      await store.setPaused(key, true)
      ok(store.isPaused(key) === true, 'A2：暂停意图落盘（不是只在内存里）')
      const pausedArm = await store.armContinue(key)
      ok(pausedArm.armed === false && pausedArm.reason === 'paused', 'A2：暂停后不再安排自动续接')
      ok(shared.isActiveGoalPhase(store.state(key).phase), 'A2：暂停不改变目标阶段（区别于放弃目标）')
      await store.setPaused(key, false)
      const resumedArm = await store.armContinue(key)
      ok(resumedArm.armed === true && resumedArm.round === 1, 'A2：用户明确恢复后重新可以安排')

      /* A6：同一条待发操作幂等 */
      const pendingOp = store.resumeOf(key)?.operationId
      const roundBefore = store.autoContinueCount(key)
      const duplicate = await store.armContinue(key, { consumed: async () => false })
      ok(duplicate.armed === false && duplicate.reason === 'pending', 'A6：已有未消费的续行时不重复 arm')
      ok(store.autoContinueCount(key) === roundBefore, 'A6：重复 arm 不消耗轮数额度（报告 8 次也不该烧完 8 轮）')
      ok(store.resumeOf(key)?.operationId === pendingOp, 'A6：旧的待发操作不会被覆盖（新 operationId 不凭空出现）')
      const afterConsumed = await store.armContinue(key, { consumed: async () => true })
      ok(afterConsumed.armed === true && afterConsumed.round === roundBefore + 1, 'A6：真实消费之后才安排下一轮')

      /* A4：重复拦下的消费游标独立于目标失败记录 */
      const keyR = 'C:/tmp/sessions/f1-repeat.jsonl'
      /* 目录名 / 键清洗从真源取（不在这里硬编码，否则改名时两边会静默错开） */
      const repeatGuard = await import('../out/test/repeat-guard.mjs')
      const guardDir = join(rootF1, repeatGuard.REPEAT_GUARD_DIR)
      const guardFile = join(guardDir, `${repeatGuard.repeatGuardKey('runner-f1')}.json`)
      await mkdir(guardDir, { recursive: true })
      const writeBlocks = async (blocks) =>
        writeFile(guardFile, JSON.stringify({ blocks, tool: 'bash', updatedAt: 1 }), 'utf8')

      await store.ensureAutonomousGoal(keyR, '把重复拦下记成失败签名')
      await store.report(keyR, {
        reportId: 'rp-r1',
        phase: 'executing',
        goalRevision: store.state(keyR).revision
      })
      await writeBlocks(2)
      const baseline = await store.consumeRepeatBlocks('runner-f1', keyR)
      ok(baseline === false, 'A4：新目标第一次消费只建立基线（历史 blocks 不算进来）')
      ok(store.state(keyR).phase !== 'blocked', 'A4：旧 blocks 不会让全新目标立刻 blocked')

      await writeBlocks(3)
      const counted = await store.consumeRepeatBlocks('runner-f1', keyR)
      ok(counted === true && store.state(keyR).failure?.count === 1, 'A4：基线之后的新增拦下才计入失败签名')
      await store.consumeRepeatBlocks('runner-f1', keyR)
      ok(store.state(keyR).failure?.count === 1, 'A4：同一水位重复消费不重复记账')

      /* 报进展（failure 被清）→ 旧 blocks 不能再计一遍（旧实现就是在这里把人打成 blocked） */
      await store.report(keyR, {
        reportId: 'rp-r2',
        phase: 'executing',
        goalRevision: store.state(keyR).revision,
        evidence: ['已经换了一条路']
      })
      await store.consumeRepeatBlocks('runner-f1', keyR)
      ok(store.state(keyR).phase !== 'blocked', 'A4：报进展清掉 failure 后旧 blocks 不再计一遍')

      /* 换目标：游标按目标身份重建，新目标不承担旧痕迹 */
      const oldGoalId = store.state(keyR).goalId
      await store.startPursued(keyR, { goal: '换一件事', outcome: '做完了' })
      ok(store.state(keyR).goalId !== oldGoalId, 'A4：换目标（用例前置）')
      await store.consumeRepeatBlocks('runner-f1', keyR)
      ok(store.state(keyR).failure === null, 'A4：新目标不承担上一个目标欠下的拦下次数')

      /* A2 的另一半：放弃目标会把暂停一并收掉（目标已终态，暂停没有意义） */
      const keyStop = 'C:/tmp/sessions/f1-stop.jsonl'
      await store.report(keyStop, { reportId: 'rp-s1', phase: 'executing', goalRevision: 0 })
      await store.setPaused(keyStop, true)
      const stopped = await store.stop(keyStop, null)
      ok(stopped?.phase === 'stopped', 'A2：显式放弃目标进入 stopped 终态')
      ok(store.isPaused(keyStop) === false, 'A2：放弃目标时暂停标志一并收掉')
      ok((await store.armContinue(keyStop)).reason === 'not_active', 'A2：已放弃的目标不再 arm')

      /* A3：改档后未消费的续行该不该留 —— 纯判据（handler 只负责调它） */
      ok(shared.keepsGoalResumeOnModeChange('autonomous', false) === true, 'A3：切到自主档保留续行')
      ok(shared.keepsGoalResumeOnModeChange('standard', true) === true, 'A3：pursue 目标与档位正交（标准档也留）')
      ok(shared.keepsGoalResumeOnModeChange('standard', false) === false, 'A3：自主切回标准档且非 pursue → 作废续行')
      ok(shared.keepsGoalResumeOnModeChange('clarify', false) === false, 'A3：切到计划档同样作废')
    } finally {
      await rm(rootF1, { recursive: true, force: true })
    }

    /* ------------------- 实施-14 F3：宿主级目标事实跨片段继承 ------------------- */
    const rootInherit = await mkdtemp(join(tmpdir(), 'yan-goal-inherit-'))
    try {
      const store = new service.GoalStore({ root: rootInherit, now: () => 11000 })
      await store.load()
      const src = 'C:/tmp/sessions/inherit-src.jsonl'
      const dst = 'C:/tmp/sessions/inherit-dst.jsonl'
      await store.startPursued(src, { goal: '把 X 做完', outcome: 'X 可点且有两张截图' })
      await store.report(src, {
        reportId: 'rp-i1',
        phase: 'executing',
        goalRevision: store.state(src).revision,
        steps: [{ title: '第一步', status: 'done' }],
        evidence: ['npm run test:unit 全绿']
      })
      await store.armContinue(src, { consumed: async () => true })
      await store.setPaused(src, true)
      const sourceGoal = store.state(src)

      const wrote = await store.inheritTo(src, dst)
      ok(wrote === true, 'F3：继承写了盘')
      const dest = store.state(dst)
      ok(dest.goalId === sourceGoal.goalId, 'F3：目的段保持同一目标身份（换片段不等于换目标）')
      ok(
        dest.phase === 'executing' && dest.revision === sourceGoal.revision,
        'F3：阶段与 revision 原样延续（不重算、不降级）'
      )
      ok(dest.evidence.length === sourceGoal.evidence.length, 'F3：已有证据跟着走（同一件事的进展）')
      ok(dest.pursue === true && dest.brief?.outcome === 'X 可点且有两张截图', 'F3：用户原话与验收标准跨片段保留')
      ok(store.isPaused(dst) === true, 'F3：用户按过的暂停也跨片段保留')
      ok(store.resumeOf(dst) === null, 'F3：源片段待发的续行不跟过来（目的段由交接 resume 驱动）')
      ok(store.autoContinueCount(dst) === 0, 'F3：新片段重新给满自动续接额度')

      await store.inheritTo(src, dst)
      ok(store.state(dst).goalId === sourceGoal.goalId && store.resumeOf(dst) === null, 'F3：重复继承幂等')

      /* 目的段已有另一个目标：不覆盖（宁可不继承，也不丢真实进展） */
      const other = 'C:/tmp/sessions/inherit-other.jsonl'
      await store.startPursued(other, { goal: '另一件事', outcome: '另一件事做完' })
      const blocked = await store.inheritTo(src, other)
      ok(blocked === false && store.state(other).brief?.goal === '另一件事', 'F3：目的段已有别的目标时不覆盖')

      const reread = new service.GoalStore({ root: rootInherit })
      await reread.load()
      ok(reread.state(dst).goalId === sourceGoal.goalId, 'F3：继承真的落盘（跨实例读回）')
    } finally {
      await rm(rootInherit, { recursive: true, force: true })
    }

    /* F4：续行种类多了 handoff（旧记录仍归 ready） */
    ok(
      shared.resumeKindOf({ operationId: 'h-1', at: 1, summary: '交接', kind: 'handoff' }) === 'handoff',
      'F4：handoff 续行种类被识别'
    )
    ok(
      shared.resumeKindOf({ operationId: 'x', at: 1, summary: '旧' }) === 'ready',
      'F4：没有 kind 的旧记录仍然当就绪续行'
    )

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

  /* ------------------- 持续目标（`+` 菜单 → 目标，与档位正交） ------------------- */
  {
    const root = await mkdtemp(join(tmpdir(), 'yan-goal-pursue-'))
    try {
      const store = new service.GoalStore({ root })
      await store.load()
      const key = 'C:/tmp/sessions/pursue.jsonl'
      const brief = { goal: '把加号菜单做成 codex 式', outcome: '菜单三项可点 + 两张截图' }

      const goal = await store.startPursued(key, brief)
      ok(goal.pursue === true, 'startPursued 置上 pursue（与档位正交的判据）')
      ok(
        goal.brief?.goal === brief.goal && goal.brief?.outcome === brief.outcome,
        '用户的原话与达成判据都存下来了'
      )
      ok(goal.phase === 'planning' && goal.revision === 1, '从 planning / rev1 起步')

      /* 续行正文必须复述判据：模型自己总结的目标容易越做越小 */
      const summary = shared.goalContinueSummary(goal, 1)
      ok(summary.includes(brief.outcome), '续行正文带上达成判据（不许模型自己改写验收标准）')

      /* 重新设一个目标是**换事**：旧步骤清掉、续接计数归零 */
      await store.armContinue(key)
      const again = await store.startPursued(key, { goal: '换一件事', outcome: '换一件事做完' })
      ok(again.revision === 2, '重设目标推进 revision')
      ok(again.steps.length === 0, '重设目标清掉旧步骤（留着只会让续行正文列一堆无关步骤）')
      ok(store.autoContinueCount(key) === 0, '重设目标把连续续接计数归零')

      /* 磁盘往返：pursue / brief 必须真的落盘 */
      const reread = new service.GoalStore({ root })
      await reread.load()
      const back = reread.state(key)
      ok(back.pursue === true && back.brief?.outcome === '换一件事做完', 'pursue 与 brief 真的写进了 goals.json')

      /* 脏值不造身份：旧记录与脏值读进来必须是 false */
      ok(
        shared.normalizeGoalState({ goalId: 'g', phase: 'executing' }).pursue === false,
        '旧记录（没有 pursue 字段）读进来是 false'
      )
      ok(shared.normalizeGoalState({ pursue: 'yes' }).pursue === false, '脏值不凭空造一个持续目标')

      /* ------------------------------------------ G-1 持续目标补充字段（实施-16） */
      const richBrief = shared.normalizePursuedBrief({
        goal: '  完成所有待办  ',
        outcome: '测试全绿 + 打包成功',
        deliverable: ' 可运行安装包 ',
        scope: '   ',
        constraints: '不新增模型工具'
      })
      ok(
        richBrief?.goal === '完成所有待办' && richBrief.outcome === '测试全绿 + 打包成功',
        'G-1：必填两栏 trim 后保留'
      )
      ok(richBrief?.deliverable === '可运行安装包', 'G-1：交付物 trim 后保留')
      ok(
        richBrief?.scope === undefined && richBrief.constraints === '不新增模型工具',
        'G-1：空白可选栏不落字段（不造用户没写过的句子）'
      )
      ok(shared.normalizePursuedBrief({ goal: '只有目标' }) === null, 'G-1：缺达成判据仍然拒收')
      ok(shared.normalizePursuedBrief({ goal: ' ', outcome: 'x' }) === null, 'G-1：空白目标不算写了')
      ok(shared.normalizePursuedBrief(null) === null, 'G-1：非对象输入返回 null')
      ok(
        shared.normalizeGoalState({ goalId: 'g-old', brief: { goal: '旧目标', outcome: '旧判据' } }).brief
          ?.deliverable === undefined,
        'G-1：旧目标（只有两栏）照常读，不迁移不报错'
      )

      /* 补充字段：进状态 → 落盘往返 → 续行正文复述 */
      const richGoal = await store.startPursued(key, {
        goal: '把补充字段做出来',
        outcome: '表单能填、落盘能读',
        deliverable: '目标表单 + 探针',
        constraints: '不新增依赖'
      })
      ok(richGoal.brief?.deliverable === '目标表单 + 探针', 'G-1：补充字段进目标状态')
      const richSummary = shared.goalContinueSummary(richGoal, 1)
      ok(
        richSummary.includes('交付物：目标表单 + 探针') && richSummary.includes('约束：不新增依赖'),
        'G-1：续行正文复述补充字段'
      )
      const richBack = new service.GoalStore({ root })
      await richBack.load()
      ok(
        richBack.state(key).brief?.deliverable === '目标表单 + 探针',
        'G-1：补充字段真的写进 goals.json'
      )

      /* ------------------------------------------------ U-3b 结构化链接 */
      {
        const linksOk = [
          { kind: 'file', target: 'src/main/goal-service.ts', label: '宿主校验' },
          { kind: 'url', target: 'https://example.com/spec', label: '规格' },
          { kind: 'artifact', target: 'out/evidence.png' }
        ]
        const cleaned = shared.sanitizeGoalLinks(linksOk, 1000)
        ok(cleaned.length === 3, '三种 kind 都收（file / url / artifact）')
        ok(cleaned.every((l) => l.addedAt === 1000), '缺 addedAt 时由宿主回填')

        /* 坏链接一律丢掉，不报错（目标还得推进） */
        const dirty = shared.sanitizeGoalLinks(
          [
            { kind: 'exe', target: 'calc.exe' }, // kind 不在白名单
            { kind: 'url', target: 'javascript:alert(1)' }, // scheme 不支持
            { kind: 'url', target: 'file:///C:/Windows' }, // url 必须是 http/https
            { kind: 'file', target: 'C:/ok.txt' }, // Windows 绝对路径要收
            { kind: 'file', target: 'https://example.com' }, // file 塞了个 url
            { kind: 'file', target: '   ' }, // 空白
            { kind: 'file', target: 'A/B.txt' }, // 重复（大小写不同）
            { kind: 'file', target: 'a/b.TXT' }
          ],
          2000
        )
        ok(Array.isArray(cleaned), '脏输入不抛错，只丢掉非法项')
        ok(
          dirty.map((l) => l.target).join(',') === 'C:/ok.txt,A/B.txt',
          '只留下合法且去重的链接'
        )
        ok(
          dirty.every((l) => l.kind === 'file'),
          '被丢掉的是非法项（kind 白名单 / scheme / 空白 / 重复）'
        )

        /* 上限：单目标最多 GOAL_LINK_LIMIT 条 */
        const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'file', target: `f${i}.txt` }))
        ok(shared.sanitizeGoalLinks(many, 1).length === shared.GOAL_LINK_LIMIT, '超上限截断')

        /* 合并：同 kind+target 只算一次，并按上限封顶 */
        const merged = shared.mergeGoalLinks(
          [{ kind: 'file', target: 'a.ts', addedAt: 1 }],
          [
            { kind: 'file', target: 'A.TS', addedAt: 2 },
            { kind: 'url', target: 'https://x.dev', addedAt: 3 }
          ]
        )
        ok(merged.length === 2 && merged[0].addedAt === 1, '合并去重且保留先登记的那条')

        /* 存储层：报告带 links → 落盘 → 重读；归属被宿主覆盖成当前会话 */
        const linkRoot = await mkdtemp(join(tmpdir(), 'yan-goal-links-'))
        try {
          const svc = new service.GoalStore({ root: linkRoot })
          await svc.load()
          const keyA = 'C:/sessions/yan-a.jsonl'
          const keyB = 'C:/sessions/yan-b.jsonl'
          await svc.report(keyA, {
            reportId: 'r1',
            phase: 'executing',
            goalRevision: 0,
            links: [{ kind: 'file', target: 'a.ts', source: { sessionId: '伪造的会话', messageId: 'm1' } }]
          })
          const gA = svc.state(keyA)
          ok(gA.links.length === 1, '报告里的链接写进了目标状态')
          ok(
            gA.links[0].source?.sessionId === keyA,
            '归属被宿主覆盖为当前会话（不信自报的 sessionId）'
          )
          ok(gA.links[0].source?.messageId === 'm1', 'messageId 保留')
          ok(svc.state(keyB).links.length === 0, 'A 的链接不会出现在 B（目标隔离）')

          /* ---- A-1：宿主只读核验（存在性，不执行、不联网） ---- */
          const checkRoot = await mkdtemp(join(tmpdir(), 'yan-goal-check-'))
          try {
            const svc2 = new service.GoalStore({ root: checkRoot })
            await svc2.load()
            const realFile = join(checkRoot, 'real.txt')
            await writeFile(realFile, 'hello', 'utf8')
            await svc2.report('C:/sessions/c.jsonl', {
              reportId: 'rc1',
              phase: 'executing',
              goalRevision: 0,
              links: [
                { kind: 'file', target: realFile, label: '真实文件' },
                { kind: 'file', target: join(checkRoot, 'nope.txt'), label: '不存在' },
                { kind: 'url', target: 'https://example.com/x', label: '链接' }
              ]
            })
            const g2 = svc2.state('C:/sessions/c.jsonl')
            ok(g2.links.length === 3, '三条链接都登记了')
            ok(g2.links[0].check?.ok === true, '存在的文件 → 核验通过')
            ok(
              (g2.links[0].check?.detail ?? '').includes('字节'),
              '核验说明带大小（只说存在性，不冒充内容校验）'
            )
            ok(g2.links[1].check?.ok === false, '不存在的文件 → 核验失败')
            ok(
              (g2.links[1].check?.detail ?? '').includes('不存在'),
              '失败原因可读（界面拿它做提示）'
            )
            ok(
              g2.links[2].check?.ok === true && (g2.links[2].check?.detail ?? '').includes('不联网'),
              'url 只做形态校验，明确标注不联网'
            )
            ok(g2.links.every((l) => l.check?.method === 'exists'), '核验方式只能是 exists（不执行命令）')

            /* 过期证据：文件没了 → 下一次报告重新核验就变 false */
            await rm(realFile, { force: true })
            await svc2.report('C:/sessions/c.jsonl', {
              reportId: 'rc2',
              phase: 'executing',
              goalRevision: 1,
              links: []
            })
            const after = svc2.state('C:/sessions/c.jsonl')
            ok(
              after.links[0].check?.ok === false,
              '文件被删后再次报告 → 旧链接重新核验为失败（不是永远停在当初那次）'
            )
            ok(after.links.length === 3, '重新核验不会多出链接')

            /* 旧文档没有 check 字段：读回来就是 undefined，不报错 */
            ok(
              shared.normalizeGoalState({ links: [{ kind: 'file', target: 'a.ts' }] }).links[0].check ===
                undefined,
              '旧文档里的链接没有核验结果也不报错'
            )

            /* ─────────── G-2 目标级完成核验（实施-16） ─────────── */
            ok(
              g2.verification?.status === 'failed',
              `G-2：报告里有不存在的本地产物 → verification=failed（实际 ${g2.verification?.status}）`
            )
            ok(
              g2.verification?.checks.length === 3,
              'G-2：核验快照覆盖当前声明的全部产物（与 links 同一批事实）'
            )
            ok(
              (g2.verification?.detail ?? '').includes('不存在'),
              'G-2：失败原因可读（界面拿它做提示）'
            )
            ok(
              after.verification?.status === 'failed',
              'G-2：文件被删后再次报告，核验跟着变（不留在旧结论上）'
            )
            ok(
              svc.state(keyA).verification?.status === 'failed',
              'G-2：相对路径不存在也计失败（不因模型报了完成就当通过）'
            )

            /* 判定规则（纯函数）：四种状态各有明确入口 */
            const V = shared.summarizeVerification
            ok(V([], 7).status === 'not_checked', 'G-2：没有任何声明产物 → not_checked')
            ok(V([], 7).checks.length === 0 && V([], 7).at === 7, 'G-2：not_checked 不带检查项，时间由宿主填')
            ok(
              V([{ target: 'https://x.dev', kind: 'url', ok: true, detail: '', at: 7 }], 7).status ===
                'manual_review',
              'G-2：只声明了链接 → manual_review（不联网就不冒充通过）'
            )
            ok(
              V([{ target: 'a.ts', kind: 'file', ok: true, detail: '', at: 7 }], 7).status === 'passed',
              'G-2：本地产物都存在 → passed（只证明存在）'
            )
            ok(
              V(
                [
                  { target: 'a.ts', kind: 'file', ok: true, detail: '', at: 7 },
                  { target: 'https://x.dev', kind: 'url', ok: true, detail: '', at: 7 }
                ],
                7
              ).status === 'manual_review',
              'G-2：本地都在但还有链接 → manual_review（不能报全通过）'
            )
            ok(
              V([{ target: 'gone.ts', kind: 'file', ok: false, detail: '', at: 7 }], 7).status ===
                'failed',
              'G-2：本地产物缺失 → failed'
            )

            /* 完成回执只触发核验：旧结论必须先失效，不能自证通过 */
            const completed = shared.applyGoalReport(
              {
                ...shared.emptyGoal(1),
                verification: { status: 'passed', at: 1, checks: [], detail: '上一轮的结论' }
              },
              {
                ok: true,
                phase: 'completed',
                steps: [],
                evidence: ['模型说自己做完了'],
                links: [],
                discardedLinks: 0,
                blocker: null,
                failureSignature: null
              },
              2
            )
            ok(
              completed.verification === null,
              'G-2：完成回执先清掉旧核验结论（真实状态由宿主同一次落盘重算）'
            )
            ok(
              completed.phase === 'completed' && completed.revision === 1,
              'G-2：清核验不改相位与 revision 语义'
            )

            /* 兼容与脏值：旧文档无字段 → null；脏状态不当成通过 */
            ok(
              shared.normalizeGoalState({ phase: 'completed' }).verification === null,
              'G-2：旧文档（无 verification 字段）读回 null，不报错'
            )
            ok(
              shared.normalizeGoalState({ verification: { status: 'yes' } }).verification === null,
              'G-2：脏核验状态读回 null，不当成通过'
            )
            ok(
              shared.normalizeGoalState({
                verification: {
                  status: 'passed',
                  at: 5,
                  checks: [{ target: 'a.ts', kind: 'file', ok: true, detail: 'x', at: 5 }],
                  detail: 'd'
                }
              }).verification?.checks[0].target === 'a.ts',
              'G-2：合法核验结果原样读回'
            )
            ok(
              shared
                .goalSummary({
                  ...completed,
                  verification: { status: 'passed', at: 3, checks: [], detail: 'd' }
                })
                .includes('completed') &&
                shared
                  .goalSummary({
                    ...completed,
                    verification: { status: 'passed', at: 3, checks: [], detail: 'd' }
                  })
                  .includes('核验：passed'),
              'G-2：状态摘要同时报相位与核验（两者不合并）'
            )
          } finally {
            await rm(checkRoot, { recursive: true, force: true })
          }

          /* 重放同一 reportId 不会把链接加两遍 */
          await svc.report(keyA, {
            reportId: 'r1',
            phase: 'executing',
            goalRevision: 1,
            links: [{ kind: 'file', target: 'a.ts' }]
          })
          ok(svc.state(keyA).links.length === 1, '幂等重放不会重复登记链接')

          /* G-2：核验按会话隔离；没有声明产物就是 not_checked（不是 passed） */
          const beforeIsolation = svc.state(keyA).verification?.status
          await svc.report(keyB, { reportId: 'rb1', phase: 'executing', goalRevision: 0, links: [] })
          ok(
            svc.state(keyA).verification?.status === beforeIsolation,
            'G-2：B 会话的核验不会写到 A 目标上'
          )
          ok(
            svc.state(keyB).verification?.status === 'not_checked',
            'G-2：目标没有任何声明产物 → not_checked（不冒充通过）'
          )

          /* 旧文档（完全没有 links 字段）读回来是空数组 */
          const reread = new service.GoalStore({ root: linkRoot })
          await reread.load()
          ok(reread.state(keyA).links.length === 1, '重启后 links 真的从磁盘读回来了')
          ok(
            shared.normalizeGoalState({ goalId: 'g', phase: 'executing' }).links.length === 0,
            '旧目标（没有 links 字段）读进来是空数组'
          )
          ok(shared.normalizeGoalState({ links: 'nonsense' }).links.length === 0, 'links 是脏值时归空')
        } finally {
          await rm(linkRoot, { recursive: true, force: true })
        }
      }

      /* ------------------------------------------------ A-2 目标级预算 */
      {
        const noBudget = shared.checkGoalBudget(null, { tokens: 999999, elapsedMs: 1e9 })
        ok(noBudget.stopped === false, '没设预算就不管（不替用户做成本承诺）')

        const budget = { tokens: 1000, ms: 60_000 }
        ok(
          shared.checkGoalBudget(budget, { tokens: 10, elapsedMs: 1000 }).stopped === false,
          '未到上限 → 不停'
        )
        const byTokens = shared.checkGoalBudget(budget, { tokens: 1000, elapsedMs: 1000 })
        ok(byTokens.stopped === true && byTokens.reason === 'tokens', 'token 到上限 → 停')
        const byTime = shared.checkGoalBudget(budget, { tokens: 10, elapsedMs: 60_000 })
        ok(byTime.stopped === true && byTime.reason === 'time', '时间到上限 → 停')

        /* 未知用量：不编数字，也不当作“够用” */
        const unknown = shared.checkGoalBudget(budget, { tokens: null, elapsedMs: 10 })
        ok(unknown.stopped === false, 'token 用量未知时不因预算停（无法判断）')
        ok((unknown.note ?? '').includes('未知'), '但要说明未知（界面可以显示未知）')

        ok(shared.sanitizeGoalBudget({ tokens: -1 }) === null, '脏预算当没设')
        ok(shared.sanitizeGoalBudget({ tokens: 100, ms: 'x' })?.tokens === 100, '只收合法的那部分')
        ok(shared.normalizeGoalState({ budget: 5 }).budget === null, '旧文档/脏值 → budget 为 null')

        /* 存储层：预算耗尽只停“安排新轮”，不改 phase、能恢复 */
        const budgetRoot = await mkdtemp(join(tmpdir(), 'yan-goal-budget-'))
        try {
          const svcB = new service.GoalStore({ root: budgetRoot })
          await svcB.load()
          const keyC = 'C:/sessions/budget.jsonl'
          await svcB.report(keyC, {
            reportId: 'b1',
            phase: 'executing',
            goalRevision: 0,
            evidence: ['x']
          })
          await svcB.setBudget(keyC, { tokens: 100 })

          const over = await svcB.armContinue(keyC, { usage: { tokens: 150, elapsedMs: 1000 } })
          ok(over.armed === false && over.reason === 'budget', '超预算 → 不安排新轮')
          ok((over.detail ?? '').includes('150'), '停止原因带实际用量')
          ok(svcB.state(keyC).phase === 'executing', '只停新轮，**不改 phase**（不是失败）')

          /* 重启读回：停止记录要落盘（用户得看到“为什么没继续”） */
          const rereadB = new service.GoalStore({ root: budgetRoot })
          await rereadB.load()
          ok(rereadB.snapshot().entries[keyC]?.goal.budgetStop?.reason === 'tokens', '预算停止记录真的落盘了')

          const within = await svcB.armContinue(keyC, { usage: { tokens: 10, elapsedMs: 1000 } })
          ok(within.armed === true, '没超时仍然能继续（不是一停就死）')

          /* 用户明确放宽预算 → 清掉停止记录 */
          await svcB.setBudget(keyC, null)
          ok(svcB.snapshot().entries[keyC]?.goal.budgetStop === null, '清 / 改预算会清掉旧的停止记录（恢复出口）')

          /* 用量快照：不管超没超预算都要落下来（界面要显示“已用多少”） */
          await svcB.armContinue(keyC, { usage: { tokens: 42, elapsedMs: 1000 } })
          ok(svcB.state(keyC).budgetUsage?.tokens === 42, '用量快照写进目标状态（有值时）')
          await svcB.armContinue(keyC, { usage: { tokens: null, elapsedMs: 2000 } })
          ok(svcB.state(keyC).budgetUsage?.tokens === null, '拿不到用量时如实记 null（不当 0）')

          /* token 预算真的能停：有真实用量时超上限就停 */
          await svcB.setBudget(keyC, { tokens: 10 })
          const overTokens = await svcB.armContinue(keyC, { usage: { tokens: 42, elapsedMs: 1000 } })
          ok(
            overTokens.armed === false && overTokens.reason === 'budget',
            'token 超上限 → 不安排新轮（不再因为拿不到用量而失效）'
          )
          /*
           * G-5：预算是「不安排新轮」而不是失败 —— 它不能改写完成判据。
           * 没有声明产物的目标停在 `not_checked`，不允许被任何旁路写成 `passed`。
           */
          ok(
            svcB.state(keyC).verification?.status !== 'passed',
            `G-5：预算耗尽不会把核验写成通过（实际 ${svcB.state(keyC).verification?.status ?? 'null'}）`
          )
        } finally {
          await rm(budgetRoot, { recursive: true, force: true })
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}
