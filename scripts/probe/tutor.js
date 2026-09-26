/**
 * 导师页面（实施-25 P09）—— 真实窗口里走一遍三栏与「等作答」联动。
 *
 * 这一片全是界面，所以探针盯的是**界面有没有把宿主状态如实摆出来**：
 *   · 三栏（路线 / 导师对话 / 教材与练习）与档位（按容器宽度自适应）；
 *   · 没报进度时右栏是「先选一节」，不会假装有教材；
 *   · 点「学这一节」→ 宿主的学习位置指向那一节，右栏按单元的字符区间取到真正文；
 *   · 宿主说「等你作答」→ 中栏出问题与作答框，「给提示」这一刻才可点；
 *   · 在正文里划一段 → 出现「解释 / 举例 / 提问 / 出练习」；
 *   · 作答（走 IPC，不经模型）后闸门收掉、作答框消失；
 *   · 「先不学了」回到未开始，右栏不留下上一节的教材。
 *
 * 刻意不做的：点那五个能力按钮 —— 它们都会把文本交给主会话去发模型消息，
 * 本场景 cost 0。所以这里只验「该可点时可点」，不验点下去之后。
 * 另外「作答」按钮本身也走 `send`（既记录作答又给导师发一句）：
 * 探针用 `answerStudy` 直接记录，绕开模型那一段。
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

  const space = await S().createSpace('探针空间（导师页）')
  ok(!!space, '建空间成功', space?.id)
  if (!space) return out.join('\n')

  const cwd = String(S().settings?.cwd ?? '').replace(/[\/]+$/, '')
  const imported = await yan.library.import({
    kind: 'file',
    ref: `${cwd}/README.md`,
    title: '精读材料（导师页）',
    owner: { kind: 'course', id: 'probe-tutor' }
  })
  ok(imported?.ok === true, '导入成功', imported?.error)
  if (!imported?.ok) return out.join('\n')
  await S().refreshLibrary()
  await sleep(300)

  log('=== 2. 建课（材料单元带真实区间） ===')
  click(q('[data-testid="view-space"]'))
  await sleep(500)
  click(q('[data-testid="space-tab-learning"]'))
  await sleep(700)
  setInput(q('[data-testid="space-learn-new-title"]'), '导师页课程')
  setInput(q('[data-testid="space-learn-new-goal"]'), '读懂这份材料')
  setSelect(q('[data-testid="space-learn-new-entry"]'), 'source')
  await sleep(300)
  setSelect(q('[data-testid="space-learn-new-source"]'), imported.sourceId)
  await sleep(300)
  click(q('[data-testid="space-learn-create"]'))
  await sleep(1500)

  const course = S().courses.find((c) => c.title === '导师页课程')
  ok(!!course, '课程建立')
  if (!course) return out.join('\n') + '\n✗ 找不到刚建的课程'
  const unit = course.units[0]
  const ref = unit?.sources?.[0]
  ok(!!ref?.locator, '第一节带真实出处', JSON.stringify(ref?.locator))

  log('=== 3. 三栏与档位 ===')
  const ws = q('.wb-learn-ws')
  ok(!!ws, '三栏容器渲染')
  ok(!!q('[data-testid="space-learn-ws-left"]'), '左栏（课程与路线）在')
  ok(!!q('[data-testid="space-learn-chat"]'), '中栏（导师对话）在')
  ok(!!q('[data-testid="space-learn-material"]'), '右栏（教材与练习）在')
  const layout = ws?.getAttribute('data-layout')
  ok(['wide', 'mid', 'narrow'].includes(String(layout)), '档位合法', String(layout))
  const cols = ws ? getComputedStyle(ws).gridTemplateColumns.split(' ').length : 0
  ok(cols >= (layout === 'wide' ? 3 : layout === 'mid' ? 2 : 1), '档位与列数一致', `${layout}/${cols}`)
  ok(!!q('[data-testid="space-learn-chat-empty"]'), '没开始学：中栏是「还没开始」而不是假对话')
  ok(!!q('[data-testid="space-learn-material-pick"]'), '没开始学：右栏让先选一节')
  const hint = q('[data-testid="space-learn-act-hint"]')
  ok(hint?.disabled === true, '没等作答时「给提示」不可点')

  log('=== 4. 点「学这一节」→ 位置与教材 ===')
  const studyBtn = q(`[data-testid="space-learn-unit-study-${unit.id}"]`)
  ok(!!studyBtn, '单元上有「学这一节」')
  click(studyBtn)
  await sleep(1200)
  const status1 = S().studyStatus
  ok(status1?.session?.unitId === unit.id, '宿主的学习位置指向这一节', String(status1?.session?.unitId))
  ok(status1?.session?.courseId === course.id, '并且是这门课', String(status1?.session?.courseId))
  ok(!!q('[data-testid="space-learn-material-located"]'), '右栏标出这一段在资料里的位置')
  const body = q('[data-testid="space-learn-material-text"]')
  const bodyText = String(body?.textContent ?? '')
  ok(bodyText.length > 20, '右栏取到真正文', JSON.stringify(bodyText.slice(0, 32)))
  const opened = await yan.library.open(ref, { maxChars: 4000 })
  const real = String(opened?.text ?? '')
  const cut = real.slice(ref.locator.start, Math.min(ref.locator.start + 24, ref.locator.end))
  ok(cut.length > 0 && bodyText.includes(cut.slice(0, 12)), '取的就是这一段的原文（不是开头）', JSON.stringify(cut.slice(0, 24)))
  ok(!!q('[data-testid="space-learn-chat-where"]'), '中栏标出「第几节 · 什么状态」')

  log('=== 5. 等作答：问题 / 作答框 / 提示 ===')
  /* 真实流程里「prepare → 讲解中」是导师自己推进的（模型侧）；闸门只管能不能进等待。 */
  const explained = await S().advanceStudy('explaining')
  ok(explained === true, '阶段推进到讲解中', String(S().studyStatus?.session?.phase))
  const asked = await S().askStudy({ question: '这一段主要在讲什么？用一句话说。' })
  ok(asked === true, '宿主接受了提问（进入等你作答）', String(S().studyStatus?.session?.phase))
  await S().refreshStudyStatus()
  await sleep(700)
  ok(S().studyStatus?.waiting === true, '状态是等你作答')
  ok(!!q('[data-testid="space-learn-answer"]'), '中栏出现作答框')
  ok(
    String(q('[data-testid="space-learn-answer-question"]')?.textContent ?? '').includes('主要在讲什么'),
    '作答框里就是刚才那个问题'
  )
  ok(q('[data-testid="space-learn-act-hint"]')?.disabled === false, '等作答时「给提示」可点')

  log('=== 6. 划一段 → 四个动作 ===')
  if (body?.firstChild) {
    const range = document.createRange()
    range.setStart(body.firstChild, 0)
    range.setEnd(body.firstChild, Math.min(24, String(body.firstChild.textContent ?? '').length))
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await sleep(400)
  }
  ok(!!q('[data-testid="space-learn-selection"]'), '划选后出现选段动作')
  ok(!!q('[data-testid="space-learn-sel-explain"]'), '有「解释这一段」')
  ok(!!q('[data-testid="space-learn-sel-example"]'), '有「举个例子」')
  ok(!!q('[data-testid="space-learn-sel-ask"]'), '有「提问」')
  ok(!!q('[data-testid="space-learn-sel-exercise"]'), '有「出练习」（练习本身是 P10）')
  ok(!!q('[data-testid="space-learn-exercise"]'), '练习区挂着占位说明')

  log('=== 7. 作答（走 IPC）→ 闸门收掉 ===')
  const answered = await S().answerStudy('这一段讲的是这份说明文档是给谁看的。')
  ok(answered === true, '作答被记录', String(S().studyStatus?.session?.phase))
  await S().refreshStudyStatus()
  await sleep(600)
  ok(S().studyStatus?.waiting === false, '不再等你作答（闸门放了）')
  ok(!q('[data-testid="space-learn-answer"]'), '作答框收掉')

  log('=== 8. 暂停 / 恢复 ===')
  click(q('[data-testid="space-learn-pause"]'))
  await sleep(900)
  ok(S().studyStatus?.session?.paused === true, '暂停写进会话')
  click(q('[data-testid="space-learn-pause"]'))
  await sleep(900)
  ok(S().studyStatus?.session?.paused === false, '再点一下恢复')
  ok(S().studyStatus?.waiting === false, '暂停不算等你作答')

  log('=== 9. 先不学了 → 位置留在盘上、界面回到未开始 ===')
  const beforeStop = S().studyStatus?.session?.unitId
  click(q('[data-testid="space-learn-stop"]'))
  await sleep(900)
  ok(S().studyStatus?.session == null, '界面上的当前会话清掉')
  ok(!!q('[data-testid="space-learn-material-pick"]'), '右栏不再挂着上一节的教材')
  const sessions = await yan.study.list()
  const list = Array.isArray(sessions) ? sessions : []
  const kept = list.find((x) => x?.session?.courseId === course.id)?.session
  ok(!!kept && kept.unitId === beforeStop, '位置留在盘上（接着学还在这一节）', `${list.map((x) => x?.session?.courseId).join(',') || '空'}/${String(kept?.unitId)}`)
  ok(kept?.runtimeKey === '', '并且不再占着这个会话去拦续跑', JSON.stringify(kept?.runtimeKey))

  log('=== 10. 收尾：删掉这节课 ===')
  S().removeCourse(course.id)
  await sleep(900)
  const after = await yan.study.list()
  ok(!(Array.isArray(after) ? after : []).some((x) => x?.session?.courseId === course.id), '删课带走学习记录')

  return out.join('\n')
})()
