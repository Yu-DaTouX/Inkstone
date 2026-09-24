/**
 * C-3 的受控最小验证：真实约 1M 窗口端点能不能吃下大输入。
 *
 * 这里只做一件事：用一条**大填充** prompt 走完整链路（渲染端 → 主进程 → pi → 真实端点），
 * 观察 pi 报回的真实 `contextUsage`、窗口 / 工作集数值，以及有没有被预算门或端点拒绝。
 *
 * 不是压力矩阵：不跑 20+ 轮，也不把压缩次数当判据。发满 1M 输入的对比矩阵
 * 需要单独预算；这一片只证明「1M 端点在本机真实可用、数值口径一致」。
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
    const card = q('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(200)
    } else await sleep(120)
  }
  for (let i = 0; i < 60; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`
  await sleep(800)

  const usage0 = S().stats?.contextUsage ?? null
  const policy = S().session?.contextPolicy ?? null
  const budget = policy?.budget ?? policy ?? null
  const model = S().session?.model ?? S().model ?? null
  const win0 = usage0?.window ?? usage0?.contextWindow ?? budget?.window ?? null
  const ws0 = budget?.workingSet ?? null
  log(`  初始 contextUsage = ${JSON.stringify(usage0)}`)
  log(`  模型 = ${JSON.stringify(model)}｜pi 报窗口 = ${win0}｜砚工作集 = ${ws0}`)

  /*
   * 大填充：约 240k 字符。中文重复文本在 pi 的估算里按 CJK 口径走，
   * 这里不预设准确 token 数，只看真实回报 —— 断言只要求「真的变大了」。
   */
  const filler = '这是一段用于验证大窗口端点的填充文本。'.repeat(12000)
  log(`  填充长度 = ${filler.length} 字符`)
  const prompt = '这是大窗口端点验证，请只回复 OK，不要调用任何工具。\n\n' + filler
  const sent = await S().send(prompt)
  log(`  send 返回 = ${JSON.stringify(sent)}`)
  const errs = (S().notices ?? []).map((n) => String(n.text ?? ''))
  log(`  notices = ${JSON.stringify(errs.slice(-3))}`)

  const t0 = Date.now()
  let started = false
  while (Date.now() - t0 < 180_000) {
    const st = S()
    const running = !!st.session?.isAgentRunning || !!st.session?.isStreaming
    if (running) started = true
    else if (started) break
    await sleep(500)
  }
  await sleep(1500)

  const usage1 = S().stats?.contextUsage ?? null
  const peak = Number(usage1?.tokens ?? 0)
  const errs1 = (S().notices ?? []).map((n) => String(n.text ?? ''))
  log(`  回合结束：started=${started}｜结束 contextUsage = ${JSON.stringify(usage1)}`)
  log(`  结束 notices = ${JSON.stringify(errs1.slice(-3))}`)
  const assistants = (S().messages ?? []).filter((m) => m.role === 'assistant')
  log(`  助手消息 = ${assistants.length}；尾部 = ${JSON.stringify(String(assistants.at(-1)?.content ?? '').slice(0, 120))}`)

  ok(Number.isFinite(peak) && peak > 0, `拿到了真实 contextUsage（${peak}）`)
  ok(peak > 20_000, `大填充真的进入了上下文（tokens=${peak} > 20000）`)
  ok(
    !errs1.some((t) => /No API key|not found|unauthor|invalid.?model/i.test(t)),
    '没有被凭证 / 模型解析失败拦住'
  )
  if (typeof win0 === 'number') {
    log(`  · pi 报的窗口 = ${win0}（≥ 900000 才算约 1M 端点）`)
    ok(win0 >= 900_000, `端点窗口约 1M（${win0}）`)
  } else {
    log('  · 这一轮没从 store 里拿到窗口数值（诊断里可能仍有）')
  }
  out.push(`  ctxwindow.sessionId=${S().session?.sessionId ?? ''}`)
  return out.join('\n')
})()
