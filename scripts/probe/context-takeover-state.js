/**
 * 「压缩接管」的**成功分支**取证（N21-6 最后一项，cost 1）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 之前验证到哪一步了
 * ══════════════════════════════════════════════════════════════════
 * `contexttakeover` 已经证明：钩子**被调到**、且降级路径正确 —— 但那条场景没开
 * `episode-fold`，所以 `state.inject` 为 false，走的是 `fallback: 'inject-off'`。
 * `contexttakeoversummary` 证明的是**装配**（真实状态文件 → 真实
 * `buildStructuredSummary` → 逐类字段非空），不是链路。
 *
 * 也就是说：`hook: 'takeover'`（真的把 pi 的摘要换成结构化摘要）**从来没出现过**。
 * 本场景就是为它写的。
 *
 * ══════════════════════════════════════════════════════════════════
 * 时序为什么必须是两段
 * ══════════════════════════════════════════════════════════════════
 * 接手条件是「状态文件存在」（`loadState` 为 ok）。而状态生成器挂在
 * `agent_settled` **之后**、是异步的 —— 所以：
 *   · 若工作集小到「回合 1 结束就压缩」，那时状态还不存在 → `no-state`；
 *   · 于是回合 1 必须**不过线**（只用来造 evidence 并等状态落盘），
 *     回合 2 才把用量推过线。
 * `workingSetCap: 20000` 就是照这个选的：回合 1 虽然只发十几字符，但**工具调用**
 * 会把用量推上去（实测 pi 报 5595），回合 2 是 46k 字符（实测报 31019）——
 * 两个回合之间要留出一段区间，否则「回合 1 造 evidence」这一步自己就先越线了。
 *
 * ⚠️ 与 `contexttakeover` 一样：`keepRecentTokens: 1` 不调小的话，
 * pi 会说 `Nothing to compact (session too small)`。
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

  /* 退出后的日志检查靠它做会话隔离（沙箱是多个场景共用的） */
  out.push(`  ctxtakeoverstate.sessionId=${S().session?.sessionId ?? ''}`)
  const budget = S().session?.contextPolicy?.budget ?? (await window.yan.contextBudget?.())?.budget
  const workingSet = budget?.workingSet ?? budget?.triggers?.compact ?? null
  log(`  工作集=${workingSet}｜压缩线=${budget?.triggers?.compact ?? '(未知)'}`)
  /*
   * 探针**自己**先断言一次「工作集确实被压到了 2000 附近」。
   * 不先验这件事的话，后面「没接管」的失败信息会长得像「接管坏了」，
   * 而实际可能只是「用量压根没过线」（§18.8 记过这个坑）。
   */
  ok(Number(workingSet) > 0 && Number(workingSet) <= 30_000, `工作集被压到了 ${workingSet}（策略生效）`)

  const sendTurn = async (text, ms) => {
    const box = q('[data-testid="composer"]')
    if (!box) return { sent: false, started: false }
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(200)
    const btn = q('[data-testid="send"]')
    if (!btn) return { sent: false, started: false }
    const before = S().session?.lastCompaction?.endedAt ?? null
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    let started = false
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (S().session?.isAgentRunning || S().session?.isStreaming) started = true
      else if (started) break
      await sleep(400)
    }
    return { sent: true, started, before }
  }

  /* ---------------- 回合 1：造 evidence，不过线 ---------------- */
  log('')
  log('=== 1. 小回合（造 evidence，工作集小到这一轮不该越线）===')
  const t1 = await sendTurn('运行 `node -e "console.log(6*7)"`，然后只回复这个结果。', 90_000)
  ok(t1.sent, '回合 1 已发出')
  ok(t1.started, '回合 1 真的跑起来了')
  if (!t1.started) return out.join('\n')
  const cu1 = S().stats?.contextUsage
  log(`  回合 1 后 pi 用量=${cu1 ? `${cu1.tokens}/${cu1.contextWindow}` : 'null'}`)
  ok(!S().session?.lastCompaction || S().session.lastCompaction.endedAt === t1.before, '回合 1 没有越线（否则状态还来不及生成就要接管了）')

  log('  等状态生成器落盘（异步，最多 20s）')
  await sleep(20_000)
  ok(!S().session?.isAgentRunning, '等待期间没有卡在「运行中」')

  /* ---------------- 回合 2：大回合越线 → 压缩 → 接管 ---------------- */
  log('')
  log('=== 2. 大回合越过工作集（压缩 + 接管的现场）===')
  const filler = '这一段只是把上下文推过工作集线的填充内容，不需要任何工具调用。'.repeat(1800)
  const t2 = await sendTurn(`${filler}\n只回复「好」。`, 120_000)
  ok(t2.sent, '大回合已发出')
  ok(t2.started, '大回合真的跑起来了（否则“没触发压缩”证明不了任何事）')
  if (!t2.started) return out.join('\n')

  let last = null
  for (let i = 0; i < 150; i++) {
    await sleep(1000)
    const cur = S().session?.lastCompaction
    if (cur && cur.status !== 'running' && cur.endedAt !== t2.before) {
      last = cur
      break
    }
  }
  log('  主进程记录: ' + JSON.stringify(last ?? null))
  ok(!!last, '越线后真的触发了一次压缩')
  if (last) {
    log(`  触发者=${last.triggeredBy}｜阶段=${last.policyStage ?? '(pi 自己)'}｜before=${last.beforeTokens} after=${last.afterTokens}`)
    ok(last.status === 'completed', `压缩成功（实际 ${last.status}）`)
  }
  await sleep(2000)

  return out.join('\n')
})()
