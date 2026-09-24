/*
 * 目标浮层（实施-12 U-3a，cost 0 fixture）。
 *
 * 只验证**展示与状态**：入口/浮层开闭、各相位、完成数、空标题/超长标题/emoji、
 * 加载失败与重试、点击查看不创建也不停止目标。真实自主执行是另一条（需额度），
 * 这里不冒充。
 *
 * ⚠️ `GoalContent` 挂载时会 `loadGoal()`（真实使用要拉会话目标）。fixture 里
 * 它会把注入的假目标冲掉，所以**先开浮层等它落定，再注入目标**。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => document.querySelector(sel)
  const st = () => window.__yanStore.getState()

  const goalOf = (phase, over = {}) => ({
    goalId: 'fixture-goal',
    phase,
    revision: 2,
    steps: [
      { title: '确认问题', status: 'done' },
      { title: '执行修改', status: phase === 'completed' ? 'done' : 'running' },
      { title: '汇报结果', status: 'pending' }
    ],
    evidence: ['证据一'],
    links: [],
    blocker: null,
    readyApproval: 'automatic',
    pendingReady: null,
    failure: null,
    updatedAt: Date.now(),
    ...over
  })

  /** 打开浮层、等 loadGoal 落定、再注入目标，避免假目标被真实 IPC 冲掉 */
  const openWith = async (goal) => {
    st().setGoalPopoverOpen(true)
    await sleep(400)
    window.__yanStore.setState({ goal, goalError: null })
    await sleep(120)
  }

  try {
    for (let i = 0; i < 80; i++) {
      if (st().conn === 'ready' && st().settings) break
      await sleep(500)
    }

    const entry = q('[data-testid="goal-entry"]')
    ok(!!entry, '标题栏有目标入口')
    ok(!q('[data-testid="goal-panel"]'), '默认不开浮层（入口只占一行）')

    entry?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(300)
    ok(!!q('[data-testid="goal-popover"]'), '点击入口打开浮层')
    ok(!!q('[data-testid="goal-panel"]'), '浮层里渲染只读目标内容')
    st().setGoalPopoverOpen(false)
    await sleep(200)
    ok(!q('[data-testid="goal-popover"]'), '关闭浮层')

    /* 各相位：入口的 phase 属性与完成数都要对（入口一直挂着，不涉及 loadGoal） */
    for (const phase of ['planning', 'executing', 'verifying', 'blocked', 'stopped', 'completed']) {
      window.__yanStore.setState({ goal: goalOf(phase), goalError: null })
      await sleep(60)
      const e = q('[data-testid="goal-entry"]')
      ok(e?.dataset.goalPhase === phase, `相位 ${phase} 反映到入口（实际 ${e?.dataset.goalPhase}）`)
    }
    const doneCount = q('[data-testid="goal-entry-count"]')?.textContent
    ok(/^\d+\/\d+$/.test(doneCount ?? ''), `完成数格式正确（${doneCount}）`)

    /* 受阻原因要显示在浮层里 */
    await openWith(goalOf('blocked', { blocker: '等待用户授权' }))
    ok(!!q('.goal-panel-blocker'), '受阻原因显示在浮层里')
    st().setGoalPopoverOpen(false)
    await sleep(150)

    /* G-4：审阅开关按会话展示，待审计划保留五栏并提供明确决策出口。 */
    const persistedGoal = await window.yan.getGoal()
    window.__yanStore.setState({
      goal: persistedGoal.goal,
      workMode: persistedGoal.mode,
      goalLoading: false,
      goalError: null
    })
    await st().setWorkMode('clarify')
    await sleep(120)
    const reviewSaved = await st().setGoalReadyApproval('review')
    await sleep(120)
    ok(
      reviewSaved && st().workMode?.mode === 'clarify' && st().goal?.readyApproval === 'review',
      `G-4：真实 Electron IPC 在当前隔离会话保存审阅偏好 (saved=${reviewSaved} mode=${st().workMode?.mode} revision=${st().goal?.revision} approval=${st().goal?.readyApproval} runner=${st().activeRunnerId ?? 'none'})`
    )
    window.__yanStore.setState({ workMode: { mode: 'clarify', revision: 6 } })
    await openWith(goalOf('planning', { readyApproval: 'review' }))
    const reviewToggle = q('[data-testid="goal-review-setting-toggle"]')
    ok(reviewToggle?.checked === true && reviewToggle.disabled === false, 'G-4：澄清模式可设置该会话的计划审阅偏好')
    st().setGoalPopoverOpen(false)
    await sleep(150)

    const pendingReady = {
      transitionId: 'tr-fixture-review',
      goalId: 'fixture-goal',
      modeRevision: 6,
      goalRevision: 3,
      understanding: {
        goal: '完成计划审阅',
        deliverable: '审阅后开始',
        scope: '当前会话',
        constraints: '批准前只读',
        acceptance: '批准后进入执行'
      },
      createdAt: Date.now()
    }
    await openWith(goalOf('planning', { revision: 3, readyApproval: 'review', pendingReady }))
    const reviewCard = q('[data-testid="goal-pending-review"]')
    ok(!!reviewCard, 'G-4：待审计划在目标面板中显示')
    ok(
      reviewCard?.textContent?.includes('完成计划审阅') &&
        reviewCard.textContent.includes('批准前只读') &&
        !!q('[data-testid="goal-approve-and-start"]') &&
        !!q('[data-testid="goal-modify-plan"]'),
      'G-4：五栏计划文本与批准 / 修改动作均可见'
    )
    ok(q('[data-testid="goal-review-setting-toggle"]')?.disabled === true, 'G-4：待审时锁定审阅偏好，避免计划状态漂移')
    st().setGoalPopoverOpen(false)
    await sleep(150)

    /* ── G-2 / G-3：完成声明与核验结果分开显示（实施-16） ── */
    await openWith(
      goalOf('completed', {
        brief: {
          goal: '做完这件事',
          outcome: '测试全绿',
          deliverable: '安装包',
          constraints: '不新增依赖'
        },
        verification: {
          status: 'passed',
          at: Date.now(),
          checks: [{ target: 'a.ts', kind: 'file', ok: true, detail: '1 字节', at: Date.now() }],
          detail: '1 项本地产物都存在（只证明存在，不证明内容正确）'
        }
      })
    )
    const passedStatus = q('[data-testid="goal-verification-status"]')
    ok(!!q('[data-testid="goal-model-claim"]'), 'G-3：completed 相位写明「模型报告完成」')
    ok(
      passedStatus?.dataset.verificationStatus === 'passed' &&
        (passedStatus.textContent ?? '').includes('通过'),
      'G-3：核验通过单独成行（与完成声明分开写）'
    )
    ok(
      !!q('[data-testid="goal-brief-deliverable"]') &&
        !!q('[data-testid="goal-brief-constraints"]') &&
        !q('[data-testid="goal-brief-scope"]'),
      'G-3：只显示用户写了的补充字段'
    )
    st().setGoalPopoverOpen(false)
    await sleep(150)

    /* 未核验 / 未检查都不能被渲染成成功 */
    await openWith(goalOf('executing', { verification: null }))
    ok(!q('[data-testid="goal-verification"]'), 'G-3：没有核验结果时不渲染核验区块（不假装已核验）')
    st().setGoalPopoverOpen(false)
    await sleep(150)

    await openWith(
      goalOf('executing', {
        verification: {
          status: 'not_checked',
          at: Date.now(),
          checks: [],
          detail: '目标还没有声明可核验的产物'
        }
      })
    )
    const notChecked = q('[data-testid="goal-verification-status"]')
    ok(
      notChecked?.dataset.verificationStatus === 'not_checked' &&
        (notChecked.textContent ?? '').includes('未核验'),
      'G-3：not_checked 写作「未核验」，不是通过'
    )
    st().setGoalPopoverOpen(false)
    await sleep(150)

    await openWith(
      goalOf('completed', {
        verification: { status: 'manual_review', at: Date.now(), checks: [], detail: '需要人工确认' }
      })
    )
    ok(
      (q('[data-testid="goal-verification-status"]')?.textContent ?? '').includes('人工'),
      'G-3：manual_review 写明需人工审阅'
    )
    st().setGoalPopoverOpen(false)
    await sleep(150)

    /* 空标题 / emoji / 超长标题：入口标签不能空、emoji 不能切坏、超长要截断 */
    window.__yanStore.setState({ goal: goalOf('executing', { brief: { goal: '', outcome: '' } }) })
    await sleep(60)
    ok(((q('[data-testid="goal-entry"] .goal-entry-label')?.textContent ?? '').trim().length) > 0, '空标题回落到「目标 / 计划」，入口不为空')
    window.__yanStore.setState({ goal: goalOf('executing', { brief: { goal: '🧑‍💻 修复登录 🚀', outcome: '通过' } }) })
    await sleep(60)
    const emojiLabel = q('[data-testid="goal-entry"] .goal-entry-label')?.textContent ?? ''
    ok(emojiLabel.includes('🧑‍💻') && !emojiLabel.includes('\uFFFD'), 'emoji 不被切坏（按字素截断）')
    window.__yanStore.setState({ goal: goalOf('executing', { brief: { goal: '超长'.repeat(200), outcome: 'x' } }) })
    await sleep(60)
    const longLabel = q('[data-testid="goal-entry"] .goal-entry-label')?.textContent ?? ''
    ok(longLabel.length > 0 && longLabel.length <= 24, `超长标题被截断且非空（${longLabel.length} 字）`)

    /* 加载失败不能显示成「暂无目标」，要能重试 */
    await openWith(null)
    window.__yanStore.setState({ goalError: 'IPC 失败', goalLoading: false })
    await sleep(120)
    ok(!!q('[data-testid="goal-error"]'), '加载失败显示失败态（不是「暂无目标」）')
    ok(!!q('[data-testid="goal-retry"]'), '失败态有重试按钮')
    st().setGoalPopoverOpen(false)
    await sleep(150)

    /* 查看/关闭不创建也不停止目标：相位不变 */
    const snapshot = goalOf('executing')
    await openWith(snapshot)
    const phaseBefore = st().goal?.phase
    st().setGoalPopoverOpen(false)
    await sleep(150)
    ok(phaseBefore === 'executing' && st().goal?.phase === 'executing', '查看/关闭浮层不创建也不停止目标')

    return out.join('\n')
  } catch (error) {
    out.push('  ✗ 探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
