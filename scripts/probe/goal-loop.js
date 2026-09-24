/**
 * 自主档「大任务自己往下推」的端到端（实施-05 S3c，**会真的调模型**）。
 *
 * 验的是这一片唯一的出口：**没有人再发消息**，模型报完进展后，
 * 宿主 arm 的续行在回合空闲时真的把它叫起来，自动开始下一轮。
 *
 * 与 `goal.js`（S3b）的区别：
 *   · 那边是「计划档提交就绪 → 自动转标准开工」的**一次性**续行；
 *   · 这边是「自主档每报一次进展 → 自动叫醒一次」的**可重复**链路，
 *     所以探针要证明「新一轮不是用户触发的」（全程只发一条消息）。
 *
 * 为什么必须是真模型：`yan goal report` 的整条链路（bash → `yan` 启动器 →
 * 能力服务 → 宿主 arm → 薄层 custom 消息 → 新回合）没有一段能在单测里替代。
 * 磁盘结论交给 `afterExit`（`goalLoopPersisted`）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  /*
   * 每节自己的等待预算。
   *
   * ⚠️ 原来是一个全局 `deadline = Date.now() + 180000`，**各节共享** ——
   * 第 2 节（等 `yan goal report` 生效）把它吃光之后，第 3/4 节一进去就超时，
   * 报出来的却是「回合没空闲 / 续行没发生」（实测踩到，两次都是假红）。
   * 分节预算之后，一节慢不会再连坐后面的断言。
   */
  const waitFor = async (fn, step = 400, budgetMs = 60000) => {
    const until = Date.now() + budgetMs
    while (Date.now() < until) {
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

  /**
   * 失败时的现场（只打印，不判红）：模型没干活 / 没报告时，
   * 必须先分清是「根本没收到任务」「没调工具」还是「调了但被拒」。
   */
  const dumpDiagnostics = (label) => {
    const st = store.getState()
    const assistants = st.messages.filter((m) => m.role === 'assistant')
    const bashCalls = st.messages.flatMap((m) => (m.toolCalls ?? []).filter((c) => c.name === 'bash'))
    out.push(`  —— 诊断（${label}）——`)
    out.push(`  消息 ${st.messages.length} 条；助手 ${assistants.length}；bash 调用 ${bashCalls.length}`)
    out.push(
      `  session：isStreaming=${st.session?.isStreaming} isAgentRunning=${st.session?.isAgentRunning} conn=${st.conn}`
    )
    out.push(`  notices=${JSON.stringify((st.notices ?? []).map((n) => n.text).slice(-6))}`)
    out.push(
      `  activeRunnerId=${st.activeRunnerId} runners=${JSON.stringify(
        (st.runners ?? []).map((r) => ({ id: r.runId ?? r.id, gen: r.generation, active: r.isActive }))
      )}`
    )
    out.push(
      `  sessionRuntimes=${JSON.stringify(
        Object.entries(st.sessionRuntimes ?? {}).map(([k, v]) => ({
          k: String(k).slice(-24),
          sid: v?.sessionId,
          file: String(v?.sessionFile ?? '').split(/[\\/]/).pop(),
          msgs: (v?.messages ?? []).length
        }))
      ).slice(0, 900)}`
    )
    for (const c of bashCalls.slice(-3)) {
      out.push('  bash: ' + JSON.stringify(String(c.args?.command ?? c.args ?? '')).slice(0, 220))
    }
    for (const t of assistants.slice(-2)) out.push('  助手文本：' + JSON.stringify(String(t.content ?? '').slice(0, 300)))
  }

  const ready = await waitFor(() => store.getState().conn === 'ready', 250)
  ok(!!ready, 'pi 已连接')
  await sleep(800)

  out.push('')
  out.push('=== 1. 切到自主档（S3c 的起点）===')
  await store.getState().setWorkMode('autonomous')
  await sleep(600)
  const mode0 = await window.yan.getWorkMode()
  const goal0 = await window.yan.getGoal()
  ok(mode0.mode === 'autonomous', `宿主侧已切到自主档（${JSON.stringify(mode0)}）`)
  ok(goal0.goal.phase === 'planning' && goal0.goal.revision === 0, '目标还没开始（planning / rev0）')

  out.push('')
  out.push('=== 2. 只发一条消息：让模型报一次进展就收尾 ===')
  /*
   * 全程**只发这一条**。后面所有回合都必须是宿主的 control 消息叫起来的 ——
   * 这正是「大任务自己往下推」与「用户一直在催」的分界。
   */
  const reportFile = '.yan-goal-report-links.json'
  const command = `yan goal report --request-file ${reportFile}`
  const expectedLink = 'https://example.com/yan-goal-report-link'
  const prompt = [
    '这是一次功能自测，请按顺序完成下面四步：',
    '1) 用 bash 工具运行 `yan goal status`，读取当前 goalRevision。',
    `2) 用 write 工具在当前项目目录创建 ${reportFile}，内容为一个 JSON 对象：`,
    '   reportId="rp-loop-1"，phase="executing"，goalRevision 使用刚读到的值，',
    '   steps=[{"title":"目标报告链接链路","status":"done"}]，',
    `   links=[{"kind":"url","target":"${expectedLink}","label":"目标报告链接自测"}]。`,
    '   links 不要包含 source 或 check 字段。',
    '3) 用 bash 工具**原样、单行**运行下面这条命令，把 stdout 贴出来：',
    '',
    command,
    '',
    '4) 然后**立刻结束本轮回复**（只写一句「等待自动续接」），不要运行其它命令或继续分析。'
  ].join('\n')
  const sent = await store.getState().send(prompt)
  out.push(`  send 返回：${JSON.stringify(sent)}；notices=${JSON.stringify((store.getState().notices ?? []).map((n) => n.text).slice(-4))}`)
  ok(!sent || sent.ok !== false, '消息已发送（此后不再发第二条）')

  /*
   * 只要求「目标被报过一次进展」。
   *
   * 不押 phase 是 `executing`：模型很可能不照 prompt 里的 phase 字面写
   * （2026-09-22 实测：它自己决定报 `completed`，还顺手多报了几轮），
   * 而这一节的意图只是「模型真的调了 `yan goal report`」。
   */
  const reported = await waitFor(async () => {
    const g = await window.yan.getGoal()
    return g.goal.revision > 0 ? g : null
  }, 400, 90000)
  ok(!!reported, `目标被报过一次进展（实际 rev${reported?.goal?.revision ?? '?'} / ${reported?.goal?.phase ?? '?'}）`)
  if (!reported) dumpDiagnostics('等目标报告')

  out.push('')
  out.push('=== 3. 第一轮收尾（续行只能在真空闲时发出）===')
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
    /* 两个标志都在 `session` 里，不在顶层（踩过：读错字段会让「空闲」提前成立） */
    const busy = st.session?.isStreaming === true || st.session?.isAgentRunning === true
    return hasAssistant && !busy ? true : null
  }, 500)
  ok(!!idle, '提交轮已收尾（这一轮真的空闲了）')
  if (!idle) dumpDiagnostics('等回合空闲')
  const before = snapshot()

  out.push('')
  out.push('=== 4. 没有用户消息，自动起了新一轮（S3c 的核心证据）===')
  /*
   * 判据用**目标被再次推进**（revision 从 1 涨上去），而不是「助手消息数 +1」：
   * 自主链一旦跑起来，模型会在续行回合里干很多活（实测 18 条助手消息 / 15 次工具），
   * 探针取的基线一落下就已经在链尾 —— 计数增长会假红（2026-09-22 踩到两次）。
   * 而探针**全程只发过一条消息**，所以「revision 又涨了」只可能来自续行。
   */
  const resumed = await waitFor(async () => {
    const g = await window.yan.getGoal()
    return g.goal.revision > 1 ? g : null
  }, 600, 90000)
  ok(
    !!resumed,
    `自动续接真的起了新回合（目标被再次推进：rev${reported?.goal?.revision ?? '?'} → rev${resumed?.goal?.revision ?? '?'}，助手 ${before.assistants}→${snapshot().assistants}）`
  )
  if (!resumed) dumpDiagnostics('等自动续接')
  if (resumed) {
    const tail = store
      .getState()
      .messages.filter((m) => m.role === 'assistant')
      .slice(-1)
      .map((m) => String(m.content ?? '').slice(0, 160))
    out.push('  续接回合最后一段：' + JSON.stringify(tail))
  }

  out.push('')
  out.push('=== 5. 续接回来的那一轮还在推进同一个目标 ===')
  const advanced = await waitFor(async () => {
    const g = await window.yan.getGoal()
    return g.goal.revision > (reported?.goal?.revision ?? 0) ? g : null
  }, 700)
  if (advanced) {
    out.push(`  ✓ 目标被继续推进（rev${reported?.goal?.revision} → rev${advanced.goal.revision}，${advanced.goal.phase}）`)
  } else {
    /* 不判红：模型可以在续接轮里只干活不报告（报告口径是软约束） */
    out.push('  · 续接轮没有再次报告（允许：续行到达已由第 4 节证明）')
  }
  const finalGoal = await window.yan.getGoal()
  ok(finalGoal.goal.revision >= 1, `目标至少推进过一次（实际 rev${finalGoal.goal.revision}）`)
  ok(
    finalGoal.goal.links?.some((link) => link.kind === 'url' && link.target === expectedLink),
    '续接后模型报告链接仍保留'
  )
  ok(finalGoal.mode.mode === 'autonomous', '全程模式都是自主档（续行不是切档导致的）')

  /* 磁盘结论交给 afterExit 检查（窗口关掉后再读，避免只看到内存态） */
  return out.join('\n')
})()
