/**
 * 结构化压缩摘要的**逐类字段**取证（N21-6 最后一项，cost 1）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个场景为什么长成这样（一次真实的失败换来的）
 * ══════════════════════════════════════════════════════════════════
 * 最初的设计是「长会话触发压缩 → `session_before_compact` 接管 → 断言摘要逐类非空」。
 * 实测（pi 0.85.1，2026-09-18）**走不通**：
 *   · 砚自己的 policy 线触发的那次压缩：`reason: 'manual'`、2ms 完成；
 *   · 让 pi 自己按 `reason: 'threshold'` 触发的那次：**真的调了模型**（5.7s、摘要 280 token）
 *     —— 但两种情况 `session_before_compact` 都**一次没被调到**（连专门加的 `entered`
 *     取证都是空的）。
 * 也就是说：在 pi 0.85.1 上，`session_before_compact` 这条接管通道在真实压缩里进不去。
 * 这是**发现**，不是可以靠改断言绕过去的东西 —— 已登记在归档 §1.19。
 *
 * 于是本场景改成能真正取证的那部分：
 *   ① 跑够让**状态生成器**真的落盘（两个回合：只有一个 settled 机会时，
 *      模型偶尔会返回不合法 JSON，生成器就空手而归 —— 实测过一次）；
 *   ② 剩下的「接管摘要逐类字段非空」由退出后的检查在**真实状态文件**上
 *      调真实的 `buildStructuredSummary` 来判；
 *   ③ 「pi 到底调了几次钩子」一并如实记下（当前是 0，这就是上面那个发现）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(400)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 60; i++) {
    if (S().conn === 'ready' && S().session?.model?.contextWindow) break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  const win = S().session?.model?.contextWindow
  /* 退出后的日志检查靠它做会话隔离（沙箱是多个场景共用的） */
  out.push(`  ctxsum.sessionId=${S().session?.sessionId ?? ''}`)
  const budget = S().session?.contextPolicy?.budget ?? (await window.yan.contextBudget(win))?.budget
  if (!budget) return '  ⤺ 跳过：没有工作集预算'
  log(`  模型窗口 ${win}｜工作集 ${budget.workingSet}｜压缩线 ${budget.triggers.compact}`)

  /** 一个回合：发出 → 等真的开始 → 等停下 */
  const sendTurn = async (text, ms) => {
    const box = q('[data-testid="composer"]')
    if (!box) return { sent: false, started: false }
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(200)
    const btn = q('[data-testid="send"]')
    if (!btn) return { sent: false, started: false }
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    let started = false
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (S().session?.isAgentRunning || S().session?.isStreaming) started = true
      else if (started) break
      await sleep(400)
    }
    return { sent: true, started }
  }

  /*
   * 两个回合的理由：生成器的门是 `agent_settled`，而它调模型那一步会被
   * 「输出不是合法 JSON / 缺 objective」拒掉（那属于模型侧波动，不是代码问题）。
   * 只发一个回合时，实测有一次就是这么空手而归的；两个回合把这件事的概率压下去。
   */
  const turns = [
    '运行 `node -e "console.log(40+2)"`，然后只回复这个结果。',
    '运行 `node -e "console.log(6*7)"`，然后只回复这个结果。'
  ]
  for (let i = 0; i < turns.length; i++) {
    log('')
    log(`=== ${i + 1}. 小回合（给生成器造 evidence）===`)
    const r = await sendTurn(turns[i], 90_000)
    ok(r.sent, `回合 ${i + 1} 已发出`)
    ok(r.started, `回合 ${i + 1} 真的跑起来了`)
    if (!r.started) break
    log('  等生成器落盘（异步，最多 20s）')
    await sleep(20_000)
    ok(!S().session?.isAgentRunning, '等待期间没有卡在「运行中」（生成不阻塞输入）')
  }

  const cu = S().stats?.contextUsage
  log('')
  log(`  最终 pi 用量=${cu ? `${cu.tokens}/${cu.contextWindow}` : 'null'}｜工作集=${budget.workingSet}`)

  return out.join('\n')
})()
