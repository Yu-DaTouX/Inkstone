/**
 * C-3 真实大输入压力：把上下文**真的**推到工作集线上。
 *
 * 为什么不能沿用 `context-pressure.js`：那一条靠多轮小回合（每轮 ~1.8K token），
 * 在 700K 档跑满 22 轮也只到 46K —— 压缩一次都没发生。要让压缩真的介入，
 * 单轮就必须携带几十 K token。
 *
 * 做法：每轮发一段 200K 字符的用户消息（≈ 50K token）。用户消息既不会被
 * tool-sweep 拿走，也不依赖模型是否愿意调工具，增量完全确定。
 * 档位由 `YAN_CONTEXT_POLICY` 的 `workingSetCap` 决定，本探针跑到
 * 「0.95 × 工作集」或轮数上限为止 —— 因此同一个探针可以跑多档。
 */
;(async () => {
  const CHUNK = 200_000
  const MAX_TURNS = 20
  const TURN_TIMEOUT_MS = 240_000
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  if (!store) return '  ⤺ 跳过：没有 window.__yanStore'
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(200)
  }
  await sleep(400)
  S().closeSettings?.()
  for (let i = 0; i < 60; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  const budget = S().session?.contextPolicy?.budget ?? null
  const workingSet = budget?.workingSet ?? null
  const target = workingSet ? Math.round(workingSet * 0.95) : 300_000
  /*
   * padding 必须**高 token 密度**：重复字符（`'A'.repeat(200000)`）被 tokenizer
   * 高效压缩，实测 200K 字符只值 25K token。用确定性伪随机 base64（4 字符 ≈ 1 token）
   * 才能让每轮真的携带 ~50K token，也才能用可接受的轮数跑到 700K 档。
   */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const makePad = (seed) => {
    const buf = new Array(CHUNK)
    let x = (seed * 2654435761) >>> 0
    for (let k = 0; k < CHUNK; k += 1) {
      x = (x * 1103515245 + 12345) >>> 0
      buf[k] = B64[(x >>> 16) & 63]
    }
    return buf.join('')
  }
  log(
    `  窗口 ${budget?.contextWindow ?? '?'}｜工作集 ${workingSet ?? '?'}｜目标（0.95×）= ${target}` +
      `｜每轮 ${Math.round(CHUNK / 1000)}K 字符 ≈ ${Math.round(CHUNK / 4 / 1000)}K token`
  )

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

  const usage = []
  const compactions = []
  const t0 = Date.now()
  let last = 0
  let turns = 0
  let crossedAt = 0
  for (let i = 1; i <= MAX_TURNS; i++) {
    /*
     * 过线后再多跑 2 轮：
     * 策略判定发生在回合结束（`agent_settled`），而判定用的用量可能还是
     * **上一次推送**的值 —— 恰好踏在线上的那一轮常常压不了，下一轮才压。
     * 不给这两轮机会，就会把“滞后一轮”误判成“到线不压”。
     */
    if (crossedAt && i > crossedAt + 2) break
    const pad = `C3-soak-${i}-` + makePad(i)
    const sent = await send(`压力第 ${i} 轮：只回复「收到 ${i}」，不要调用任何工具。\n${pad}`)
    if (!sent) {
      log(`  · 第 ${i} 轮没发出去（找不到输入框或发送键）`)
      break
    }
    let started = false
    const t1 = Date.now()
    while (Date.now() - t1 < TURN_TIMEOUT_MS) {
      const running = !!S().session?.isAgentRunning || !!S().session?.isStreaming
      if (running) started = true
      else if (started) break
      await sleep(400)
    }
    turns = i
    const run = S().session?.lastCompaction
    if (run?.endedAt) {
      const key = String(run.endedAt)
      if (!compactions.some((c) => c.key === key)) {
        compactions.push({ key, before: run.beforeTokens, after: run.afterTokens, reason: run.reasonRaw ?? run.reason })
      }
    }
    last = Number(S().stats?.contextUsage?.tokens ?? last)
    usage.push(last)
    if (!crossedAt && last >= target) crossedAt = i
    /* 已经压过一次也算“真的到了线上”—— 不回回落就不算的压力测试是自相矛盾的。 */
    if (!crossedAt && compactions.length > 0) crossedAt = i
    log(
      `  第 ${i} 轮${started ? '' : '（没观察到「开始运行」）'}｜用量 = ${last}` +
        `｜压缩累计 = ${compactions.length}`
    )
  }
  const elapsed = Math.round((Date.now() - t0) / 1000)
  const peak = usage.length ? Math.max(...usage) : 0
  log(`  跑完 ${turns} 轮用时 ${elapsed}s｜峰值 = ${peak}｜末尾 = ${last}`)
  log(`  样本 = ${JSON.stringify(usage)}`)
  if (compactions.length) {
    log(
      '  压缩事件 = ' +
        compactions.map((c) => `${c.before ?? '?'}→${c.after ?? '?'}(${c.reason ?? '?'})`).join(' / ')
    )
  }

  /* ① 真的压到了线上（这一条以前从来没成立过）—— 用**峰值**，压缩后末尾当然回落 */
  ok(peak >= target * 0.9, `峰值用量达到目标附近（${peak} ≥ ${Math.round(target * 0.9)}）`)
  /* ② 到线就压：压缩必须真的发生 */
  ok(compactions.length >= 1, `到线后压缩真的发生了（${compactions.length} 次）`)
  /* ③ 压缩是有效的（后 < 前） */
  const effective = compactions.filter((c) => Number(c.after) > 0 && Number(c.after) < Number(c.before))
  ok(
    compactions.length === 0 || effective.length === compactions.length,
    `每次压缩都真的回落（${effective.length}/${compactions.length}）`
  )
  /* ④ 回落之后又长起来 —— 说明压力是持续的，不是一次性的 */
  {
    const min = Math.min(...usage)
    const idxMin = usage.indexOf(min)
    const afterMin = usage.length > idxMin + 1 ? Math.max(...usage.slice(idxMin + 1)) : min
    ok(usage.length < 3 || afterMin >= min * 3, `压缩回落（${min}）后又长起来了（${afterMin}）`)
  }
  return out.join('\n')
})()
