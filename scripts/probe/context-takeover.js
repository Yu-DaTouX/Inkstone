/**
 * 上下文接管（N21-3）—— **真实**按工作集触发一次压缩（cost 1）。
 *
 * 这是阶段 3 的核心声明：「砚决定什么时候压」。所以这里要的是真事：
 * 用一次普通回合把上下文推过**砚算出来的工作集**，然后看 pi 是否真的压了、
 * 砚有没有把那一次记成自己发起的（pi 一律报 `reason: 'manual'`）。
 *
 * ── 为什么能用一次普通回合触发 ──
 * 默认工作集是 240k，填到那里要几十万 token 的额度。所以本场景用
 * `YAN_CONTEXT_POLICY` 把 `workingSetCap` 压到一两千（见 test-live 的
 * `env`），这样一次往返就越线 —— 触发路径、RPC 调用、事件归一化、
 * 界面文案全都是真的，只有那条线被挪近了（与 N21-2 把 `reserveTokens`
 * 调到比窗口还大是同一个手法）。
 *
 * 同一个探针跑两次，env 不同：
 *   · `workingSetCap=1500`                 → 命中工作集线（policyStage=compact）
 *   · `workingSetCap=很大, emergencyRatio=0.001` → 命中 90% 物理兜底（policyStage=emergency）
 * 期望命中哪条线**由探针自己按预算算**（谁的触发点低谁先响），不是写死的名字。
 *
 * 判据：pi 自己的那条线必须远在工作集之上，否则“是砚触发的”就不成立。
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
  const text = (s) => q(s)?.textContent?.trim() ?? ''
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

  const win = S().session?.model?.contextWindow
  const budget = S().session?.contextPolicy?.budget ?? (await window.yan.contextBudget(win))?.budget
  if (!budget) return '  ⤺ 跳过：没有工作集预算'
  log(`  模型窗口 ${win}｜工作集 ${budget.workingSet}｜压缩线 ${budget.triggers.compact}｜物理兜底 ${budget.emergency}`)

  /* 期望命中哪条线：触发点低的那条。两条线的判定与主进程同一套规则。 */
  const expectStage = budget.emergency < budget.triggers.compact ? 'emergency' : 'compact'
  const expectAt = Math.min(budget.emergency, budget.triggers.compact)
  ok(expectAt < 20000, `本次场景的触发点被压到了 ${expectAt}（否则要几十万 token 的额度）`)

  /* pi 自己那条线必须远在工作集之上，否则分不清是谁触发的 */
  const info = await window.yan.compactionInfo(win)
  ok(
    info.threshold > budget.triggers.compact,
    `pi 原生触发线 ${info.threshold} 远在工作集之上（工作集 ${budget.triggers.compact}）`
  )

  /* ---------------- 发一个回合 ---------------- */
  log('')
  log('=== 1. 真实回合越过工作集 ===')
  const ta = q('[data-testid="composer"]')
  if (!ta) return '✗ 找不到输入框'
  /* 发之前先把「已有的记录」记下来：要验的是**本次回合**触发的那一次 */
  const seenBefore = S().session?.lastCompaction?.endedAt ?? null
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
    ta,
    '只回复「好」，不要用任何工具。'
  )
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)
  q('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  let last = null
  for (let i = 0; i < 150; i++) {
    await sleep(1000)
    const cur = S().session?.lastCompaction
    if (cur && cur.status !== 'running' && cur.endedAt !== seenBefore) {
      last = cur
      break
    }
  }
  log('  主进程记录: ' + JSON.stringify(last ?? null))
  ok(!!last, '工作集过线后真的触发了一次压缩')
  if (!last) return out.join('\n')

  ok(last.status === 'completed', `压缩成功（实际 ${last.status}）`)
  ok(last.triggeredBy === 'policy', `记录里标着“砚发起的”（实际 ${last.triggeredBy}）`)
  ok(last.policyStage === expectStage, `命中的是 ${expectStage} 那条线（实际 ${last.policyStage}）`)
  ok(
    typeof last.beforeTokens !== 'number' || last.beforeTokens < info.threshold,
    `压缩发生在 pi 原生触发线之前（beforeTokens=${last.beforeTokens}）`
  )
  ok(S().session?.compaction === undefined, '结束后没有残留的“正在压缩”')

  /* ---------------- 界面：不能说成「手动」 ---------------- */
  log('')
  log('=== 2. 界面文案 ===')
  const toggle = q('[data-testid="ctx-details-toggle"]')
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(250)
  }
  const rowText = text('[data-testid="ctx-last-compaction"]')
  log('  「最近一次」: ' + JSON.stringify(rowText))
  ok(!!rowText, '详情里有「最近一次」')
  ok(!/手动/.test(rowText), '砚自己压的那次**不显示成「手动」**（用户没点按钮）')
  ok(/已完成/.test(rowText), '显示结局「已完成」')
  if (expectStage === 'emergency') {
    ok(/物理兜底/.test(rowText), '兜底触发时写明「物理兜底」')
  } else {
    ok(/工作集/.test(rowText), '工作集触发时写明「工作集」')
  }

  return out.join('\n')
})()
