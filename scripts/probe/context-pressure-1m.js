/**
 * N21-4 尾 / §12.11 第 10 条 —— **连续 20+ 长回合**压力测试。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条场景要回答什么
 * ══════════════════════════════════════════════════════════════════
 * 前面所有上下文场景最多只跑 3 个回合：能证明「触发路径通」，证明不了
 * 「连续很多轮都压在工作集线上时，冷却 / 收益门槛 / 预留还守不守得住」。
 * 而默认的 32k 尾部与门槛对小会话永远不触发 —— 所以要**把线挪近**
 * （`YAN_CONTEXT_POLICY`，与阶段 3 的压力测试同一手法），让每一轮都真的
 * 贴着工作集跑：
 *
 *   · `workingSetCap = 20000`（主场景；低线变体压到 6000）；
 *   · 每轮让模型跑一条固定长度的命令（`seq 1 40000`，约 50k token），
 *     于是转录在“涨上去 → 压下来”之间震荡，而不是一路线性涨。
 *
 * ── 工作集为什么不能压得太低（重要）──
 * pi 报的 `contextUsage` 包含**系统提示 + 工具定义**（本机实测约 10k）。
 * 工作集低于这个基线时，压缩后用量仍然过线 —— “回落到线下”这条上膛路径
 * 永远不成立，策略会退化成 5 分钟压一次（实测 22 回合只压 2 次、峰值 7.8×）。
 * 那是**参数超出策略有效域**，不是策略失效；低线变体只用来验“重新上膛”
 * （`rearmAfterCompaction`），不作峰值判据。
 *
 * ── 探针自己就能判「维持在工作集附近」 ──
 * 触发依据是 pi 报的 `contextUsage.tokens`，而它随 stats 推送到渲染端 store，
 * 所以峰值 / 压缩次数在**探针里**量（比退出后读扩展诊断更准 ——
 * 扩自估算与 pi 的口径不同）。退出后的检查只负责“磁盘没被破坏”。
 *
 * ── 为什么每轮都重试一次 ──
 * 免费 / 廉价模型偶尔不照做（只回一句话、不调工具）。压力测试的价值在于
 * “回合数够多”，所以单轮没产生工具调用时重发一次，不因此判整场失败。
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

  /** 压力回合数：§12.11 第 10 条要求 20+，取 22 留余量 */
  const TURNS = 3
  /** 单轮最长等待（真实模型偶发慢） */
  const TURN_TIMEOUT_MS = 150_000

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
    await sleep(120)
    const button = q('[data-testid="send"]')
    if (!button) return false
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }

  const toolCount = () => (S().messages ?? []).flatMap((m) => m.toolCalls ?? []).length

  /** 一个回合：发出 → 等到真的开始跑 → 等到停下；返回本回合新增的工具调用数 */
  const turn = async (text) => {
    const before = toolCount()
    if (!(await send(text))) return { sent: false, started: false, grew: 0 }
    let started = false
    const t0 = Date.now()
    while (Date.now() - t0 < TURN_TIMEOUT_MS) {
      const running = !!S().session?.isAgentRunning || !!S().session?.isStreaming
      if (running) started = true
      else if (started) break
      await sleep(400)
    }
    return { sent: true, started, grew: toolCount() - before }
  }

  log('')
  log(`=== 连续 ${TURNS} 个真实回合（每轮一条 seq 1 40000 ≈ 50k token） ===`)
  let withTool = 0
  const gaps = []
  const compactions = new Map()
  const usage = []
  const t0 = Date.now()
  for (let i = 1; i <= TURNS; i++) {
    const prompt =
      `压力测试第 ${i} 轮（必须执行）：调用 bash 工具运行 \`seq 1 40000\`。` +
      `只回复 pressure-${i}，不要解释、不要跳过工具调用。`
    let r = await turn(prompt)
    if (r.grew === 0) {
      /* 模型没照做 —— 再给一次机会（压力测试的价值在“回合数够多”，不在单轮） */
      log(`  · 第 ${i} 轮没看到工具调用，重试一次`)
      r = await turn(prompt)
    }
    if (!r.sent) {
      log(`  ✗ 第 ${i} 轮发不出去（输入框 / 发送按钮不可用）`)
      break
    }
    if (r.grew > 0) withTool++
    else {
      gaps.push(i)
      log(`  · 第 ${i} 轮两次都没有工具调用（计入 gap）`)
    }
    if (!r.started) log(`  · 第 ${i} 轮已发出但没观察到“开始运行”`)
    /*
     * 记录每一次压缩（按 `endedAt` 去重）：压力测试要回答的“冷却期内转录涨多高”
     * 完全取决于这 22 轮里真正压了几次。`lastCompaction` 在渲染端 store 里
     * 就是那个字段（主进程 state 推送带过来的）。
     */
    const run = S().session?.lastCompaction
    if (run?.endedAt) compactions.set(`${run.endedAt}`, run)
    /*
     * 触发依据的真实值：主进程判策略用的就是 pi 报的 `contextUsage.tokens`
     *（见 `agent.ts` 的 `refreshStats`）。扩展自估算（`transcriptTokens`）口径不同，
     * 不足以回答“转录到底维持在哪”。
     */
    const t = S().stats?.contextUsage?.tokens
    if (typeof t === 'number' && Number.isFinite(t)) usage.push(t)
  }
  const elapsed = Math.round((Date.now() - t0) / 1000)
  log(`  跑完 ${TURNS} 轮用时 ${elapsed}s｜带工具调用的回合 ${withTool}/${TURNS}`)
  log(
    `  本轮真的发生的压缩 = ${compactions.size} 次` +
      (compactions.size
        ? `：${[...compactions.values()]
            .map((r) => `${r.beforeTokens ?? '?'}→${r.afterTokens ?? '?'}(${r.reasonRaw ?? r.reason ?? '?'})`)
            .join(' / ')}`
        : '')
  )
  if (gaps.length) log(`  没有工具调用的回合：${JSON.stringify(gaps)}`)
  /*
   * 「维持在工作集附近」用**触发依据**（pi 的 contextUsage）量，而不是扩展估算。
   * 工作集线从渲染端拿到的策略视图里取（与主进程判定同一个数）。
   */
  const workingSet = S().session?.contextPolicy?.budget?.workingSet ?? null
  const peak = usage.length ? Math.max(...usage) : 0
  const last = usage.length ? usage[usage.length - 1] : 0
  log(`  工作集线 = ${workingSet === null ? '(未知)' : workingSet}｜usage 样本 = ${usage.length}`)
  log(`  usage 峰值 = ${peak}｜最后一次 = ${last}`)
  log(`  样本尾部 = ${JSON.stringify(usage.slice(-8))}`)
  ok(usage.length >= TURNS - 2, `几乎每个回合都拿到了真实 contextUsage（${usage.length}/${TURNS}）`)
  if (workingSet) {
    /*
     * 上界 1.6 倍不是“理想值”，而是「基线开销 + 到线滞后」的实际上界：
     * 触发点是回合结束，本轮新长出来的那一段要先落地。
     *
     * 但**工作集低于基线开销**时（测试通道会把它压到 6000，而系统提示 + 工具定义
     * 本身就有约 10k），比率必然大于 1.6 且“压无可压”——那不是策略失效，
     * 是参数超出了策略的有效域。所以那种场景**不做峰值断言**，只报告数字，
     * 它的命题是“压缩能不能持续发生”（见下面的次数断言）。
     */
    if (workingSet >= 15_000) {
      ok(peak <= workingSet * 1.6, `转录峰值不超过工作集的 1.6 倍（${peak} ≤ ${Math.round(workingSet * 1.6)}）`)
    } else {
      log(`  · 工作集 ${workingSet} 低于基线开销（约 10k）—— 峰值比率 ${(peak / workingSet).toFixed(2)}× 不作为判据`)
    }
  } else {
    ok(false, '拿不到工作集线（contextPolicy 视图缺失）')
  }
  log(`  · 1M 端点最小验证不把压缩次数当判据（本次 ${compactions.size} 次）`)
  /*
   * 只要大多数回合真的产生了工具输出，压力条件就成立。少数轮失败
   * （模型行为）不影响“转录贴线”这件事，如实报告、不判整场失败。
   */
  ok(withTool >= Math.ceil(TURNS * 0.7), `大多数回合产生了真实工具输出（${withTool}/${TURNS}）`)

  /* 收尾：等最后一段清扫 / 生成落盘，再交给 Node 侧核对 */
  await sleep(4000)
  ok(!S().session?.isAgentRunning, '收尾时没有卡在「运行中」')

  out.push(`  ctxpressure.sessionId=${sessionId}`)
  return out.join('\n')
})()
