/**
 * Tool Sweep（N21-4 / S2）—— **真实**回合里的「旧工具输出 → 墓碑 + 归档」。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这条场景必须真跑一回合
 * ══════════════════════════════════════════════════════════════════
 * 单测能证明纯逻辑对，但证明不了「扩展在真实 pi 里被加载、`context` 钩子
 * 真的被调用、返回的消息真的被采用」。这三件事任一不成立，功能在真实链路里
 * 就是静默失效的 —— 界面上完全看不出来（墓碑只影响发给模型的消息，
 * 不动会话文件，所以 UI 的转录还是原文）。
 * 所以本场景的发起点是一次真实的工具调用，取证点在退出后的
 * 派生文件（归档元数据 + 扩展诊断日志），由 Node 侧断言。
 *
 * ── 怎么让 sweep 必然发生 ──
 * 默认 `recentTail.target = 32k`，测试会话太小、整个历史都在尾部里，
 * 永远不会 sweep。所以场景用 `YAN_CONTEXT_POLICY` 把尾部与门槛压到最小
 * （见 test-live 的 `env`），并确保**至少两个回合**：工具结果在第一回合，
 * 第二回合开始时它才落到 recentTail 之外。
 * `kinds` 不设 —— 2026-09-17 用户拍板“清理默认开”，这条场景因此同时
 * 验证默认接管集（含 `recall`）；把它改回 `['compaction']` 时这里会红。
 *
 * ── 探针能看到什么、不能看到什么 ──
 * 看不到墓碑（墓碑在模型上下文里，不在界面转录里），也读不到
 * `YAN_DATA_DIR`（测试边界：renderer 不接数据目录）。所以这里只负责
 * 「把真实回合跑出来」并留下可读结果；真正的断言在退出后的检查函数里。
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
  const toolOutputs = () =>
    (S().messages ?? []).flatMap((m) => m.toolCalls ?? []).map((t) => ({ name: t.name, len: (t.output ?? '').length }))

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

  /* ---------------- 1. 第一回合：制造一段大的工具输出 ---------------- */
  log('')
  log('=== 1. 真实回合制造大块工具输出 ===')
  const PROMPT_1 =
    '你必须先调用 bash 工具执行这条命令：seq 1 2000 。调用完成后，只回复最后一行数字。不要省略工具输出。'
  let t1 = await turn(PROMPT_1, 180_000)
  let outputs = toolOutputs()
  if (!outputs.some((t) => t.len > 2000)) {
    /* 免费模型偶尔不照做 —— 再给一次机会，不直接判失败 */
    log('  第一次没看到工具输出，重试一次')
    t1 = await turn(PROMPT_1, 180_000)
    outputs = toolOutputs()
  }
  log(`  回合已发出=${t1.sent}｜真的跑起来=${t1.started}｜消息数=${(S().messages ?? []).length}`)
  const lastAssistant = [...(S().messages ?? [])].reverse().find((m) => m.role === 'assistant')
  log('  最后一条助手文本: ' + JSON.stringify(String(lastAssistant?.text ?? '').slice(0, 120)))
  log('  工具输出长度: ' + JSON.stringify(outputs))
  const big = outputs.find((t) => t.len > 2000)
  ok(!!big, '模型真的调用了工具，且输出够大（>2000 字符）', big ? `${big.name} ${big.len}` : '')

  /* ---------------- 2. 第二回合：让模型去召回墓碑 ---------------- */
  log('')
  log('=== 2. 第二回合（让上一次的工具结果落到 recentTail 之外） ===')
  const t2 = await turn(
    '上一轮那个很长的工具结果已经被归档成一条以 "[Archived tool result]" 开头的占位，里面有一行 "Ref:"。' +
      '请先用 bash 工具执行 `yan context recall --ref <那一行的值>`，再读它 stdout 里 resultFile 指向的文件，只回复该文件第一行是什么。',
    180_000
  )
  ok(t2.sent, '第二回合已发出')
  /*
   * 模型会不会去用 `yan context recall` 是模型行为，不是代码行为 —— 只报告。
   * 召回链路的确定性证据在宿主单测（[test-context-recall.mjs](../test-context-recall.mjs)
   * 直接调 `recallArchivedContext`）与退出后的审计文件里。
   * 这里额外拿一条**反向信号**：薄层不再注册模型工具（01 S5 收口），
   * 所以模型侧不应该再出现 `context_recall` 这个工具名 —— 这条是断言，
   * 因为它证的是代码事实（工具表），不是模型偏好。
   */
  const recallToolCalls = (S().messages ?? [])
    .flatMap((m) => m.toolCalls ?? [])
    .filter((t) => t.name === 'context_recall')
  ok(recallToolCalls.length === 0, '模型侧不再有 context_recall 工具调用（回读已走宿主 CLI）', `${recallToolCalls.length} 次`)

  const cliRecallCalls = (S().messages ?? [])
    .flatMap((m) => m.toolCalls ?? [])
    .filter((t) => /"action":"recall"|"kind":"context"/.test(String(t.output ?? '')))
    .map((t) => ({ name: t.name, output: String(t.output ?? '').slice(0, 160) }))
  log('  yan context recall 调用（只报告）: ' + JSON.stringify(cliRecallCalls))

  /*
   * ---------------- 3. 第三回合：过期召回正文应被清成存根 ----------------
   *
   * TTL = 'turn'：召回内容只在**本回合**有效。第三个用户回合开始时，
   * 扩展应把上一回合的召回正文换成只留引用的存根（`expiredRecalls>=1`），
   * 退出后的检查用这一点验证；这里只负责把第三个回合跑出来。
   */
  log('')
  log('=== 3. 第三回合（召回正文的 TTL 清理触发点） ===')
  const t3 = await turn('只回复 ok，不要用任何工具。', 180_000)
  ok(t3.sent, '第三回合已发出')

  /*
   * ---------------- 4. C-2b：界面把「清扫」单独显示出来 ----------------
   *
   * 这一回合真的发生了 sweep（退出后的账本检查是权威证据，不靠界面自证）；
   * 这里断言**界面读到了同一份账本** —— 否则用户只能从“上下文突然短了”去猜。
   */
  log('')
  log('=== 4. 三类整理：清扫单独显示（C-2b）===')
  if (!S().settings?.rightPanelOpen) await S().setRightPanelOpen(true)
  await sleep(300)
  q('[data-testid="right-window-tab-start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(500)
  const ctxSec = q('[data-testid="rp-context"]')
  const ctxHead = ctxSec?.querySelector('button')
  if (ctxHead && ctxHead.getAttribute('aria-expanded') === 'false') {
    ctxHead.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(200)
  }
  const detailsToggle = q('[data-testid="ctx-details-toggle"]')
  if (detailsToggle && detailsToggle.getAttribute('aria-expanded') !== 'true') {
    detailsToggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(400)
  }
  /* 账本由主进程读；界面显示的是它的投影（界面数 = 主进程数） */
  const actionLedger = await window.yan.contextActions()
  const sweepSummary = (actionLedger?.kinds ?? []).find((k) => k.kind === 'tool-sweep')
  log(
    `  账本: tool-sweep=${sweepSummary?.count ?? 0} applied=${sweepSummary?.applied ?? 0} reclaimed=${sweepSummary?.reclaimed ?? 0}`
  )
  ok((sweepSummary?.count ?? 0) >= 1, '宿主读到了扩展写的清扫记录（C-2b 的真实链路）')
  ok((sweepSummary?.reclaimed ?? 0) >= 1, '账本里有真实的整理条数（不是零收益也算过）')
  const sweepRow = q('[data-testid="ctx-action-tool-sweep"]')
  ok(!!sweepRow, '上下文详情里清扫与状态刷新、压缩是分开的三行')
  ok(
    /[1-9]/.test(sweepRow?.textContent ?? ''),
    '清扫行显示的是真实次数，而不是「未发生」',
    JSON.stringify((sweepRow?.textContent ?? '').slice(0, 80))
  )
  q('[data-testid="ctx-details-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await sleep(150)

  out.push(`  ctxsweep.sessionId=${sessionId}`)
  return out.join('\n')
})()
