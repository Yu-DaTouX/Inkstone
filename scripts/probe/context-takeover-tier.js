/**
 * 「压缩接管」的**档位取证**（N21-6 尾，实施-06 S4 前半，cost 1）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么还要一条新场景
 * ══════════════════════════════════════════════════════════════════
 * `contexttakeoverstate` 已经拍到 `hook: 'takeover'`，但只在
 * **`stale-hard`** 档取证过（那条场景回合 2 的模型仍然调了工具，水位后
 * 新增 user + assistant + toolResult ≥ 3 条）。`fresh` 与 `stale-soft` 两档
 * 在真实链路里没有单独数据点。
 *
 * 本探针用**同一个时序**（回合 1 造 evidence 并等状态落盘 → 回合 2 越线），
 * 试过两种构想去命中另两档：
 *
 *   · 让 **pi 自己**在回合中途压（`reserveTokens = 窗口 − 25k`）；
 *   · 让回合 2 **明确禁止调用任何工具**（水位后只剩 user + assistant 两条）。
 *
 * 实测两次结果完全一样：`tier=stale-hard`、`gap=3`，会话条目序列也都是
 * `… user | assistant | compaction | …`。也就是说压缩（不管谁发起）**总在回合结束之后**，
 * 水位后至少已有 user + assistant + compaction 三条，gap 永远 ≥ 3。
 * 所以本探针的命题从“命中某档”改成“如实量出可达性”，结论由
 * 退出后检查（`checkContextTakeoverGap`）与文档共同持有。
 *
 * 期望档位**不写死** —— 本探针只负责把两个回合跑出来，档位由退出后的
 * `checkContextTakeoverGap` 从诊断里读并按“真实链路能命中哪一档”如实断言。
 *
 * ⚠️ 与 `contexttakeoverstate` 一样：`keepRecentTokens: 1` 不调小的话，
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
  out.push(`  ctxtiertakeover.sessionId=${S().session?.sessionId ?? ''}`)
  const budget = S().session?.contextPolicy?.budget ?? (await window.yan.contextBudget?.())?.budget
  const workingSet = budget?.workingSet ?? budget?.triggers?.compact ?? null
  log(`  工作集=${workingSet}｜压缩线=${budget?.triggers?.compact ?? '(未知)'}`)

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

  /* ---------------- 回合 1：造 evidence，等状态落盘 ---------------- */
  log('')
  log('=== 1. 小回合（造 evidence；`fresh` 场景下 pi 会在这轮就压一次）===')
  const t1 = await sendTurn('运行 `node -e "console.log(6*7)"`，然后只回复这个结果。', 90_000)
  ok(t1.sent, '回合 1 已发出')
  ok(t1.started, '回合 1 真的跑起来了')
  if (!t1.started) return out.join('\n')

  log('  等状态生成器落盘（异步，最多 20s）')
  await sleep(20_000)
  ok(!S().session?.isAgentRunning, '等待期间没有卡在「运行中」')

  /* ---------------- 回合 2：越线 → 压缩 → 接管（档位从这里出） ---------------- */
  log('')
  log('=== 2. 越线回合（压缩 + 接管的现场）===')
  const filler = '这一段只是把上下文推过工作集线的填充内容。'.repeat(3500)
  const t2 = await sendTurn(`${filler}\n绝对不要调用任何工具，也不要解释，只回复「好」。`, 120_000)
  ok(t2.sent, '越线回合已发出')
  ok(t2.started, '越线回合真的跑起来了（否则“没触发压缩”证明不了任何事）')
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
    log(
      `  触发者=${last.triggeredBy}｜阶段=${last.policyStage ?? '(pi 自己)'}｜before=${last.beforeTokens} after=${last.afterTokens}`
    )
    ok(last.status === 'completed', `压缩成功（实际 ${last.status}）`)
  }
  await sleep(2000)

  return out.join('\n')
})()
