/**
 * 课程与路线（实施-25 P07）—— 真实窗口里走一遍。
 *
 * 覆盖 P07 的验收与边界：
 *   · 入口一：从**一份真实资料**生成路线，每个单元指回资料位置（点得开原文）；
 *   · 调整路线：上移 / 下移 / 插入补充单元 / 改目标与建议学习量；
 *   · 入口二、三：主题与卡点骨架（全是「补充」单元，必须带说明）；
 *   · **材料 vs 补充**：材料单元没有出处会被拒（走 IPC 验证同一道闸门）；
 *   · 关闭重开：路线与顺序仍在（数据在宿主，不是界面里的草稿）。
 *
 * 不在这里做的：「模型按路线讲课」属于 P09/P10；本场景 cost 0，不跑模型。
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

  /** React 受控输入：必须走原生 setter + input 事件 */
  const setInput = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const setSelect = (el, value) => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
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

  log('=== 1. 日常 + 空间 + 打开学习页 ===')
  const modeSwitch = null /* 左栏拨杆已移除（实施-27 B3）：模式入口在设置 · 工作区 */
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  window.__yanStore.setState({ workspaceMode: 'daily' })
  await sleep(300)
  ok(S().workspaceMode === 'daily', '已切到日常模式', String(S().workspaceMode))

  const space = await S().createSpace('探针空间（课程）')
  ok(!!space, '建空间成功', space?.id)
  if (!space) return out.join('\n')

  click(q('[data-testid="view-space"]'))
  await sleep(500)
  click(q('[data-testid="space-tab-learning"]'))
  await sleep(700)
  ok(!!q('[data-testid="space-learning"]'), '学习页渲染（不再是占位）')

  log('=== 2. 导入真实资料（路线才有材料出处） ===')
  const lib = window.yan.library
  const cwd = String(S().settings?.cwd ?? '').replace(/[\/]+$/, '')
  const imported = await lib.import({
    kind: 'file',
    ref: `${cwd}/README.md`,
    title: '精读材料（课程）',
    owner: { kind: 'course', id: 'probe-course' }
  })
  ok(imported?.ok === true, '导入成功', imported?.error)
  if (!imported?.ok) return out.join('\n')
  await S().refreshLibrary()
  await sleep(400)

  log('=== 3. 入口一：学这份资料 ===')
  setInput(q('[data-testid="space-learn-new-title"]'), '探针课程')
  setInput(q('[data-testid="space-learn-new-goal"]'), '能读懂这份材料并复述')
  setSelect(q('[data-testid="space-learn-new-entry"]'), 'source')
  await sleep(300)
  const sourceSelect = q('[data-testid="space-learn-new-source"]')
  ok(!!sourceSelect, '选「学这份资料」后出现资料选择')
  if (sourceSelect) setSelect(sourceSelect, imported.sourceId)
  await sleep(300)
  click(q('[data-testid="space-learn-create"]'))
  await sleep(1200)

  let course = S().courses.find((c) => c.title === '探针课程')
  ok(!!course, '课程建立')
  if (!course) return out.join('\n') + '\n✗ 找不到刚建的课程'
  const id = course.id
  ok(course.units.length > 0, '生成了单元', String(course.units.length))
  ok(
    course.units.every((u) => u.origin === 'material' && u.sources.length > 0),
    '每个单元都是材料单元且带出处'
  )
  const firstUnit = course.units[0]
  const ref = firstUnit.sources[0]
  ok(!!ref.locator && ref.locator.end > ref.locator.start, '单元带真实字符区间', JSON.stringify(ref.locator))
  ok(course.basedOn?.sourceId === imported.sourceId, '课程记下用的是哪一份资料')

  log('=== 4. 单元指回资料位置（点得开原文） ===')
  const srcBtn = q(`[data-testid="space-learn-unit-source-${firstUnit.id}-0"]`)
  ok(!!srcBtn, '单元上有来源按钮')
  click(srcBtn)
  await sleep(900)
  const previewText = q('[data-testid="space-learn-preview-text"]')
  ok(!!previewText && (previewText.textContent ?? '').length > 10, '预览显示原文正文', JSON.stringify((previewText?.textContent ?? '').slice(0, 32)))
  ok(!!q('[data-testid="space-learn-preview-note"]'), '标出定位到的字符区间')
  click(q('[data-testid="space-learn-preview-close"]'))
  await sleep(300)
  ok(!q('[data-testid="space-learn-preview"]'), '关掉后预览消失')

  log('=== 5. 调整顺序：下移第一节 ===')
  const before = course.units.map((u) => u.id)
  if (course.units.length > 1) {
    click(q(`[data-testid="space-learn-unit-down-${before[0]}"]`))
    await sleep(900)
    course = S().courses.find((c) => c.id === id)
    ok(course.units[0].id === before[1], '下移后顺序变了', course.units.slice(0, 2).map((u) => u.id).join(','))
    ok(course.units.length === before.length, '下移不增删单元')
  } else {
    log('  ⤺ 只有一个单元，跳过顺序检查')
  }

  log('=== 6. 插入一个补充单元（必须写清为什么） ===')
  click(q('[data-testid="space-learn-add"]'))
  await sleep(400)
  setInput(q('[data-testid="space-learn-add-title"]'), '自己补一个例子')
  const addSubmit = q('[data-testid="space-learn-add-submit"]')
  ok(!!addSubmit?.disabled, '补充单元没写说明前不能提交')
  setInput(q('[data-testid="space-learn-add-note"]'), '材料里没有我自己那个场景，补一个')
  await sleep(300)
  click(q('[data-testid="space-learn-add-submit"]'))
  await sleep(1000)
  course = S().courses.find((c) => c.id === id)
  const modelUnit = course.units.find((u) => u.origin === 'model')
  ok(!!modelUnit, '补充单元插进来了', String(course.units.length))
  ok(!!modelUnit?.note, '补充单元带说明', JSON.stringify(modelUnit?.note))

  log('=== 7. 材料单元没有出处 → 拒（同一道闸门） ===')
  const rejected = await window.yan.course.addUnit(id, { title: '凭空来的材料节', origin: 'material', sources: [] })
  ok(rejected.ok === false, 'IPC 层拒绝没有出处的材料单元', JSON.stringify(rejected.error))
  const accepted = await window.yan.course.addUnit(id, {
    title: '指回整份资料的一节',
    origin: 'material',
    sources: [{ sourceId: imported.sourceId, version: imported.version ?? 1 }]
  })
  ok(accepted.ok === true, '带出处就能加（同一道闸门放行）')
  if (accepted.ok) ok((await S().removeCourseUnit(id, accepted.course.units[accepted.course.units.length - 1].id)) === true, '清理这一节')

  log('=== 8. 改目标与建议学习量 ===')
  const target = q(`[data-testid="space-learn-unit-edit-${firstUnit.id}"]`)
  click(target)
  await sleep(300)
  setInput(q(`[data-testid="space-learn-unit-target-${firstUnit.id}"]`), '这一节要做到能复述前三段')
  setInput(q(`[data-testid="space-learn-unit-minutes-${firstUnit.id}"]`), '12')
  click(q(`[data-testid="space-learn-unit-save-${firstUnit.id}"]`))
  await sleep(900)
  const editedUnit = S().courses.find((c) => c.id === id)?.units.find((u) => u.id === firstUnit.id)
  ok(editedUnit?.target === '这一节要做到能复述前三段', '目标改上了', JSON.stringify(editedUnit?.target))
  ok(editedUnit?.estimateMinutes === 12, '建议学习量改上了', String(editedUnit?.estimateMinutes))

  log('=== 9. 入口二 / 三：主题与卡点骨架 ===')
  const topicCourse = await S().createCourseFromTopic({
    title: '探针主题课',
    goal: '把虚拟语气讲清楚',
    entry: 'topic',
    minutesPerDay: 20,
    ...(space.id ? { spaceId: space.id } : {})
  })
  ok(!!topicCourse && topicCourse.units.length > 0, '主题课建立并带骨架', String(topicCourse?.units.length ?? 0))
  ok(
    !!topicCourse && topicCourse.units.every((u) => u.origin === 'model' && !!u.note),
    '主题骨架全是补充单元且都有说明'
  )
  ok(!!topicCourse && topicCourse.basedOn === undefined, '主题课没有资料来源（不假装有）')

  const blockerCourse = await S().createCourseFromBlocker({
    title: '探针卡点课',
    goal: '搞清 since 和 for 的区别',
    entry: 'stuck',
    minutesPerDay: 15,
    ...(space.id ? { spaceId: space.id } : {})
  })
  ok(!!blockerCourse && blockerCourse.units.length > 0, '卡点课建立并带骨架')
  ok(
    !!blockerCourse && blockerCourse.units.every((u) => u.origin === 'model' && !!u.note),
    '卡点骨架全是补充单元且都有说明'
  )

  log('=== 10. 关闭重开：路线与顺序仍在 ===')
  const beforeReopen = S().courses.find((c) => c.id === id)
  click(q('[data-testid="space-close"]'))
  await sleep(400)
  click(q('[data-testid="view-space"]'))
  await sleep(600)
  click(q('[data-testid="space-tab-learning"]'))
  await sleep(900)
  const reopened = S().courses.find((c) => c.id === id)
  ok(!!reopened, '重开后课程还在')
  ok(
    reopened?.units.map((u) => u.id).join(',') === beforeReopen?.units.map((u) => u.id).join(','),
    '重开后单元顺序一致'
  )
  ok(
    reopened?.units.find((u) => u.id === firstUnit.id)?.target === '这一节要做到能复述前三段',
    '重开后改过的目标还在'
  )
  ok(reopened?.basedOn?.sourceId === imported.sourceId, '重开后资料的版本绑定还在')

  log('=== 11. 清理 ===')
  if (topicCourse) ok((await S().removeCourse(topicCourse.id)) === true, '删除主题课')
  if (blockerCourse) ok((await S().removeCourse(blockerCourse.id)) === true, '删除卡点课')
  ok((await S().removeCourse(id)) === true, '删除探针课程')
  await lib.remove(imported.sourceId)
  await S().updateSpace(space.id, { archived: true })

  return out.join('\n')
})()
