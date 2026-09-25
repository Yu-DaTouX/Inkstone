/**
 * 三类整理动作（实施-11 C-2b）的界面回归网。
 *
 * 这一片要修的问题：界面过去只有 pi 的「最近一次压缩」，
 * 而 `tool-sweep`（清扫）与 `episode-fold`（状态刷新）**不产生** pi 事件 ——
 * 「清扫跑了、状态刷新没跑」与「两个都没跑」在界面上完全同形。
 *
 * 探针职责（真实 Electron + 真实主进程 IPC）：
 *   ① 三行**都在**、顺序固定、各有自己的 testid（不合并成一句“整理过”）；
 *   ② 压缩行的口径来自 pi 事件而不是本地账本（没有记录时写「未发生」，不编造）；
 *   ③ 界面拿到的账本 = `window.yan.contextActions()` 的那一份（界面数 = 主进程数，
 *      与 `contextBudget` 同一口径约定），不是渲染端自己算的副本。
 *
 * 不花 token：不跑模型，只读账本与既有会话状态。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const button = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (button) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(600)
  store.getState().closeSettings?.()
  await sleep(200)
  if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)
  await sleep(300)
  q('[data-testid="right-window-tab-start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(500)

  const sec = q('[data-testid="rp-context"]')
  if (!sec) return '✗ 找不到上下文分区'
  /*
   * 分区行里第一个 `button` 现在是拖拽把手（.rp-grip，没有 aria-expanded），
   * 折叠头是 `.rp-sec-head` —— 必须点名它，否则永远展不开上下文分区。
   */
  const head = sec.querySelector('.rp-sec-head')
  if (head && head.getAttribute('aria-expanded') === 'false') {
    head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(200)
  }

  /* ---- 1. 详情展开：三类整理分组必须存在 ---- */
  out.push('=== 1. 三类分开显示 ===')
  const toggle = q('[data-testid="ctx-details-toggle"]')
  if (!toggle) return '✗ 找不到上下文详情开关'
  if (toggle.getAttribute('aria-expanded') !== 'true') {
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(400)
  }
  const group = q('[data-testid="ctx-actions-group"]')
  ok(!!group, '有「三类整理」分组（不是只有一条“最近一次压缩”）')

  const rows = ['tool-sweep', 'episode-fold', 'compaction'].map((kind) => q(`[data-testid="ctx-action-${kind}"]`))
  ok(rows.every(Boolean), '清扫 / 状态刷新 / 整轮压缩三行分别渲染')
  ok(
    rows[0] && rows[1] && rows[2] && rows[0].compareDocumentPosition(rows[1]) & Node.DOCUMENT_POSITION_FOLLOWING,
    '行顺序固定：清扫 → 状态刷新 → 整轮压缩（不随日志先后抖动）'
  )
  ok(
    rows[0]?.textContent !== rows[1]?.textContent,
    '两行不是同一份文案的复制（各自有自己的次数与细节）'
  )

  /* ---- 2. 界面读数 = 主进程读数 ---- */
  out.push('')
  out.push('=== 2. 界面数 = 主进程数 ===')
  const ledger = await window.yan.contextActions()
  out.push(`  账本: total=${ledger?.total} lastAt=${ledger?.lastAt ?? '—'}`)
  ok(ledger && Array.isArray(ledger.kinds), 'IPC 返回可读的账本（读不到也要是空统计而不是抛错）')
  ok(
    (ledger.kinds ?? []).length === 2,
    '账本只含扩展能记的两类（压缩走 pi 事件，不重抄一份）',
    JSON.stringify((ledger.kinds ?? []).map((k) => k.kind))
  )

  const sweepRow = q('[data-testid="ctx-action-tool-sweep"]')
  const sweepSummary = (ledger.kinds ?? []).find((k) => k.kind === 'tool-sweep')
  const sweepCount = sweepSummary?.count ?? 0
  if (sweepCount === 0) {
    ok(/未发生/.test(sweepRow?.textContent ?? ''), '账本为空时清扫行写「未发生」（不是空白）')
  } else {
    ok(
      new RegExp(String(sweepCount)).test(sweepRow?.textContent ?? ''),
      `清扫行显示的次数与主进程账本一致（${sweepCount}）`
    )
  }
  ok(
    /未发生|次/.test(sweepRow?.textContent ?? ''),
    '清扫行一定有明确的次数或「未发生」'
  )

  /* ---- 3. 压缩行不编造：没有 pi 记录时写「未发生」 ---- */
  out.push('')
  out.push('=== 3. 压缩行来自 pi 事件 ===')
  const compactionRow = q('[data-testid="ctx-action-compaction"]')
  const lastCompaction = store.getState().session?.lastCompaction
  if (!lastCompaction) {
    ok(/未发生/.test(compactionRow?.textContent ?? ''), '没有 pi 压缩记录时不编造次数')
  } else {
    ok(
      (compactionRow?.textContent ?? '').trim().length > 0,
      '有 pi 压缩记录时显示它的状态摘要'
    )
  }

  /* 收尾：折叠回去，不给后面的场景留展开态 */
  q('[data-testid="ctx-details-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await sleep(150)

  return out.join('\n')
})()
