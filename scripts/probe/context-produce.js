/**
 * 状态生成器（N21-4 剩余项）—— **真实**回合里的「生成 → 落盘 → 下一轮注入」。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须真跑两回合
 * ══════════════════════════════════════════════════════════════════
 * 单测能证明纯逻辑对、能用 fake ctx 证明落盘路径对，但证明不了三件事：
 *   ① `ctx.modelRegistry.complete(model, context, options)` 在**真实 pi** 里
 *      的形状就是我们以为的那个（这是 §16.1 从 bundle 推断出来的，不是文档）；
 *   ② 扩展真的在 `agent_settled` 上被调用，且调用**没有阻塞**下一次输入；
 *   ③ 生成出来的状态在**下一个回合**真的被 `context` 钩子注入（诊断 `injectedTaskState`）。
 * 任一不成立，功能在真实链路里就是静默失效的 —— 界面上完全看不出来
 * （状态只影响发给模型的消息，不动会话文件）。
 *
 * 所以本场景：真实回合 1（让模型调一次 bash，给 evidence reducer 原料）→
 * 等生成（异步，最多 20s）→ 真实回合 2（注入点）→ 退出后由 Node 侧断言
 * 状态文件与诊断日志（探针按设计读不到 `YAN_DATA_DIR`）。
 *
 * ── 关于 `kinds` —— 本探针被两个场景复用，env 不同，命题也不同 ──
 * 生成器只在 `episode-fold` 被接管时工作（它不在 default 之外的任何地方默默生效）：
 *   · `contextproduce` 显式在 `kinds` 里带上它 —— 验「测试通道精确指定接管集」；
 *   · `contextfolddefault` 不写 `kinds` —— 验「**默认**接管集下也会生成」。
 * 「从设置面板关掉后不生成」走另一个探针（`context-fold-pref.js`），因为那要先把开关关掉。
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

  /** 一个回合：发出 → 等到真的开始跑 → 等到停下 */
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

  /* ---------------- 1. 第一回合：制造一次真实工具调用（evidence 原料） ---------------- */
  log('')
  log('=== 1. 真实回合：一次工具调用（给 evidence reducer 原料） ===')
  const PROMPT_1 =
    '你必须先调用 bash 工具执行这条命令：node -e "console.log(\'produce-probe\')" 。' +
    '执行完成后，只回复这一行输出。不要省略工具调用。'
  let t1 = await turn(PROMPT_1, 180_000)
  let outputs = toolOutputs()
  if (!outputs.length) {
    /* 免费模型偶尔不照做 —— 再给一次机会，不直接判失败 */
    log('  第一次没看到工具调用，重试一次')
    t1 = await turn(PROMPT_1, 180_000)
    outputs = toolOutputs()
  }
  log(`  回合已发出=${t1.sent}｜真的跑起来=${t1.started}｜消息数=${(S().messages ?? []).length}`)
  log('  工具调用: ' + JSON.stringify(outputs))
  ok(!!outputs.length, '模型真的调用了工具（生成器的确定性 evidence 才有原料）', outputs.length ? outputs[0].name : '')

  /*
   * ---------------- 2. 等生成器落盘 ----------------
   *
   * 生成挂在 `agent_settled` 上、异步跑（内部 20s 超时）。探针看不到
   * `YAN_DATA_DIR`，所以这里只能等一段**足够长**的时间；真正的断言
   * （状态文件 + `producer committed`）在退出后的检查里。
   * 这也顺带验证了「生成不阻塞下一次输入」—— 下面第二回合发得出去。
   */
  log('')
  log('=== 2. 等生成器落盘（异步，最多 20s）===')
  await sleep(28_000)
  ok(!S().session?.isAgentRunning, '等待期间没有卡在「运行中」（生成不阻塞输入）')

  /* ---------------- 3. 第二回合：注入点 ---------------- */
  log('')
  log('=== 3. 第二回合（`<TASK_STATE>` 的注入点）===')
  const t2 = await turn('只回复 ok，不要用任何工具。', 180_000)
  ok(t2.sent, '第二回合已发出')
  ok(t2.started, '第二回合真的跑起来了（说明上一轮生成已经结束）')

  out.push(`  ctxproduce.sessionId=${sessionId}`)
  out.push(`  ctxproduce.toolCalls=${outputs.length}`)
  return out.join('\n')
})()
