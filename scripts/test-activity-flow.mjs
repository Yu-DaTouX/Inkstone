/**
 * 建任务阈值的单测。
 *
 * 「简单问答不建任务」的阈值一旦写错，要么给每句闲聊建一整套清单，
 * 要么把 coding 会话里的习惯改掉 —— 两种都不会报错，只会让人困惑。
 */

export function runActivityFlowTests(ok, mod) {
  const { isMultiStepActivity, decideTaskCreation, taskCreationRefusal, SIMPLE_REQUEST_MAX_CHARS, SIMPLE_TASK_MAX_ITEMS } = mod

  ok(!isMultiStepActivity('answer'), '问答不是多步流程（不建任务）')
  for (const activity of ['research', 'compose', 'organize', 'learn']) {
    ok(isMultiStepActivity(activity), `${activity} 是多步流程`)
  }

  /* ---- T05-2：简单问答不建任务 ---- */
  {
    const dailyAnswerShort = decideTaskCreation({ profile: 'daily', activity: 'answer', itemCount: 1, text: '今天天气怎么样' })
    ok(dailyAnswerShort.create === false && dailyAnswerShort.reason === 'simple-answer', '日常 + 问答 + 一句话 → 不建任务')

    const coding = decideTaskCreation({ profile: 'coding', activity: 'answer', itemCount: 3, text: 'x' })
    ok(coding.create === true && coding.reason === 'coding', 'coding：3 步以上照常建')
    const codingSmall = decideTaskCreation({ profile: 'coding', activity: 'answer', itemCount: 1, text: 'x' })
    ok(codingSmall.create === false && codingSmall.reason === 'coding-small', 'coding：一两步的新清单不建（省 token）')
    const codingAppend = decideTaskCreation({ profile: 'coding', activity: 'answer', itemCount: 1, existingItems: 4 })
    ok(codingAppend.create === true, 'coding：往已有清单追加一条照常放行')
    const codingExplicit = decideTaskCreation({ profile: 'coding', activity: 'answer', itemCount: 1, explicit: true })
    ok(codingExplicit.create === true && codingExplicit.reason === 'explicit', 'coding：用户明确要计划就建')

    /* auto 档：活动由模型当场判断，宿主不看旧 activity 的流程 */
    const autoShort = decideTaskCreation({ profile: 'auto', activity: 'research', itemCount: 1, text: '今天天气怎么样' })
    ok(
      autoShort.create === false && autoShort.reason === 'simple-answer',
      'auto + 一句话 → 不建任务（不受上次研究的流程影响）'
    )

    const autoMulti = decideTaskCreation({ profile: 'auto', activity: 'answer', itemCount: SIMPLE_TASK_MAX_ITEMS + 1 })
    ok(autoMulti.create === true && autoMulti.reason === 'multi-step', 'auto + 多条待办 → 建')

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
}
