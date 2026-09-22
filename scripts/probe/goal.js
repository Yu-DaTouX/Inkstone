/**
 * 计划就绪转移的端到端（实施-05 S3，**会真的调一次模型**）。
 *
 * 验的是 S3 的核心出口：「条件齐全 → 自动标准执行**恰好一次**」。
 * 整条链路没有一个环节是模拟的：
 *
 *   模型 → bash 工具 → `yan` CLI → 宿主能力服务（身份校验）→ goal 服务（校验 +
 *   幂等 + 落盘）→ 模式 store（切 standard）+ 快照（扩展读）→ 界面（工具卡归属）
 *
 * 探针只做两件事：把模式切到计划档、把要跑的命令**原封不动**交给模型。
 * 命令是内联参数形式 —— 计划档禁写文件，所以提交必须能不带请求文件完成
 * （这正是 `normalizeReadyParams` 存在的理由）。
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
  /** 硬截止：约 130s（要留够两次真实模型回合：提交 + 续行） */
  const deadline = Date.now() + 130000
  const waitFor = async (fn, step = 400) => {
    while (Date.now() < deadline) {
      const v = await fn()
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

  const ready = await waitFor(() => store.getState().conn === 'ready', 250)
  ok(!!ready, 'pi 已连接')
  await sleep(800)

  out.push('')
  out.push('=== 1. 切到计划档（就绪转移的起点）===')
  await store.getState().setWorkMode('clarify')
  await sleep(600)
  const mode0 = await window.yan.getWorkMode()
  const goal0 = await window.yan.getGoal()
  ok(mode0.mode === 'clarify', `宿主侧已切到计划档（${JSON.stringify(mode0)}）`)
  ok(goal0.goal.phase === 'planning' && goal0.goal.revision === 0, '目标还没开始（planning / rev0）')

  out.push('')
  out.push('=== 2. 让模型用内联参数提交就绪（计划档不能写文件）===')
  /*
   * revision 必须**当场读**再拼进命令：模型拿旧值提交会被宿主判过期，
   * 那是设计（两条腿同时到达只有一次生效），不是故障。
   */
  const command =
    'yan goal ready --transition-id tr-probe-1 --confidence 0.98 ' +
    '--goal "给设置页加一个导出按钮" --deliverable "导出按钮 + CSV 下载" ' +
    '--scope "仅设置页" --constraints "不引入新依赖" --acceptance "点一下能下载 CSV" ' +
    `--mode-revision ${mode0.revision} --goal-revision ${goal0.goal.revision}`
  const prompt =
    '这是一次功能自测。请只做一件事：用 bash 工具**原样、单行**运行下面这条命令，' +
    '然后把 stdout 原样贴出来。不要改动任何参数、不要拆成多条、不要执行其它命令：\n\n' +
    command
  const sent = await store.getState().send(prompt)
  ok(!sent || sent.ok !== false, '消息已发送')

  out.push('')
  out.push('=== 3. 等待就绪转移生效（模式自动切标准 + 目标进入执行）===')
  const switched = await waitFor(async () => {
    const m = await window.yan.getWorkMode()
    return m.mode === 'standard' ? m : null
  })
  ok(!!switched, `模式自动切到标准（${JSON.stringify(switched)}）`)
  const afterReady = await window.yan.getGoal()
  ok(afterReady.goal.phase === 'executing', `目标进入 executing（实际 ${afterReady.goal.phase}）`)
  ok(afterReady.goal.revision === 1, `目标 revision = 1（恰好推进一次，实际 ${afterReady.goal.revision}）`)

  out.push('')
  out.push('=== 4. 界面把这条命令认成「砚内置目标状态」===')
  await sleep(600)
  const originCards = qa('[data-origin="yan-goal"]')
  ok(originCards.length > 0, `出现目标状态工具卡（${originCards.length} 张）`)
  const srcLabels = qa('[data-origin="yan-goal"] [data-testid="tool-src"]').map((el) => el.textContent?.trim())
  ok(srcLabels.length > 0, `工具卡带来源标签：${JSON.stringify(srcLabels)}`)
  ok(
    srcLabels.some((text) => /目标/.test(text ?? '')),
    '来源标签写明是「目标」（不是让用户以为模型在乱敲 bash）'
  )

  out.push('')
  out.push('=== 5. 模型确实跑了那条命令 ===')
  const bashCalls = store
    .getState()
    .messages.flatMap((m) => (m.toolCalls ?? []).filter((c) => c.name === 'bash'))
    .map((c) => JSON.stringify(c.args ?? ''))
  const ranGoal = bashCalls.some((text) => text.includes('yan goal ready'))
  ok(ranGoal, `bash 调用里含 yan goal ready（共 ${bashCalls.length} 次 bash 调用）`)
  if (!ranGoal) {
    const tail = store
      .getState()
      .messages.filter((m) => m.role === 'assistant')
      .slice(-1)
      .map((m) => String(m.content ?? '').slice(0, 200))
    out.push('  最后一条助手文本：' + JSON.stringify(tail))
  }

  out.push('')
  out.push('=== 6. 就绪之后目标状态可读（界面「看到现在到哪了」的接口）===')
  const status = await window.yan.getGoal()
  ok(JSON.stringify(status.goal).includes('executing'), 'getGoal 返回执行中的目标')
  ok(status.mode.mode === 'standard', 'getGoal 同时带回当前模式（一次往返拿全）')

  out.push('')
  out.push('=== 7. 就绪之后自动续行（宿主控制消息触发的新回合）===')
  /*
   * 主证据在 afterExit（会话文件里的 `yan-goal-resume` / `yan-goal-ready` 条目）。
   *
   * 探针这里要小心一件事：续行是**延迟触发**的（扩展要等回合真的空闲，1800ms 二次确认），
   * 所以不能拿「现在有几条助手消息」当基准就开等 —— 得先确认提交轮已经收尾。
   */
  const snapshot = () => {
    const msgs = store.getState().messages
    return {
      assistants: msgs.filter((m) => m.role === 'assistant').length,
      tools: msgs.flatMap((m) => m.toolCalls ?? []).length
    }
  }
  const idle = await waitFor(async () => {
    const st = store.getState()
    const hasAssistant = st.messages.some((m) => m.role === 'assistant')
    /*
     * ⚠️ 两个标志都在 `session` 里，不在顶层 —— 读错字段会让「空闲」
     * 在第一次 toolResult 的空档就成立，于是本轮在模型写下最后一句之前就结束，
     * 续行永远等不到机会（踩过一次：日志停在 toolResult）。
     */
    const busy = st.session?.isStreaming === true || st.session?.isAgentRunning === true
    return hasAssistant && !busy ? true : null
  }, 500)
  ok(!!idle, '提交轮已收尾（这一轮真的空闲了）')
  const before = snapshot()
  /* 等续行带来的**新动作**：新助手消息或新工具调用都算（目标执行常从工具开始） */
  const resumed = await waitFor(async () => {
    const now = snapshot()
    return now.assistants > before.assistants || now.tools > before.tools ? now : null
  }, 600)
  ok(
    !!resumed,
    `续行真的起了一个新回合（助手 ${before.assistants}→${resumed?.assistants ?? before.assistants}，工具 ${before.tools}→${resumed?.tools ?? before.tools}）`
  )
  if (resumed) {
    const tail = store
      .getState()
      .messages.filter((m) => m.role === 'assistant')
      .slice(-1)
      .map((m) => String(m.content ?? '').slice(0, 160))
    out.push('  续行回合最后一段：' + JSON.stringify(tail))
  }

  /* 磁盘结论交给 afterExit 检查（窗口关掉后再读，避免只看到内存态） */
  return out.join('\n')
})()
