/**
 * 笔记与概念进度（实施-25 P11）—— 真实窗口里走一遍 R7 的两条轴。
 *
 * 探针盯的是**界面有没有把两条轴分开摆**：
 *   · 两次不同练习的独立成功 → 「独立完成」；
 *   · 之后一次失败 → 层级**不降**，但出现「建议复习」——两张标签同时挂着；
 *   · 用户自评「我已经会了」→ 出现在另一个位置，**不改**系统观察；
 *   · 笔记：新建 → 保存 → 编辑 → 删除。
 *
 * 刻意不做：点「让导师细说」之类的动作（会真发模型消息，本场景 cost 0）。
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

  log('=== 1. 日常 + 空间 + 建课 ===')
  const modeSwitch = null /* 左栏拨杆已移除（实施-27 B3）：模式入口在设置 · 工作区 */
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  const space = await S().createSpace('探针空间（进度与笔记）')
  ok(!!space, '建空间成功', space?.id)
  if (!space) return out.join('\n')

  const cwd = String(S().settings?.cwd ?? '').replace(/[\/]+$/, '')
  const imported = await yan.library.import({
    kind: 'file',
    ref: `${cwd}/README.md`,
    title: '精读材料（进度）',
    owner: { kind: 'course', id: 'probe-memory' }
  })
  ok(imported?.ok === true, '导入成功', imported?.error)
  if (!imported?.ok) return out.join('\n')
  await S().refreshLibrary()
  await sleep(300)

  click(q('[data-testid="view-space"]'))
  await sleep(500)
  click(q('[data-testid="space-tab-learning"]'))
  await sleep(700)
  const setVal = (sel, value) => {
    const el = q(sel)
    if (!el) return
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setVal('[data-testid="space-learn-new-title"]', '进度课')
  setVal('[data-testid="space-learn-new-goal"]', '读懂这份材料')
  setSelect(q('[data-testid="space-learn-new-entry"]'), 'source')
  await sleep(300)
  setSelect(q('[data-testid="space-learn-new-source"]'), imported.sourceId)
  await sleep(300)
  click(q('[data-testid="space-learn-create"]'))
  await sleep(1500)

  const course = S().courses.find((c) => c.title === '进度课')
  ok(!!course, '课程建立')
  if (!course) return out.join('\n') + '\n✗ 找不到刚建的课程'
  const unit = course.units[0]

  log('=== 2. 加概念：一开始是「未接触」 ===')
  ok(!!q('[data-testid="space-learn-progress"]'), '左栏有概念进度区')
  ok(!!q('[data-testid="space-learn-concepts-empty"]'), '还没概念时如实说「还没有概念」')
  setVal('[data-testid="space-learn-concept-input"]', '光反应')
  await sleep(200)
  click(q('[data-testid="space-learn-concept-add"]'))
  await sleep(1200)
  const withConcept = S().courses.find((c) => c.id === course.id)
  const concept = withConcept?.concepts?.[0]
  ok(!!concept, '概念加上去了', concept?.id)
  if (!concept) return out.join('\n') + '\n✗ 概念没加上'
  await S().refreshConceptProgress(course.id)
  await sleep(400)
  const levelEl = () => String(q(`[data-testid="space-learn-concept-level-${concept.id}"]`)?.textContent ?? '')
  ok(!!q(`[data-testid="space-learn-concept-${concept.id}"]`), '概念行渲染')
  ok(/未接触/.test(levelEl()), '刚开始是「未接触」', levelEl())

  log('=== 3. 两次不同练习的独立成功 → 独立完成 ===')
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
  const ex1 = await makeChoice('练习一')
  const ex2 = await makeChoice('练习二')
  ok(!!ex1 && !!ex2, '造了两道带概念的客观题', `${ex1?.id}/${ex2?.id}`)
  const submit = (id, optionId) => yan.exercise.submit({ exerciseId: id, response: { kind: 'choice', optionId } })
  const first = await submit(ex1.id, 'a')
  ok(first?.ok === true && first.attempt?.correct === true, '第一次独立成功（没要提示、没看解释）')
  await sleep(300)
  await S().refreshConceptProgress(course.id)
  await sleep(300)
  ok(/提示下完成|在提示下完成/.test(levelEl()), '一次成功先停在提示层（未满两次）', levelEl())

  const second = await submit(ex2.id, 'a')
  ok(second?.ok === true && second.attempt?.correct === true, '第二次独立成功')
  await sleep(300)
  await S().refreshConceptProgress(course.id)
  await sleep(400)
  ok(/独立完成/.test(levelEl()), '两次不同练习的独立成功 → 独立完成', levelEl())
  ok(!q(`[data-testid="space-learn-concept-review-${concept.id}"]`), '这时没有「建议复习」')

  log('=== 4. 一次失败：不降级，只加「建议复习」 ===')
  const ex3 = await makeChoice('练习三')
  const failed = await submit(ex3.id, 'b')
  ok(failed?.ok === true && failed.attempt?.correct === false, '第三次答错')
  await sleep(300)
  await S().refreshConceptProgress(course.id)
  await sleep(500)
  ok(/独立完成/.test(levelEl()), '一次失败**不降级**', levelEl())
  ok(!!q(`[data-testid="space-learn-concept-review-${concept.id}"]`), '但出现「建议复习」——两条轴同时成立')

  log('=== 5. 用户自评：另存，不动系统观察 ===')
  click(q(`[data-testid="space-learn-concept-gotit-${concept.id}"]`))
  await sleep(900)
  ok(!!q(`[data-testid="space-learn-concept-self-${concept.id}"]`), '自评「我已经会了」显示出来')
  ok(/独立完成/.test(levelEl()), '系统观察没被自评改掉', levelEl())
  ok(!!q(`[data-testid="space-learn-concept-review-${concept.id}"]`), '「建议复习」也还在（三者并存）')

  log('=== 6. 笔记：新建 → 保存 → 编辑 → 删除 ===')
  ok(!!q('[data-testid="space-learn-notes"]'), '左栏有笔记区')
  ok(!!q('[data-testid="space-learn-notes-empty"]'), '一开始如实说「还没有笔记」')
  click(q('[data-testid="space-learn-note-new"]'))
  await sleep(300)
  setVal('[data-testid="space-learn-note-title"]', '第二段')
  setVal('[data-testid="space-learn-note-body"]', '这一段讲了光反应发生在叶绿体里。')
  await sleep(200)
  click(q('[data-testid="space-learn-note-save"]'))
  await sleep(1200)
  const notes = await yan.note.list(course.id)
  const note = Array.isArray(notes) ? notes[0] : null
  ok(!!note, '笔记保存成功', note?.id)
  if (!note) return out.join('\n') + '\n✗ 笔记没保存'
  ok(String(note.body).includes('叶绿体'), '正文存对了')
  await S().refreshNotes(course.id)
  await sleep(400)
  ok(!!q(`[data-testid="space-learn-note-${note.id}"]`), '列表里能看到这条笔记')

  click(q(`[data-testid="space-learn-note-edit-${note.id}"]`))
  await sleep(300)
  setVal('[data-testid="space-learn-note-body"]', '改成：光反应在叶绿体的类囊体膜上。')
  await sleep(200)
  click(q('[data-testid="space-learn-note-save"]'))
  await sleep(1000)
  const edited = (await yan.note.list(course.id)).find((n) => n.id === note.id)
  ok(String(edited?.body ?? '').includes('类囊体'), '编辑生效')

  click(q(`[data-testid="space-learn-note-delete-${note.id}"]`))
  await sleep(900)
  ok((await yan.note.list(course.id)).length === 0, '删除生效')

  log('=== 7. 收尾：删课带走笔记与进度 ===')
  await S().removeCourse(course.id)
  await sleep(1200)
  ok(!S().courses.some((c) => c.id === course.id), '课程已删')
  ok((await yan.note.list(course.id)).length === 0, '笔记一并清掉')
  ok((await yan.concept.list(course.id)).length === 0, '概念进度一并清掉')

  return out.join('\n')
})()
