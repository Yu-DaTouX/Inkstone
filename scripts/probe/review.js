/**
 * 错题与复习（实施-25 P12）—— 真实窗口里走「做错 → 记下 → 挑新例子 → 挪期」。
 *
 * 盯住两件事：
 *   · **再练换新例子**：计划里挑的题不是刚才做错的那道；
 *   · **只提醒与挑题**：面板不自动开始学习，点题也只是把题放进练习卡。
 *
 * cost 0：不点会真发模型消息的按钮（「让导师细说」之类）。
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

  const setSelect = (el, value) => {
    if (!el) return false
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  const setInput = (el, value) => {
    if (!el) return false
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

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

  log('=== 1. 建课与概念（复习要长在课程上） ===')
  const modeSwitch = null /* 左栏拨杆已移除（实施-27 B3）：模式入口在设置 · 工作区 */
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  const space = await S().createSpace('探针空间（复习）')
  ok(!!space, '建空间成功', space?.id)
  if (!space) return out.join('\n')

  const cwd = String(S().settings?.cwd ?? '').replace(/[\/]+$/, '')
  const imported = await yan.library.import({
    kind: 'file',
    ref: `${cwd}/README.md`,
    title: '精读材料（复习）',
    owner: { kind: 'course', id: 'probe-review' }
  })
  ok(imported?.ok === true, '导入成功', imported?.error)
  if (!imported?.ok) return out.join('\n')
  await S().refreshLibrary()
  await sleep(300)

  click(q('[data-testid="view-space"]'))
  await sleep(500)
  click(q('[data-testid="space-tab-learning"]'))
  await sleep(700)
  setInput(q('[data-testid="space-learn-new-title"]'), '复习课')
  setInput(q('[data-testid="space-learn-new-goal"]'), '读懂这份材料')
  setSelect(q('[data-testid="space-learn-new-entry"]'), 'source')
  await sleep(300)
  setSelect(q('[data-testid="space-learn-new-source"]'), imported.sourceId)
  await sleep(300)
  click(q('[data-testid="space-learn-create"]'))
  await sleep(1500)

  const course = S().courses.find((c) => c.title === '复习课')
  ok(!!course, '课程建立')
  if (!course) return out.join('\n') + '\n✗ 找不到刚建的课程'
  const unit = course.units[0]

  setInput(q('[data-testid="space-learn-concept-input"]'), '光反应')
  await sleep(200)
  click(q('[data-testid="space-learn-concept-add"]'))
  await sleep(1200)
  const concept = S().courses.find((c) => c.id === course.id)?.concepts?.[0]
  ok(!!concept, '概念加上去了', concept?.id)
  if (!concept) return out.join('\n') + '\n✗ 概念没加上'

  log('=== 2. 学这一节（复习面板在导师页右栏） ===')
  click(q(`[data-testid="space-learn-unit-study-${unit.id}"]`))
  await sleep(1500)
  ok(S().studyStatus?.session?.unitId === unit.id, '学习位置指向这一节')
  ok(!!q('[data-testid="space-learn-review"]'), '右栏出现「错题与复习」面板')
  ok(!!q('[data-testid="space-learn-review-empty"]'), '还没做错时如实说「还没有要复习的」')

  log('=== 3. 做错一道 → 记下复习 ===')
  const makeChoice = async (label) => {
    const res = await yan.exercise.create({
      courseId: course.id,
      unitId: unit.id,
      conceptIds: [concept.id],
      kind: 'choice',
      prompt: `${label}：光反应发生在哪里？`,
      options: [
        { id: 'a', text: '叶绿体' },
        { id: 'b', text: '线粒体' }
      ],
      answer: { kind: 'choice', optionId: 'a' },
      hints: [{ level: 'direction', text: '看第二段' }]
    })
    return res?.exercise
  }
  const wrongOne = await makeChoice('第一道')
  const freshOne = await makeChoice('第二道')
  ok(!!wrongOne && !!freshOne, '造了两道同概念的题', `${wrongOne?.id}/${freshOne?.id}`)
  const submit = (id, optionId) => yan.exercise.submit({ exerciseId: id, response: { kind: 'choice', optionId } })
  const wrong = await submit(wrongOne.id, 'b')
  ok(wrong?.ok === true && wrong.attempt?.correct === false, '第一道答错')

  await S().refreshReviews(course.id)
  await S().refreshReviewDue()
  await sleep(500)
  const items = S().reviews
  ok(items.length === 1, '记下一条复习', JSON.stringify(items.map((i) => i.reason)))
  const reviewId = items[0]?.id
  if (!reviewId) return out.join('\n') + '\n✗ 没记下复习项'
  ok(!!q(`[data-testid="space-learn-review-item-${reviewId}"]`), '面板里看得到这条')
  ok(/做错过/.test(String(q(`[data-testid="space-learn-review-reason-${reviewId}"]`)?.textContent ?? '')), '来因写着「做错过」')
  ok(/明天再看一眼/.test(String(q(`[data-testid="space-learn-review-when-${reviewId}"]`)?.textContent ?? '')), '新建的这条排在明天（间隔 1 天，不是「现在就催」）', String(q(`[data-testid="space-learn-review-when-${reviewId}"]`)?.textContent ?? ''))
  ok(S().reviewDue?.total === 1, '首页那份统计里有这一条（共 1 条，今天还没到期）', JSON.stringify(S().reviewDue))

  log('=== 4. 今天十分钟：挑的是同概念的新例子 ===')
  click(q('[data-testid="space-learn-review-quick"]'))
  await sleep(900)
  ok(!!q('[data-testid="space-learn-review-plan"]'), '出现今天的计划')
  ok(!!q('[data-testid="space-learn-review-plan-item-0"]'), '计划里有一件')
  ok(
    !q('[data-testid="space-learn-review-needs-new"]'),
    '还有新例子可用时不会报「没有新例子」'
  )
  const picked = S().reviewPlan?.entries?.[0]?.exerciseId
  ok(picked === freshOne.id, '挑的是没做过的那道（不复用做错的原题）', String(picked))

  click(q('[data-testid="space-learn-review-plan-open-0"]'))
  await sleep(900)
  const shown = S().exercises[0]
  ok(shown?.id === freshOne.id, '练习卡里换成这道新例子', String(shown?.id))
  ok(
    String(q('[data-testid="space-exercise-prompt"]')?.textContent ?? '').includes('第二道'),
    '练习卡真的选中了它',
    String(q('[data-testid="space-exercise-prompt"]')?.textContent ?? '')
  )
  ok(S().exercises.length === 1, '只放了这一道（不是把整单元的题铺开）')

  log('=== 5. 挪期与去掉（用户说了算） ===')
  click(q(`[data-testid="space-learn-review-tomorrow-${reviewId}"]`))
  await sleep(900)
  ok(
    /明天再看一眼/.test(String(q(`[data-testid="space-learn-review-when-${reviewId}"]`)?.textContent ?? '')),
    '「明天再说」把它挪到明天',
    String(q(`[data-testid="space-learn-review-when-${reviewId}"]`)?.textContent ?? '')
  )
  click(q(`[data-testid="space-learn-review-now-${reviewId}"]`))
  await sleep(900)
  ok(
    /现在可以复习/.test(String(q(`[data-testid="space-learn-review-when-${reviewId}"]`)?.textContent ?? '')),
    '「现在就练」又拉回眼前'
  )

  log('=== 6. 答对两次 → 这条自己消失 ===')
  await submit(freshOne.id, 'a')
  await sleep(400)
  await S().refreshReviews(course.id)
  ok(S().reviews.length === 1, '第一次独立成功只是往后延（还留着）')
  const third = await makeChoice('第三道')
  await submit(third.id, 'a')
  await sleep(400)
  await S().refreshReviews(course.id)
  ok(S().reviews.length === 0, '连续两次独立成功就把这条收掉（不用用户自己清）')
  ok(!!q('[data-testid="space-learn-review-empty"]'), '面板回到「还没有要复习的」')

  /* 再制造一条**已到期**的：首页卡要能看到数量（前面那条被收掉后首页是空的）。 */
  const fourth = await makeChoice('第四道')
  await submit(fourth.id, 'b')
  await sleep(400)
  await S().refreshReviews(course.id)
  const dueId = S().reviews[0]?.id
  await S().rescheduleReview(dueId, { dueAt: Date.now() - 1000 })
  await sleep(400)

  log('=== 7. 首页「今天可复习」入口 ===')
  S().closeSpaceView()
  window.__yanStore.setState({ workspaceMode: 'daily', messages: [], session: null, reviewDue: null })
  await sleep(900)
  ok(!!q('[data-testid="workbench-home"]'), '回到工作台首页')
  ok(!!q('[data-testid="wb-card-review"]'), '首页有「今天可复习」卡')
  const dueText = String(q('[data-testid="wb-card-review-count"]')?.textContent ?? '')
  ok(/1/.test(dueText), '卡片说清了有 1 项到期', dueText || String(q('[data-testid="wb-card-review-empty"]')?.textContent ?? ''))
  ok(!!q('[data-testid="wb-open-review"]'), '有进去看要练什么的入口')
  click(q('[data-testid="wb-open-review"]'))
  await sleep(800)
  ok(!!q('[data-testid="space-learning"]'), '点入口回到学习页（不是在那里直接开始练）')

  log('=== 8. 收尾：删课带走复习 ===')
  await S().removeCourse(course.id)
  await sleep(1200)
  ok(!S().courses.some((c) => c.id === course.id), '课程已删')
  ok((await yan.review.list(course.id)).length === 0, '复习项一并清掉')

  return out.join('\n')
})()
