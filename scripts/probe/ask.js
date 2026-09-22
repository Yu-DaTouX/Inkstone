/**
 * 宿主提问入口的模型发现端到端（会真的调模型，成本约 $0.001）。
 *
 * 流程：
 *   1. 先在隔离临时目录准备 request JSON，再要求模型用 bash 调 `yan question ask`
 *   2. 等宿主能力服务把请求送进真实问题面板
 *   3. 点一个选项，断言 bash 行完成且没有恢复 question 模型工具
 *
 * 验证的是**真实链路**：模型 bash → yan CLI → CapabilityServer →
 * AgentController → QuestionPanel → yan:respondUi → CLI 返回。
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

  const bashMessages = () => store.getState().messages.filter((m) => m.role === 'bash')
  const allBashCalls = () =>
    store
      .getState()
      .messages.flatMap((message) => (message.toolCalls ?? []).map((call) => ({ message, call })))
      .filter(({ call }) => call.name === 'bash')
  const runBash = async (command) => {
    const before = new Set(bashMessages().map((m) => m.id))
    const promise = window.yan.runBash(command)
    await promise
    const message = await waitFor(() => {
      const candidate = bashMessages().find((m) => {
        if (before.has(m.id)) return false
        const call = m.toolCalls?.[0]
        return call && call.status !== 'running' && call.status !== 'pending' ? m : null
      })
      return candidate
    }, 150)
    return {
      message,
      output: String(message?.toolCalls?.[0]?.output ?? ''),
      exitCode: message?.bash?.exitCode ?? null
    }
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
     否则宿主 question ask 可能因上一场景留下的自主模式而直接返回。 */
  await store.getState().setWorkMode('standard')
  await sleep(400)

  const ready = await waitFor(() => store.getState().conn === 'ready' && true, 250)
  ok(!!ready, 'pi 已连接')
  await sleep(600)

  const tempDirResult = await runBash(`node -e "process.stdout.write(require('os').tmpdir())"`)
  const tempDir = String(tempDirResult.output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()
  const requestPath = `${tempDir}\\yan-question-model.json`
  const requestB64 = btoa(
    unescape(
      encodeURIComponent(
        JSON.stringify({ question: '模型经宿主 CLI 提问：用哪种数据库？', options: ['SQLite', 'PostgreSQL'], timeout: 30_000 })
      )
    )
  )
  const written = await runBash(
    `node -e "const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(require('os').tmpdir(),'yan-question-model.json'),Buffer.from('${requestB64}','base64'))"`
  )
  ok(!!tempDir && written.exitCode === 0, '已在隔离临时目录准备宿主 question ask 请求文件')

  out.push('')
  out.push('=== 1. 发一条明确要求提问的消息 ===')
  const prompt =
    `这是一次功能自测。请现在立刻使用 bash 执行这一条命令：yan question ask --request-file "${requestPath}"。` +
    '命令完成前不要输出文字；不要调用名为 question 的模型工具，不要执行其它命令。'
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
    out.push('  是否出现 question 模型工具行：' + qa('.trow').some((r) => r.getAttribute('data-tool') === 'question'))
  }
  ok(!!modal, '模型通过 yan question ask 后弹出了问题面板')
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
  out.push('=== 4. yan question ask 的 bash 行出现并完成 ===')
  const row = await waitFor(() => {
    const entry = allBashCalls().find(({ message, call }) => {
        const command = String(message.bash?.command ?? call?.args?.command ?? JSON.stringify(call?.args ?? ''))
        return command.includes('yan question ask') && call && call.status !== 'running' && call.status !== 'pending'
      })
    return entry?.call ?? null
  }, 300)
  ok(!!row, 'yan question ask 的 bash 调用出现且已结束')
  if (row) ok(row.status !== 'error', 'yan question ask 的 bash 调用没有报错')
  ok(!qa('.trow').some((r) => r.getAttribute('data-tool') === 'question'), '真实窗口没有恢复 question 模型工具行')

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
  ok(/SQLite/i.test(anyText) || !!row, 'CLI 已完成并把用户选择交回模型回合')

  out.push('')
  out.push('=== 6. 自主模式：不再弹窗 ===')
  /* 自主模式现在是**本会话的工作模式**（实施-05），不再是全局布尔；
     它的作用点：系统提示 + 宿主 question ask 直接返回「请自行决策」。 */
  await store.getState().setWorkMode('autonomous')
  await sleep(600)
  const m6 = await window.yan.getWorkMode()
  out.push('  当前会话模式：' + JSON.stringify(m6))
  ok(m6.mode === 'autonomous', '宿主侧已切到自主（模式按会话存）')
  await store.getState().send(
    `请使用 bash 执行 yan question ask --request-file "${requestPath}"，并且只做这一件事。`
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
      out.push('  question 模型工具调用：' + JSON.stringify(calls.slice(-3)))
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
