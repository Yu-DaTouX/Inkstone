/**
 * 语音与内容形式（实施-25 P20）—— 真实窗口里走「拿路径 → 只填不发 → 登记到同一门课」。
 *
 * 盯住三件事：
 *   · 砚**不做识别与朗读**：卡上给的是外部能力的接入路径（与 P17 同一条）；
 *   · 「填到输入框」只填不发；
 *   · 转写登记成**同一门课**的新来源：课程数量与课程 id 不变（不新建课程、不动进度）。
 *
 * cost 0：不调用任何真实的语音服务，也不发模型消息。
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

  log('=== 1. 建课（音频与转写要落在同一门课上） ===')
  const modeSwitch = null /* 左栏拨杆已移除（实施-27 B3）：模式入口在设置 · 工作区 */
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  const space = await S().createSpace('探针空间（语音）')
  ok(!!space, '建空间成功', space?.id)
  if (!space) return out.join('\n')

  const cwd = String(S().settings?.cwd ?? '').replace(/[\/]+$/, '')
  const audio = await yan.library.import({
    kind: 'text',
    ref: 'probe://lecture-3',
    identity: 'audio:probe-lecture-3',
    title: '第三讲的录音（探针）',
    content: '（这里假装是一段录音：先把讲的内容念一遍。）'
  })
  ok(audio?.ok === true, '把「录音」导入资料库', audio?.error)
  if (!audio?.ok) return out.join('\n')
  await S().refreshLibrary()
  await sleep(300)

  click(q('[data-testid="view-space"]'))
  await sleep(500)
  click(q('[data-testid="space-tab-learning"]'))
  await sleep(700)
  setInput(q('[data-testid="space-learn-new-title"]'), '语音课（探针）')
  setInput(q('[data-testid="space-learn-new-goal"]'), '把这段录音听完')
  const select = q('[data-testid="space-learn-new-entry"]')
  if (select) {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'source')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(300)
    const srcSelect = q('[data-testid="space-learn-new-source"]')
    if (srcSelect) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(srcSelect, audio.sourceId)
      srcSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(300)
    }
  }
  const createBtn = q('[data-testid="space-learn-create"]')
  ok(
    createBtn?.disabled !== true,
    '创建按钮可点',
    JSON.stringify({
      disabled: createBtn?.disabled,
      title: String(q('[data-testid="space-learn-new-title"]')?.value ?? ''),
      goal: String(q('[data-testid="space-learn-new-goal"]')?.value ?? ''),
      entry: String(q('[data-testid="space-learn-new-entry"]')?.value ?? ''),
      source: String(q('[data-testid="space-learn-new-source"]')?.value ?? ''),
      options: q('[data-testid="space-learn-new-source"]')?.options?.length ?? 0,
      notice: JSON.stringify((S().notices ?? []).slice(-1)[0] ?? null),
      err: String(q('[data-testid="space-learn-error"]')?.textContent ?? '')
    })
  )
  click(createBtn)
  await sleep(1500)
  const course = S().courses.find((c) => c.title === '语音课（探针）')
  ok(!!course, '课程建立', course?.id)
  if (!course) return out.join('\n') + '\n✗ 课程没建上'
  const unit = course.units[0]
  const coursesBefore = S().courses.length

  click(q(`[data-testid="space-learn-unit-study-${unit.id}"]`))
  await sleep(1400)

  log('=== 2. 语音卡：只说路径，不做识别 ===')
  ok(!!q('[data-testid="space-learn-audio"]'), '右栏出现「语音」卡')
  const boundary = String(q('[data-testid="space-audio-boundary"]')?.textContent ?? '')
  ok(/不自带语音识别与朗读/.test(boundary), '卡上写明砚不自带识别与朗读', boundary.slice(0, 24))

  click(q('[data-testid="space-audio-plan-transcribe"]'))
  await sleep(900)
  const plan = String(q('[data-testid="space-audio-plan-text"]')?.textContent ?? '')
  ok(/capabilities search/.test(plan), '转写计划给的是能力发现入口')
  ok(/capabilities prepare/.test(plan) && /capabilities acquire/.test(plan), '接着给 prepare → acquire')
  ok(/同一门课/.test(plan), '计划里写明归到同一门课')
  ok(!/已转写|自动转写完成/.test(plan), '没有「已经转好了」这种承诺')

  log('=== 3. 只填不发 ===')
  const before = (S().messages ?? []).length
  click(q('[data-testid="space-audio-send"]'))
  await sleep(700)
  const box = String(q('[data-testid="composer"]')?.value ?? '')
  ok(/capabilities search/.test(box), '计划被填进输入框', box.slice(0, 24))
  ok((S().messages ?? []).length === before && S().session?.isStreaming !== true, '没有发出任何消息')

  log('=== 4. 转写登记到同一门课 ===')
  ok(!!q('[data-testid="space-audio-source"]'), '卡上显示会挂到哪个来源')
  const empty = await yan.audio.transcript({ courseId: course.id, sourceId: unit.sources[0].sourceId, text: '   ' })
  ok(empty?.ok === false, '空转写：拒掉（不登记一份空来源）', String(empty?.error))

  setInput(q('[data-testid="space-audio-transcript"]'), '这一讲主要讲了界面里的三处收紧。')
  await sleep(200)
  click(q('[data-testid="space-audio-register"]'))
  await sleep(1500)
  const note = String(q('[data-testid="space-audio-note"]')?.textContent ?? '')
  ok(/同一门课的新来源/.test(note), '登记结果说清「同一门课的新来源」', note.slice(0, 30))
  ok(/课程与学习进度没有变/.test(note), '登记不改变课程与学习进度')

  const after = S().courses
  ok(after.length === coursesBefore, '课程数量没变（**没有新建课程**）', `${coursesBefore} → ${after.length}`)
  ok(after.some((c) => c.id === course.id), '原课程还在（身份不变）')
  await S().refreshLibrary()
  await sleep(400)
  const transcripts = S().library.filter((s) => s.title.startsWith('转写：'))
  ok(transcripts.length >= 1, '资料库里多了一份转写来源', String(transcripts.length))

  log('=== 5. 收尾 ===')
  for (const s of S().library.filter((x) => x.title.includes('探针'))) await yan.library.remove(s.id)
  await S().removeCourse(course.id)
  await S().refreshLibrary()
  await sleep(600)
  ok(!S().courses.some((c) => c.id === course.id), '课程已删')
  return out.join('\n')
})()
