/**
 * 问答功能端到端（会真的调模型，成本约 $0.001）。
 *
 * 流程：
 *   1. 发一条明确要求「用 question 工具问我」的消息
 *   2. 等 UiBridge 弹出问题对话框（extension_ui_request → React modal）
 *   3. 点一个选项，断言对话框关闭、question 工具行出现且走完、答案回填
 *
 * 验证的是**真实链路**：内置 question 扩展 → ctx.ui.select →
 * pi 的 extension_ui_request → 主进程转发 → UiBridge 模态框 →
 * extension_ui_response → 工具返回 → 模型继续。
 * 全程有硬截止（deadline），保证在测试框架 kill 之前一定输出结果。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  /** 硬截止：约 72s，留足时间给测试框架收输出 */
  const deadline = Date.now() + 72000
  const waitFor = async (fn, step = 300) => {
    while (Date.now() < deadline) {
      const v = fn()
      if (v) return v
      await sleep(step)
    }
    return null
  }

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }

  /* 工作模式（实施-05）是**会话级**的：开始前把它归到标准，
     否则显式请求的 question 可能因上一场景留下的自主模式而被吞掉 */
  await store.getState().setWorkMode('standard')
  await sleep(400)

  const ready = await waitFor(() => store.getState().conn === 'ready' && true, 250)
  ok(!!ready, 'pi 已连接')
  await sleep(600)

  out.push('')
  out.push('=== 1. 发一条明确要求提问的消息 ===')
  const prompt =
    '这是一次功能自测。请只做一件事：调用 question 工具询问我「用哪种数据库？」，' +
    '选项给 SQLite 和 PostgreSQL。不要用普通文字提问，不要做其它事，不要执行命令。'
  const sent = await store.getState().send(prompt)
  ok(!sent || sent.ok !== false, '消息已发送')

  out.push('')
  out.push('=== 2. 等待模型主动提问（输入区上方的非模态面板）===')
  /* 契约：pi 扩展的 select/confirm/input/editor 走 QuestionPanel（非模态，
     输入区上方），不再是 .modal —— 模态那条只留给需要用户接管的场景。 */
  const PANEL = '[data-testid="question-panel"]'
  const modal = await waitFor(() => q(PANEL), 400)
  if (!modal) {
    const msgs = store.getState().messages.filter((m) => m.role === 'assistant' && m.text)
    out.push('  最近助手文字：' + JSON.stringify((msgs[msgs.length - 1]?.text ?? '').slice(0, 300)))
    out.push('  是否出现 question 工具行：' + qa('.trow').some((r) => r.getAttribute('data-tool') === 'question'))
  }
  ok(!!modal, '模型调用 question 后弹出了问题面板')
  if (!modal) return out.join('\n')

  const title = modal.querySelector('.qpanel-title')?.textContent ?? ''
  const opts = qa('.qpanel-option').map((e) => e.textContent)
  out.push('  标题：' + JSON.stringify(title))
  out.push('  选项：' + JSON.stringify(opts))
  ok(opts.length >= 2, '对话框里有可选答案（' + opts.length + ' 个）')
  ok(opts.some((x) => /SQLite/i.test(x ?? '')), '有模型给的 SQLite 选项')

  out.push('')
  out.push('=== 3. 选一个答案 ===')
  const pick = qa('.qpanel-option').find((e) => /SQLite/i.test(e.textContent)) ?? qa('.qpanel-option')[0]
  click(pick)
  const closed = await waitFor(() => !q(PANEL) && true, 200)
  ok(!!closed, '回答后面板关闭')

  out.push('')
  out.push('=== 4. question 工具行出现并完成 ===')
  const row = await waitFor(() => {
    const r = q('[data-tool="question"]')
    return r && r.getAttribute('data-state') !== 'running' && r.getAttribute('data-state') !== 'pending' ? r : null
  }, 300)
  ok(!!row, 'question 工具调用出现且已结束')
  if (row) {
    const state = row.getAttribute('data-state')
    out.push('  question 工具最终状态：' + state)
    ok(state !== 'error', 'question 工具没有报错')
  }

  out.push('')
  out.push('=== 5. 答案已回填给模型 ===')
  await waitFor(() => {
    const s = store.getState().session
    return !s?.isStreaming && !s?.isAgentRunning ? true : null
  }, 400)
  const anyText = store
    .getState()
    .messages.filter((m) => m.role === 'assistant')
    .map((m) => m.text)
    .join('\n')
  out.push('  助手文字片段：' + JSON.stringify(anyText.slice(-260)))
  ok(/SQLite/i.test(anyText), '模型回复里出现了用户选的答案（答案回填成功）')

  out.push('')
  out.push('=== 6. 自主模式：不再弹窗 ===')
  /* 自主模式现在是**本会话的工作模式**（实施-05），不再是全局布尔；
     它的作用点：系统提示 + question 工具的开头就会返回「请自行决策」 */
  await store.getState().setWorkMode('autonomous')
  await sleep(600)
  const m6 = await window.yan.getWorkMode()
  out.push('  当前会话模式：' + JSON.stringify(m6))
  ok(m6.mode === 'autonomous', '宿主侧已切到自主（模式按会话存）')
  await store.getState().send(
    '请调用 question 工具询问我「用哪种数据库？」（选项 SQLite / PostgreSQL），并且只做这一件事。'
  )
  // 给模型一次机会去触发；自主模式下不应出现任何提问 UI
  let sawModal = false
  for (let i = 0; i < 50 && Date.now() < deadline; i++) {
    const hit = q(PANEL) ?? q('.modal')
    if (hit) {
      sawModal = true
      /* 把命中的到底是什么打出来：`.modal` 是**通用**扩展 UI 弹层，
         它不等于 question 面板 —— 不区分会在排查时白跑一趟 */
      out.push('  命中元素：' + hit.className + ' :: ' + (hit.outerHTML || '').slice(0, 160))
      out.push(
        '  未应答的 UI 请求：' +
          JSON.stringify(
            store.getState().uiRequests.map((r) => ({
              id: r.id,
              method: r.method,
              title: r.title,
              sensitive: r.sensitive === true
            }))
          )
      )
      const calls = store
        .getState()
        .messages.flatMap((m) => (m.toolCalls ?? []).filter((c) => c.name === 'question'))
        .map((c) => ({ id: c.id, status: c.status, out: (c.output ?? '').slice(0, 140) }))
      out.push('  question 工具调用：' + JSON.stringify(calls.slice(-3)))
      break
    }
    await sleep(500)
  }
  ok(!sawModal, '自主模式下不弹出问题面板 / 对话框（用户不被中断）')
  if (sawModal) {
    // 万一模型还是问了，至少把它关掉，避免影响后续
    const cancel = [...document.querySelectorAll('.qpanel .btn, .modal .btn')].find((b) => /取消|Cancel/i.test(b.textContent))
    click(cancel ?? q('.modal .btn.icon'))
    await sleep(400)
  }
  await waitFor(() => {
    const s = store.getState().session
    return !s?.isStreaming && !s?.isAgentRunning ? true : null
  }, 400)
  // 还原，避免影响同批次后续场景
  await store.getState().setWorkMode('standard')
  out.push('  已还原工作模式 → 标准')

  return out.join('\n')
})()
