/**
 * 活动流程（实施-25 P05 / T05-1、T05-2、T05-5）的单测。
 *
 * 为什么值得单测：
 *   · 「简单问答不建任务」的阈值一旦写错，要么给每句闲聊建一整套清单，
 *     要么把 coding 会话里多年的习惯改掉 —— 两种都不会报错，只会让人困惑；
 *   · 研究结论的两条硬要求（带回来源、保留分歧）是宿主检查产出的依据，
 *     检查字段名写错等于没检查。
 */

export function runActivityFlowTests(ok, mod) {
  const {
    ACTIVITY_FLOWS,
    activityFlow,
    decideTaskCreation,
    taskCreationRefusal,
    conclusionContract,
    SIMPLE_REQUEST_MAX_CHARS,
    SIMPLE_TASK_MAX_ITEMS
  } = mod

  /* ---- 五个活动都有定义，且流程与设计稿一致 ---- */
  for (const activity of ['answer', 'research', 'compose', 'organize', 'learn']) {
    ok(!!ACTIVITY_FLOWS[activity], `${activity} 有流程定义`)
    ok(activityFlow(activity).steps.length >= 1, `${activity} 至少一步`)
  }
  ok(activityFlow('bad').activity === 'answer', '未知活动回落到 answer（与档案归一化一致）')

  ok(!activityFlow('answer').multiStep, '问答不是多步流程（不建任务）')
  ok(activityFlow('answer').deliverable === null, '问答不要求独立成果')

  const research = activityFlow('research')
  ok(research.multiStep, '研究是多步流程')
  ok(research.requiresSources && research.keepsDisagreement, '研究要求来源、要求保留分歧')
  ok(research.deliverable?.includes('来源'), '研究产出要求写明带来源')

  ok(activityFlow('compose').deliverable?.includes('编辑'), '创作产出是可编辑文稿')
  ok(activityFlow('organize').deliverable?.length > 0, '整理有产出要求')
  ok(activityFlow('learn').deliverable?.includes('学习记录'), '学习产出是学习记录')

  const researchSteps = research.steps.map((s) => s.id)
  ok(researchSteps.join(',') === 'pick-sources,read-by-question,conclude', '研究三步顺序与设计稿一致', researchSteps.join(','))
  ok(research.steps.every((s) => s.produces.trim().length > 0), '每一步都写明产出（宿主据此检查流程）')

  /* ---- T05-2：简单问答不建任务 ---- */
  {
    const dailyAnswerShort = decideTaskCreation({ profile: 'daily', activity: 'answer', itemCount: 1, text: '今天天气怎么样' })
    ok(dailyAnswerShort.create === false && dailyAnswerShort.reason === 'simple-answer', '日常 + 问答 + 一句话 → 不建任务')

    const coding = decideTaskCreation({ profile: 'coding', activity: 'answer', itemCount: 1, text: 'x' })
    ok(coding.create === true && coding.reason === 'coding', 'coding 一律放行（不干预既有行为）')

    const explicit = decideTaskCreation({ profile: 'daily', activity: 'answer', itemCount: 1, text: 'x', explicit: true })
    ok(explicit.create === true && explicit.reason === 'explicit', '用户明确要计划 → 建')

    const researchTask = decideTaskCreation({ profile: 'daily', activity: 'research', itemCount: 0 })
    ok(researchTask.create === true && researchTask.reason === 'activity-flow', '研究活动 → 建（多步流程）')

    const multiItems = decideTaskCreation({ profile: 'daily', activity: 'answer', itemCount: SIMPLE_TASK_MAX_ITEMS + 1 })
    ok(multiItems.create === true && multiItems.reason === 'multi-step', '多条待办 → 建')

    const longText = decideTaskCreation({ profile: 'daily', activity: 'answer', itemCount: 1, text: 'x'.repeat(SIMPLE_REQUEST_MAX_CHARS + 1) })
    ok(longText.create === true && longText.reason === 'multi-step', '长输入 → 建')

    const noText = decideTaskCreation({ profile: 'daily', activity: 'answer', itemCount: 1 })
    ok(noText.create === false, 'CLI 看不到原话时按最短算，仍拦得下简单问答')
  }

  ok(taskCreationRefusal('simple-answer')?.includes('简单问答'), '被拦下时给模型可读说明')
  ok(taskCreationRefusal('coding') === null, '放行的情况没有拒绝文案')

  /* ---- T05-5：研究结论契约 ---- */
  const rc = conclusionContract('research')
  ok(rc.requiresSources && rc.keepsDisagreement, '研究结论要求来源与分歧')
  ok(rc.requiredFields.join(',') === 'source,disagreement', '结论必须带 source 与 disagreement 两个字段', rc.requiredFields.join(','))
  ok(conclusionContract('answer').requiredFields.length === 0, '问答没有结论字段要求')
  ok(conclusionContract('compose').requiresSources === false, '创作不强制带来源')
}
