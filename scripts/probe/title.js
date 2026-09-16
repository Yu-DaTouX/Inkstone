/**
 * N11 会话标题：真实模型下的生成与"候选 / 手动名"规则。
 *
 * 为什么不能只用单测：标题会**另起一个 pi 进程**跑归纳请求（`--no-session`），
 * 「生成成功」「生成失败保留原标题」「并发第二次被挡」都发生在进程边界上。
 * 纯逻辑（样本挑选）由 `test-title-samples.mjs` 覆盖，这里只验真机行为。
 *
 * 四件事：
 *   ① 没有用户文字 → 明确报错、不发起请求（不是静默失败）
 *   ② 一轮对话后自动出现标题（左栏与缓存都拿到）
 *   ③ 单次生成锁：并发两次，第二次明确回「正在生成」而不是排队/重复生成
 *   ④ 手动名是粘性的：自动生成不覆盖它；重生成只产出**候选**，采用后才落盘
 *
 * 成本：2 次聊天 + 最多 4 次标题归纳（标题请求很短）。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const until = async (fn, ms = 60000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(250)
    }
    return false
  }
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const sid = () => store.getState().session?.sessionId ?? ''
  const send = async (text) => {
    const ta = q('[data-testid="composer"]')
    setVal(ta, text)
    await sleep(250)
    q('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  const waitTurn = async () => {
    const before = store.getState().messages.filter((m) => m.role === 'assistant' && m.text).length
    return until(
      () =>
        store.getState().messages.filter((m) => m.role === 'assistant' && m.text).length > before &&
        !store.getState().session?.isStreaming &&
        !q('.cursor'),
      120000
    )
  }

  for (let i = 0; i < 60; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  if (store.getState().conn !== 'ready') return '✗ pi 未连上'
  store.getState().closeSettings()
  await sleep(300)

  /* ---------------- 1. 没有用户文字：明确报错 ---------------- */
  log('=== 1. 空会话：没有可归纳的用户文字 ===')
  await store.getState().newSession({ scope: 'global' })
  await sleep(1500)
  const emptySid = sid()
  const empty = await window.yan.regenerateTitle(emptySid)
  log(`  ${JSON.stringify(empty)}`)
  ok(empty?.ok === false, '空会话重生成标题被明确拒绝（不是静默失败）')
  /*
   * 两条路径的措辞不同（都是"明确失败，不静默"）：
   *   · 当前就是活会话 → agent 那条：'标题生成失败，已保留原标题'（它自己知道没有用户文字）
   *   · 非活会话（从磁盘读）→ 主进程那条：'该会话没有可用的用户文字，已保留原标题'
   */
  ok(
    /没有可用的用户文字|保留原标题/.test(empty?.error ?? ''),
    '错误里说清原因（没有可用文字 / 已保留原标题）',
    String(empty?.error)
  )
  ok(!store.getState().titles[emptySid], '空会话没有凭空写入标题缓存')

  /* ---------------- 2. 一轮对话后自动生成标题 ---------------- */
  log('\n=== 2. 第一次对话后自动出现标题 ===')
  await send('请用一句话说明 RAII 是什么，不要调用任何工具。')
  const replied = await waitTurn()
  ok(replied, '这一轮正常结束')
  const autoArrived = await until(() => {
    const t = store.getState().titles[sid()]
    return typeof t === 'string' && t.length > 0
  }, 90000)
  const autoTitle = store.getState().titles[sid()]
  log(`  自动标题：${JSON.stringify(autoTitle)}`)
  ok(autoArrived, '自动生成标题并推给界面（左栏数据源）')
  ok(typeof autoTitle === 'string' && autoTitle.length > 0, '标题非空')
  ok((autoTitle ?? '').length <= 18, '标题不超过 18 个字符（左栏放得下）', `${(autoTitle ?? '').length}`)
  ok(!/^(标题|title)\s*[:：]/i.test(autoTitle ?? ''), '标题里没有「标题：」这类前缀')

  /* ---------------- 3. 单次生成锁 ---------------- */
  log('\n=== 3. 并发两次：第二次明确回「正在生成」 ===')
  const [a, b] = await Promise.all([
    window.yan.regenerateTitle(sid()),
    window.yan.regenerateTitle(sid())
  ])
  log(`  A=${JSON.stringify(a)}`)
  log(`  B=${JSON.stringify(b)}`)
  const okCount = [a, b].filter((r) => r?.ok).length
  const busyErr = [a, b].map((r) => r?.error ?? '').find((e) => /正在生成/.test(e)) ?? ''
  ok(okCount === 1, '两次并发只跑了一次生成（另一次被锁挡住）', `ok=${okCount}`)
  ok(!!busyErr, '被挡住的那次给出可解释的错误', busyErr || '(无)')

  /* ---------------- 4. 手动名粘性 + 候选 → 采用 ---------------- */
  log('\n=== 4. 手动名不被自动标题覆盖；重生成只出候选 ===')
  const manual = '手动标题-N11'
  await store.getState().setManualTitle(sid(), manual)
  await sleep(500)
  ok(store.getState().manualTitles[sid()] === manual, '手动名写进 store（左栏优先用它）')
  const titleBeforeManualTurn = store.getState().titles[sid()]
  await send('再补一句：用一句话说明什么是编译期常量，不要调用任何工具。')
  const replied2 = await waitTurn()
  await sleep(1500)
  ok(replied2, '手动名存在时这一轮照样正常结束')
  ok(store.getState().manualTitles[sid()] === manual, '自动生成没有覆盖手动名（粘性）', String(store.getState().manualTitles[sid()]))
  log(`  自动缓存：${JSON.stringify(titleBeforeManualTurn)} → ${JSON.stringify(store.getState().titles[sid()])}`)

  /* 重生成：手动名存在时只产出候选，采用后才成为手动名 */
  const regen = await window.yan.regenerateTitle(sid())
  log(`  重生成：${JSON.stringify(regen)}`)
  ok(regen?.ok === true && !!regen.title, '手动名存在时仍能生成候选')
  ok(store.getState().manualTitles[sid()] === manual, '候选**没有**直接顶掉手动名（要用户采用）')
  /* store 那条路径：把候选交给界面，再采用 */
  await store.getState().regenerateTitle(sid())
  await sleep(500)
  const candidate = store.getState().titleCandidates[sid()]
  log(`  候选：${JSON.stringify(candidate)}`)
  ok(!!candidate, '重生成把结果放成「候选」（界面给采用/忽略）')
  if (candidate) {
    await store.getState().acceptTitleCandidate(sid())
    await sleep(500)
    ok(store.getState().manualTitles[sid()] === candidate, '采用后手动名变成候选内容', String(store.getState().manualTitles[sid()]))
    ok(!store.getState().titleCandidates[sid()], '采用后候选被清掉（不会一直挂着）')
  }

  /* 收尾：清掉手动名，别把沙箱状态留给后面的场景 */
  await store.getState().setManualTitle(sid(), '')
  await sleep(400)
  log('\n  收尾：手动名已清除')

  return out.join('\n')
})()
