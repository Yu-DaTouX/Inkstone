/**
 * Episode 折叠（§12.6）的真实回合取证 —— 配 `contextepisode` 场景（cost 1）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这个探针要让 bash 输出一大段文本
 * ══════════════════════════════════════════════════════════════════
 * Episode 的候选区间 = 「已经离开 `recentTail` 尾部窗口」的那一段历史。会话太短时
 * 窗口为空，**没有可折叠的东西** —— 那时跑出来的「零 Episode」证明不了任何事。
 * 所以这里让模型真的跑一条会输出几千字符的命令（历史上一个回合就有几千 token），
 * 同时把 `recentTail` 压到几百 token（测试通道），让前面那段必然落在窗口之外。
 *
 * ── 「模型没给 episode」不是失败 ──
 * 收束判据在模型的输出里（`unresolved` 为空才算收束），它有权认为这段还没完。
 * 所以检查函数把两件事分开：**「边界算得出来」是硬证据**，
 * 「真的落了 Episode」是更强的证据（有就逐字段验，没有就如实报告）。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(200)
    } else await sleep(120)
  }
  await sleep(400)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 60; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  const sessionId = S().session?.sessionId ?? ''
  log(`  会话 id = ${sessionId || '(未知)'}`)

  const send = async (text) => {
    const ta = q('[data-testid="composer"]')
    if (!ta) return false
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(150)
    const button = q('[data-testid="send"]')
    if (!button) return false
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }

  const turn = async (text, ms) => {
    if (!(await send(text))) return { sent: false, started: false }
    let started = false
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const running = !!S().session?.isAgentRunning || !!S().session?.isStreaming
      if (running) started = true
      else if (started) return { sent: true, started: true }
      await sleep(400)
    }
    return { sent: true, started }
  }

  const toolOutputs = () =>
    (S().messages ?? []).flatMap((m) => m.toolCalls ?? []).map((t) => ({ name: t.name, len: (t.output ?? '').length }))

  /* ---------------- 一个真实回合：长输出 → 历史超过尾部窗口 ---------------- */
  log('')
  log('=== 真实回合：一条输出几千字符的命令（把历史推到尾部窗口之外）===')
  const PROMPT =
    '你必须先调用 bash 工具执行这条命令：seq 1 400 。调用完成后，只回复最后一行数字。不要省略工具输出。'
  let t1 = await turn(PROMPT, 180_000)
  let outputs = toolOutputs()
  if (!outputs.length) {
    log('  第一次没看到工具调用，重试一次')
    t1 = await turn(PROMPT, 180_000)
    outputs = toolOutputs()
  }
  log(`  回合已发出=${t1.sent}｜真的跑起来=${t1.started}｜消息数=${(S().messages ?? []).length}`)
  log('  工具调用: ' + JSON.stringify(outputs))
  ok(!!outputs.length, '模型真的调用了工具（历史里才有足够长的、能离开尾部窗口的内容）', outputs[0]?.name ?? '')
  ok((outputs[0]?.len ?? 0) > 1000, `工具输出足够长（${outputs[0]?.len ?? 0} 字符）`)

  /*
   * 回合 1 之后的生成器要**先跑完**：它是单飞的，不等它的话，回合 2 结束时的第二次
   * 生成会直接被 `in-flight` 拦掉（真实链路上确实发生过，诊断行会写 `hook:skipped`）。
   * 探针看不到 `YAN_DATA_DIR`，只能等一段足够长的时间（本地模型生成内部有 45s 上限）。
   */
  log('')
  log('=== 等第一次生成落盘（异步，本地模型最多 45s）===')
  await sleep(50_000)

  /*
   * ---------------- 第 2 个回合 ----------------
   *
   * 为什么必须要第二个回合：尾部窗口（`planTailCut`）**至少保留最后一个 unit**，而一个
   * 回合（user + assistant + toolResult）就是一个 unit —— 只有一个回合时 dropped 永远
   * 是空，候选窗口也永远是空。第二回合之后，第一个回合才真的落在窗口之外。
   *
   * 只需要第二个回合就能让第一个回合离开尾部窗口；候选窗口的硬证据与状态落盘
   * 检查都在第二次生成后完成。多跑额外回合只会增加本地 27B 模型在结构化 JSON
   * 请求上的排队时间，不能提高边界证据的质量。
   */
  for (const [index, cmd] of [[2, 'console.log(1+1)']]) {
    log('')
    log(`=== 第 ${index} 个回合（让前面的回合落到尾部窗口之外）===`)
    const t = await turn(`再跑一次：node -e "${cmd}" ，然后只回复结果。`, 180_000)
    ok(t.sent && t.started, `第 ${index} 个回合真的跑起来了`)
    log(`=== 等第 ${index} 次生成落盘（异步，本地模型最多 45s）===`)
    await sleep(50_000)
  }
  ok(!S().session?.isAgentRunning, '等待期间没有卡在「运行中」')

  out.push(`  ctxepisode.sessionId=${sessionId}`)
  out.push(`  ctxepisode.toolCalls=${outputs.length}`)
  return out.join('\n')
})()
