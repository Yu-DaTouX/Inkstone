/**
 * 模型出错后的自动继续（实施-05 S5c，**不花额度**）。
 *
 * ══════════════════════════════════════════════════════════
 * 为什么这个场景能既真实又免费
 * ══════════════════════════════════════════════════════════
 * 模型名故意写坏（`deepseek/deepseek-s5c-nonexistent`）：
 *   · pi 不会拒绝启动（只 warn「Using custom model id」）；
 *   · 上游会回 400 `invalid_request_error`（**请求被拒，不产生用量**）；
 *   · 这个错误不含额度 / 认证 / 上下文关键词 → 砚判为「可重试」。
 * 于是整条链（错误事件 → 分类 → 退避 → 续行快照 → 薄层 custom 消息 → 新回合）
 * 都能真的跑起来，而每次请求都是被拒的 —— 不烧额度，也不碰用户的真实数据。
 *
 * 验的核心是这一句：**用户只发了一条消息**，之后每一轮都是砚自己起的。
 *
 * 磁盘结论交给 `afterExit`（`autoContinuePersisted`）：`auto-continue.json` 的计数
 * 与会话 JSONL 里的 `yan-auto-continue` 条目。
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
  /** 硬截止：约 150s（两轮退避是 1.2s，正常十几秒就该出结果） */
  const deadline = Date.now() + 150000
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

  /** 失败时的现场（只打印，不判红）：要分清「错误没到」「到了但没继续」「继续了但界面没显示」。 */
  const dumpDiagnostics = (label) => {
    const st = store.getState()
    const assistants = st.messages.filter((m) => m.role === 'assistant')
    out.push(`  —— 诊断（${label}）——`)
    out.push(`  消息 ${st.messages.length} 条；助手 ${assistants.length}；其中标错 ${assistants.filter((m) => m.error).length}`)
    out.push(`  session：isStreaming=${st.session?.isStreaming} isAgentRunning=${st.session?.isAgentRunning} conn=${st.conn}`)
    for (const m of assistants.slice(-4)) {
      out.push(`  助手[${m.error ? '错误' : '正常'}] ${JSON.stringify(String(m.content ?? '').slice(0, 120))}`)
    }
  }

  const errored = () => store.getState().messages.filter((m) => m.role === 'assistant' && m.error)
  const users = () => store.getState().messages.filter((m) => m.role === 'user')

  const ready = await waitFor(() => store.getState().conn === 'ready', 250)
  ok(!!ready, 'pi 已连接')
  await sleep(800)

  out.push('')
  out.push('=== 1. 先关掉 pi 自带的重试（这一片验的是砚的自动继续，不是 pi 的）===')
  const retryOff = await window.yan.setAutoRetry?.(false)
  ok(!!retryOff?.ok, `pi 自带重试已关（${JSON.stringify(retryOff)}）`)

  out.push('')
  out.push('=== 2. 只发这一条消息（模型名是坏的，请求必然被拒）===')
  const before = errored().length
  const sent = await store.getState().send('这是一次功能自测：请只回复「收到」，不要调用任何工具。')
  ok(!sent || sent.ok !== false, '消息已发送（此后不再发第二条）')

  const first = await waitFor(() => (errored().length > before ? errored().length : null), 400)
  ok(!!first, `第一轮拿到模型错误（标错助手 ${first ?? 0} 条）`)
  if (!first) dumpDiagnostics('等第一个错误')

  out.push('')
  out.push('=== 3. 没有人再发消息，砚自己又起了轮次（S5c 的核心证据）===')
  const second = await waitFor(() => (errored().length >= first + 1 ? errored().length : null), 500)
  ok(!!second, `自动继续真的起了新一轮（标错助手 ${first} → ${second ?? first}）`)
  if (!second) dumpDiagnostics('等自动继续')

  out.push('')
  out.push('=== 4. 到上限就停手（`limit` 由 YAN_AUTO_CONTINUE 压到 2）===')
  /* 等到不再增长（说明自动继续已经收手），或超时 */
  let last = errored().length
  let stableSince = Date.now()
  await waitFor(() => {
    const now = errored().length
    if (now !== last) {
      last = now
      stableSince = Date.now()
      return null
    }
    return Date.now() - stableSince > 6000 ? true : null
  }, 500)
  const total = errored().length
  out.push(`  最终标错助手 = ${total} 条（初次 1 + 自动继续 ${total - 1} 次；limit=2）`)
  ok(total >= 2 && total <= 3, `自动继续次数落在上限内（${total - 1} 次 ≤ 2）`)
  if (total > 3) dumpDiagnostics('自动继续次数超限')

  out.push('')
  out.push('=== 5. 全程只有一条用户消息（不是用户在催）===')
  const userCount = users().length
  ok(userCount === 1, `用户消息 ${userCount} 条`)
  const userTexts = users().map((m) => String(m.content ?? '').slice(0, 30))
  out.push('  用户消息：' + JSON.stringify(userTexts))

  const final = store.getState().session
  ok(final?.isStreaming !== true, '收尾后界面不再处于流式中（自动继续没有卡住）')

  return out.join('\n')
})()
