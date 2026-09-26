/**
 * 学习状态与继续（实施-25 P08，R3 落点）—— 真实窗口里走一遍。
 *
 * 这一片验证的是**闸门**，不是界面（P09 才画导师页）：
 *   · 阶段推进只走宿主：进「等你作答」必须带问题，出等待必须有学习者作答；
 *   · 模型想自己从等待翻到反馈 → 被拒（自问自答不算进度，T08-7）；
 *   · 等待时盘上真的写着 `study-gate/<runnerId>.json`（薄层读的就是它，T08-3）；
 *   · 用户作答后闸门被收掉（自动续跑可以继续）；
 *   · 「先不学了」保留位置，再开始还是同一个会话（T08-5）。
 *
 * 不在这里做的：让**薄层**真的被拦一次（那需要重启 pi 回合）——
 * 由 `scripts/test-goal-resume.mjs` 用真实扩展 + 真实时序覆盖。
 * 本场景 cost 0，不跑模型。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const S = () => store.getState()
  const yan = window.yan

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(400)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 24; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  log('=== 1. 日常 + 空间 + 一门课 ===')
  const modeSwitch = null /* 左栏拨杆已移除（实施-27 B3）：模式入口在设置 · 工作区 */
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  window.__yanStore.setState({ workspaceMode: 'daily' })
  await sleep(300)
  ok(S().workspaceMode === 'daily', '已切到日常模式', String(S().workspaceMode))

  const space = await S().createSpace('探针空间（学习状态）')
  if (!space) return '  ✗ 建空间失败'
  const course = await S().createCourseFromTopic({
    title: '探针课（学习状态）',
    goal: '把虚拟语气讲清楚',
    entry: 'topic',
    minutesPerDay: 20,
    spaceId: space.id
  })
  ok(!!course && course.units.length > 0, '建了一门带骨架的课', `${course?.units?.length ?? 0} 节`)
  if (!course) return out.join('\n')

  log('=== 2. 开始学习（准备阶段，位置在第一节） ===')
  ok((await S().startStudy({ courseId: course.id })) === true, '开始学习')
  let status = await yan.study.status()
  ok(status.session?.phase === 'preparing', '阶段是准备', String(status.session?.phase))
  ok(status.session?.unitId === course.units[0].id, '从第一节开始')
  ok(status.waiting === false && status.gate === null, '还没提问 → 没有闸门')
  const sessionId = status.session?.id

  log('=== 3. 模型不能跳过提问（命令语义） ===')
  const skipped = await yan.study.advance({ to: 'feedback' })
  ok(skipped.ok === false, '准备 → 反馈被拒（不是合法推进）', JSON.stringify(skipped.error))

  ok((await S().advanceStudy('explaining')) === true, '准备 → 讲解（合法推进）')
  const jump = await yan.study.advance({ to: 'applying' })
  ok(jump.ok === false, '讲解 → 应用被拒（必须先提问、等作答）', JSON.stringify(jump.error))
  const emptyAsk = await yan.study.ask({ question: '   ' })
  ok(emptyAsk.ok === false, '空问题进不了「等你作答」', JSON.stringify(emptyAsk.error))

  log('=== 4. 提问 → 等你作答（闸门真的写进盘里） ===')
  const asked = await S().askStudy({
    question: '虚拟语气里的 would 表示什么？',
    expectation: '用自己的话说，不用背术语',
    origin: 'model',
    nextStep: '等他答完再给反馈'
  })
  ok(asked === true, '提出问题并进入等待')
  status = await yan.study.status()
  ok(status.session?.phase === 'waiting_for_learner', '阶段是等你作答', String(status.session?.phase))
  ok(status.waiting === true, '闸门判据：正在等学习者作答')
  ok(status.gate?.waiting === true, '闸门快照在盘上（薄层读的就是它）', status.gate?.where)
  ok(/第 1\/\d+ 节/.test(status.gate?.where ?? ''), '闸门里带着位置（排障与提示都用得上）')
  ok(status.resume?.question === '虚拟语气里的 would 表示什么？', '恢复信息里带着上次的问题')

  log('=== 5. 模型不能自问自答（R3 的核心） ===')
  const cheat = await yan.study.advance({ to: 'feedback' })
  ok(cheat.ok === false, '等待中 advance 到反馈被拒', JSON.stringify(cheat.error))
  ok(/自问自答|作答/.test(cheat.error ?? ''), '拒绝理由说清是「还没作答」')
  const cheat2 = await yan.study.advance({ to: 'summary' })
  ok(cheat2.ok === false, '等待中直接跳到小结也被拒（不能假装学完了）')
  ok((await yan.study.status()).waiting === true, '被拒之后仍然停在等待（没有偷偷走过去）')

  log('=== 6. 用户作答 → 闸门放行 ===')
  ok((await S().answerStudy('表示与事实相反或不太可能的情况。')) === true, '记录学习者的作答')
  status = await yan.study.status()
  ok(status.session?.phase === 'feedback', '作答后进入反馈', String(status.session?.phase))
  ok(status.session?.lastAnswer?.text.includes('事实相反'), '作答内容存下来了')
  ok(status.waiting === false && status.gate === null, '闸门收掉（自动续跑可以继续了）')
  ok((await yan.study.answer({ text: '再说一句' })).ok === false, '已经进反馈，再作答被拒（不能重复兑答案）')

  log('=== 7. 反馈 → 应用；暂停 / 恢复 ===')
  ok((await S().advanceStudy('applying')) === true, '反馈 → 应用')
  ok((await S().askStudy({ question: '那 if I were you 呢？', origin: 'material' })) === true, '应用里再问一句')
  ok((await yan.study.status()).waiting === true, '又进等待')
  ok((await S().pauseStudy()) === true, '暂停学习')
  ok((await yan.study.status()).waiting === false, '暂停后不再算等待（后台准备可以继续做）')
  ok((await S().resumeStudy()) === true, '恢复学习')
  ok((await yan.study.status()).waiting === true, '恢复后「等你作答」也恢复')

  log('=== 8. 先不学了：位置保留（T08-5） ===')
  ok((await S().stopStudy()) === true, '停止学习')
  status = await yan.study.status()
  ok(status.session === null, '当前会话不再绑定这门课')
  ok((await yan.study.status()).gate === null, '闸门也收掉了')
  await S().refreshStudy()
  const kept = S().studySessions.find((item) => item.session.courseId === course.id)
  ok(!!kept, '学习状态还在（列表里能看到上次学到哪）')
  ok(kept?.session.phase === 'waiting_for_learner', '保留的是停止前的阶段', String(kept?.session.phase))
  ok(kept?.resume.unitTitle === course.units[0].title, '保留的是当时那一节', kept?.resume.unitTitle)

  log('=== 9. 接着学：回到同一个会话 ===')
  ok((await S().startStudy({ courseId: course.id })) === true, '再次开始')
  status = await yan.study.status()
  ok(status.session?.id === sessionId, '还是那个学习会话（不是新开一条）', String(status.session?.id))
  ok(status.session?.phase === 'waiting_for_learner', '接着学回到等待阶段（没丢）')
  ok(status.waiting === true && status.gate?.waiting === true, '闸门也跟着回来了')

  log('=== 10. 删课一并收拾学习状态 ===')
  ok((await S().removeCourse(course.id)) === true, '删除课程')
  await S().refreshStudy()
  ok(!S().studySessions.some((item) => item.session.courseId === course.id), '学习状态被一并收拾（不留悬空闸门）')
  ok((await yan.study.status()).gate === null, '闸门确认收掉')

  await S().updateSpace(space.id, { archived: true })
  return out.join('\n')
})()
