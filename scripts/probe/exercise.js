/**
 * 练习与反馈（实施-25 P10）—— 真实窗口里走一遍「出题 → 作答 → 反馈」。
 *
 * 探针盯的是**界面有没有守住 P10 的那条规矩**：
 *   · 题目出来时**看不到答案**（完整解释不在 DOM 里）；
 *   · 「看完整解释」是用户显式点的，点之前那一块不存在；
 *   · 开放题不给「对 / 错」结论，而是把反馈交给导师；
 *   · 客观题提交后给判定，且如实标注「用了提示或看过解释」；
 *   · 用户能纠正判定，纠正会被记下并显示。
 *
 * 刻意不做：点「让导师细说」—— 那会真的发模型消息，本场景 cost 0。
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

  const setInput = (el, value) => {
    if (!el) return false
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  const setSelect = (el, value) => {
    if (!el) return false
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
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

  log('=== 1. 日常 + 空间 + 导入真资料 ===')
  const modeSwitch = null /* 左栏拨杆已移除（实施-27 B3）：模式入口在设置 · 工作区 */
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  window.__yanStore.setState({ workspaceMode: 'daily' })
  await sleep(300)
  ok(S().workspaceMode === 'daily', '已切到日常模式', String(S().workspaceMode))

  const space = await S().createSpace('探针空间（练习卡）')
  ok(!!space, '建空间成功', space?.id)
  if (!space) return out.join('\n')

  const cwd = String(S().settings?.cwd ?? '').replace(/[\/]+$/, '')
  const imported = await yan.library.import({
    kind: 'file',
    ref: `${cwd}/README.md`,
    title: '精读材料（练习卡）',
    owner: { kind: 'course', id: 'probe-exercise' }
  })
  ok(imported?.ok === true, '导入成功', imported?.error)
  if (!imported?.ok) return out.join('\n')
  await S().refreshLibrary()
  await sleep(300)

  log('=== 2. 建课并进入导师页 ===')
  click(q('[data-testid="view-space"]'))
  await sleep(500)
  click(q('[data-testid="space-tab-learning"]'))
  await sleep(700)
  setInput(q('[data-testid="space-learn-new-title"]'), '练习卡课程')
  setInput(q('[data-testid="space-learn-new-goal"]'), '读懂这份材料')
  setSelect(q('[data-testid="space-learn-new-entry"]'), 'source')
  await sleep(300)
  setSelect(q('[data-testid="space-learn-new-source"]'), imported.sourceId)
  await sleep(300)
  click(q('[data-testid="space-learn-create"]'))
  await sleep(1500)

  const course = S().courses.find((c) => c.title === '练习卡课程')
  ok(!!course, '课程建立')
  if (!course) return out.join('\n') + '\n✗ 找不到刚建的课程'
  const unit = course.units[0]

  const studyBtn = q(`[data-testid="space-learn-unit-study-${unit.id}"]`)
  ok(!!studyBtn, '单元上有「学这一节」')
  click(studyBtn)
  await sleep(1200)
  ok(S().studyStatus?.session?.unitId === unit.id, '学习位置指向这一节', String(S().studyStatus?.session?.unitId))

  log('=== 3. 出题：题目有、答案没有 ===')
  ok(!!q('[data-testid="space-learn-exercise"]'), '练习卡在右栏')
  ok(!!q('[data-testid="space-exercise-empty"]'), '一开始没有题：如实说「还没有练习题」')
  const draftBtn = q('[data-testid="space-exercise-draft"]')
  ok(!!draftBtn, '有「从这一节出题」')
  click(draftBtn)
  await sleep(1600)
  const tabs = document.querySelectorAll('[data-testid^="space-exercise-tab-"]')
  ok(tabs.length >= 2, `出到题了（${tabs.length} 道）`)
  const firstKind = String(q('[data-testid="space-exercise-kind"]')?.textContent ?? '')
  ok(/解释/.test(firstKind), '第一道是用自己的话解释', firstKind)
  ok(!!q('[data-testid="space-exercise-prompt"]'), '题面显示出来')
  ok(!q('[data-testid="space-exercise-solution-text"]'), '**没作答前看不到完整解释**')
  ok(!q('[data-testid="space-exercise-hints"]'), '也没要过提示：提示区不存在')

  log('=== 4. 开放题：作答 → 不给对错、交给导师 ===')
  setInput(q('[data-testid="space-exercise-input"]'), '这段说明讲的是这个项目做什么、给谁用。')
  await sleep(200)
  click(q('[data-testid="space-exercise-submit"]'))
  await sleep(900)
  const verdict = String(q('[data-testid="space-exercise-verdict"]')?.textContent ?? '')
  ok(!!q('[data-testid="space-exercise-feedback"]'), '提交后出现反馈')
  ok(/开放题/.test(verdict), '开放题不下「对错」结论，如实说明', verdict)
  ok(!!q('[data-testid="space-exercise-ask-model"]'), '开放题提示可以请导师细说（本场景不点）')

  log('=== 5. 客观题：先给提示、再看解释、然后才判 ===')
  click(q('[data-testid="space-exercise-tab-1"]'))
  await sleep(500)
  const kind2 = String(q('[data-testid="space-exercise-kind"]')?.textContent ?? '')
  ok(/填空|选择|配对/.test(kind2), '第二道是客观题', kind2)
  ok(!q('[data-testid="space-exercise-hint-direction"]'), '还没点提示：提示区不存在')
  click(q('[data-testid="space-exercise-hint"]'))
  await sleep(700)
  ok(!!q('[data-testid="space-exercise-hint-direction"]'), '点一次给一层提示')

  ok(!!q('[data-testid="space-exercise-solution"]'), '有「看完整解释」按钮')
  click(q('[data-testid="space-exercise-solution"]'))
  await sleep(700)
  ok(!!q('[data-testid="space-exercise-solution-text"]'), '点过之后完整解释才出现')

  const blank = q('[data-testid="space-exercise-blank-0"]')
  ok(!!blank, '填空题给输入框')
  setInput(blank, '一个明显不对的词')
  await sleep(200)
  click(q('[data-testid="space-exercise-submit"]'))
  await sleep(900)
  const fb = q('[data-testid="space-exercise-feedback"]')
  ok(!!fb, '提交后出现反馈')
  ok(String(fb?.textContent ?? '').includes('用了提示或看过解释') || String(fb?.textContent ?? '').includes('看过完整解释'), '如实标注这次用了帮助', String(fb?.textContent ?? '').slice(0, 40))

  log('=== 6. 用户纠正判定 ===')
  click(q('[data-testid="space-exercise-correction-open"]'))
  await sleep(300)
  setInput(q('[data-testid="space-exercise-correction-input"]'), '我填的其实在原文里出现过。')
  await sleep(200)
  click(q('[data-testid="space-exercise-correction-send"]'))
  await sleep(800)
  ok(!!q('[data-testid="space-exercise-correction-record"]'), '纠正被记下并显示')

  log('=== 7. 图片题（P19）：题面只带资料库引用 ===')
  /* cwd 在文件开头已经取过（与其它步骤同一个工作目录） */
  const image = await yan.library.import({
    kind: 'image',
    ref: `${cwd}/docs/design/preview/controls-v1-dark-base-1280x800-2026-09-23.png`,
    title: '图题素材（探针）'
  })
  ok(image?.ok === true, '导入一张图片到资料库', image?.error)
  if (image?.ok) {
    const withImage = await yan.exercise.create({
      courseId: course.id,
      unitId: unit.id,
      kind: 'explain',
      prompt: '看这张界面图，说明它在讲什么。',
      images: [{ sourceId: image.sourceId, version: image.version ?? 1, caption: '第 1 张' }]
    })
    ok(withImage?.ok === true, '建了一道带图的题', withImage?.error)
    await S().refreshExercises(course.id, unit.id)
    await sleep(900)
    /* 练习卡一次只显示一道：切到新建的那一道（排在最后）再看图 */
    const tabs = document.querySelectorAll('[data-testid^="space-exercise-tab-"]')
    if (tabs.length) click(tabs[tabs.length - 1])
    await sleep(700)
    ok(!!q('[data-testid="space-exercise-images"]'), '练习卡显示图片引用区')
    ok(!!q('[data-testid="space-exercise-image-0"]'), '列出了那张图的引用')
    /*
     * 「能不能看图」按**当前模型的真实能力**分支断言：能看就不该吓用户，
     * 不能看就必须如实提醒 —— 两种都算通过，但都必须与能力一致。
     */
    const canSeeImages = S().session?.capabilities?.input?.modalities?.includes('image') === true
    const warn = q('[data-testid="space-exercise-vision"]')
    ok(
      canSeeImages ? !warn : !!warn,
      canSeeImages ? '当前模型报告能看图：不显示「你自己看」的提醒' : '模型没报告能看图：如实提醒（不自建识别）',
      String(S().session?.capabilities?.input?.modalities ?? '')
    )
    ok(!/data:image|base64/.test(JSON.stringify(S().exercises)), '题面里没有内联图片数据（只有引用）')
    await yan.library.remove(image.sourceId)
  }

  log('=== 8. 收尾：删课带走练习 ===')
  await S().removeCourse(course.id)
  await sleep(900)
  ok(!S().courses.some((c) => c.id === course.id), '课程已删')
  ok(String(S().exerciseLoadedFor ?? '') === '' || S().exercises.length === 0, '练习一并清掉')

  return out.join('\n')
})()
