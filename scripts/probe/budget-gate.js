/**
 * 请求前预算门在**真实模型**下的冒烟（实施-05 S4，cost 1）。
 *
 * 假 provider 那两组（`hook-probe budget` / `budget-soft`）证明的是「判得对、拦得住」；
 * 这一场要排除的是**反向风险**：真实链路里估算偏大、或者 `ctx.model.contextWindow`
 * 拿不到，导致本该正常的一轮被误判成 `physical` 而整轮空转。
 *
 * 做法：把工作集线用 `YAN_CONTEXT_POLICY` 压到 3000（真实对话第一轮就过线 → `soft`），
 * 然后只发一句话。期望：模型正常回答；磁盘上要有 `request-budget-*` 诊断，
 * 但**不能**有 `physical` / `budget-abort`。
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
  const deadline = Date.now() + 120000
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
  await sleep(600)

  out.push('')
  out.push('=== 真实一轮：预算钩子开着，工作集线压到 3000 ===')
  await store.getState().send('只用一句话回答：1+1 等于几。不要调用任何工具。')
  /*
   * 先等「回合真的结束」（不是只等助手消息出现）：
   * 模型返回空文本 / 上游报错 / 被钩子中止，都会留下一条空内容的 assistant ——
   * 只数「有没有 assistant」会把这三种情况都当成通过。
   */
  const settled = await waitFor(() => {
    const st = store.getState()
    const busy = st.session?.isStreaming === true || st.session?.isAgentRunning === true
    const hasAssistant = st.messages.some((m) => m.role === 'assistant')
    return hasAssistant && !busy ? st : null
  })
  ok(!!settled, '这一轮跑完了（助手消息有了且不再忙）')
  const st = settled ?? store.getState()
  const assistantText = st.messages
    .filter((m) => m.role === 'assistant')
    .map((m) => String(m.content ?? ''))
    .join('')
    .trim()
  /*
   * 空文本的三种可能：模型侧返回空 / 上游报错 / 被预算钩子中止。
   * 前两种与「拦截逻辑」无关，所以**不拿非空文本判红**（那是模型侧的波动）；
   * 「有没有误拦」由 afterExit 的 physical / budget-abort 断言回答。
   */
  out.push(`  模型回答长度 = ${assistantText.length}${assistantText ? '：' + JSON.stringify(assistantText.slice(0, 80)) : '（空）'}`)
  if (!assistantText) {
    out.push('  诊断：消息角色序列 = ' + JSON.stringify(st.messages.map((m) => m.role)))
    out.push('  session 字段 = ' + JSON.stringify(Object.keys(st.session ?? {})))
  }

  ok(st.conn === 'ready' && st.session?.isStreaming !== true, `会话仍可用（conn=${st.conn}）`)
  const sessionKey = st.session?.sessionFile ?? st.session?.file ?? st.session?.id ?? null
  out.push(`  session = ${JSON.stringify(sessionKey)}`)
  const tail = st.messages.filter((m) => m.role === 'assistant').slice(-1).map((m) => String(m.content ?? '').slice(0, 120))
  out.push('  模型回答：' + JSON.stringify(tail))
  const usage = st.session?.usage ?? st.usage ?? null
  out.push('  界面用量：' + JSON.stringify(usage))

  /* 磁盘结论（诊断行 / 有没有 abort / 估算 vs 真实 usage）交给 afterExit */
  return out.join('\n')
})()
