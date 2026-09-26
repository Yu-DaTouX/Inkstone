/**
 * 按活动配置模型（实施-25 P18）—— 真实窗口里走「配一行 → 看解释 → 清掉」。
 *
 * 盯住三件事：
 *   · 五行都在，且每行都会解释「为什么是这个模型」；
 *   · 活动那一档改了只影响那一行；
 *   · 固定文案写明「不会新建会话 / 不改任务与学习状态」。
 *
 * cost 0：只读写设置，不切模型、不跑任何会话。
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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  /*
   * 失焦才提交（组件是 onBlur 落盘）。
   * ⚠️ React 的 onBlur 实际监听 focusout —— 派发 blur 事件不会触发它。
   */
  const blur = (el) => el?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))

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

  log('=== 1. 接入页里的「按活动用不同模型」 ===')
  S().openSettings('auth')
  await sleep(1200)
  ok(!!q('[data-testid="set-activity-models"]'), '接入页有该区块')
  const scope = String(q('[data-testid="am-scope"]')?.textContent ?? '')
  ok(/不会新建会话/.test(scope), '固定文案写明「不会新建会话」', scope.slice(0, 24))
  ok(/不会动课程与学习进度/.test(scope), '固定文案写明「不动课程与学习进度」')
  for (const activity of ['answer', 'research', 'compose', 'organize', 'learn']) {
    ok(!!q(`[data-testid="am-row-${activity}"]`), `有 ${activity} 这一行`)
  }

  /* 从干净状态开始（防止上一次探针残留） */
  await yan.activity.setModel({ clear: true })
  await S().openSettings('auth')
  await sleep(900)

  log('=== 2. 活动那一档只影响那一行 ===')
  setInput(q('[data-testid="am-input-learn"]'), 'probe/learn-model')
  await sleep(200)
  blur(q('[data-testid="am-input-learn"]'))
  await sleep(900)
  const learnNote = String(q('[data-testid="am-note-learn"]')?.textContent ?? '')
  ok(/这个活动指定了用 probe\/learn-model/.test(learnNote), 'learn 行的解释说明「活动指定」', learnNote)
  const answerNote = String(q('[data-testid="am-note-answer"]')?.textContent ?? '')
  ok(!/probe\/learn-model/.test(answerNote), 'answer 行不受影响', answerNote)

  log('=== 3. 默认模型会体现在其它活动上 ===')
  setInput(q('[data-testid="am-default"]'), 'probe/default-model')
  await sleep(200)
  blur(q('[data-testid="am-default"]'))
  await sleep(900)
  const afterDefault = String(q('[data-testid="am-note-answer"]')?.textContent ?? '')
  ok(/默认模型 probe\/default-model/.test(afterDefault), '没单独指定的活动落到默认那一档', afterDefault)
  ok(
    /这个活动指定了用 probe\/learn-model/.test(String(q('[data-testid="am-note-learn"]')?.textContent ?? '')),
    '活动指定仍然优先于默认'
  )

  log('=== 4. 清掉之后回到「跟随会话」 ===')
  setInput(q('[data-testid="am-input-learn"]'), '')
  await sleep(200)
  blur(q('[data-testid="am-input-learn"]'))
  await sleep(900)
  setInput(q('[data-testid="am-default"]'), '')
  await sleep(200)
  blur(q('[data-testid="am-default"]'))
  await sleep(900)
  const cleared = await yan.activity.rows({ current: null })
  ok(cleared.every((row) => row.configured === null), '所有活动都回到「跟默认」')
  ok(
    cleared.every((row) => row.resolution.source === 'none' || row.resolution.source === 'current'),
    '没有配也没有会话模型时解析成「不指定」',
    cleared.map((r) => r.resolution.source).join(',')
  )

  log('=== 5. 回退规则（给可用清单时才会发生） ===')
  await yan.activity.setModel({ activity: 'research', model: 'gone/model' })
  const fell = await yan.activity.model({ activity: 'research', current: 'session/model', available: ['session/model'] })
  ok(fell.fellBack === true && fell.model === 'session/model', '配置的模型不可用：解析结果标了回退', JSON.stringify(fell))
  await yan.activity.setModel({ clear: true })
  const clean = await yan.activity.model({ activity: 'research' })
  ok(clean.fellBack === false && clean.model === null, '清掉之后不再回退')

  S().closeSettings?.()
  await sleep(300)
  return out.join('\n')
})()
