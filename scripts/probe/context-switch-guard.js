;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const S = () => store.getState()

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
  await sleep(400)
  S().closeSettings?.()
  for (let i = 0; i < 40; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  S().setRailPinned(true)
  await sleep(400)

  const budget = S().session?.contextPolicy?.budget ?? (await window.yan.contextBudget(S().session?.model?.contextWindow ?? 0))?.budget
  if (!budget) return '  ⤺ 跳过：没有工作集预算'
  log(`  工作集 ${budget.workingSet}｜兜底 ${budget.emergency}（本场景把两条线都压得很低）`)

  const rows = qa('.rail .srow')
  ok(rows.length >= 2, `左栏有可切换的会话（${rows.length} 行）`)
  if (rows.length < 2) return out.join('\n')

  const pathOf = (el) => el?.closest('.srow-wrap')?.getAttribute('data-session-path') ?? ''
  const cur = S().session?.sessionFile ?? ''
  const candidates = rows.map(pathOf).filter((x) => x && x !== cur).slice(0, 8)
  const before = S().session?.lastCompaction ?? null

  log('')
  log('=== 1. 切到一个“超线”的旧会话 ===')
  let targetPath = ''
  let tokens = null
  for (const cand of candidates) {
    const row = rows.find((r) => pathOf(r) === cand)
    if (!row) continue
    click(row)
    for (let i = 0; i < 30; i++) {
      await sleep(400)
      if (S().session?.sessionFile === cand || S().messages.length > 0) break
    }
    await sleep(1500)
    const nowTokens = S().stats?.contextUsage?.tokens
    log(`  试 ${cand.slice(-24)} → tokens=${nowTokens}`)
    if (typeof nowTokens === 'number' && nowTokens > budget.emergency) {
      targetPath = cand
      tokens = nowTokens
      break
    }
    if (!targetPath) {
      targetPath = cand
      tokens = nowTokens
    }
  }
  const st = S()
  log(`  选中会话=${(st.session?.sessionFile ?? '').slice(-24)}｜tokens=${tokens}｜isCompacting=${st.session?.isCompacting}`)
  ok(st.session?.sessionFile === targetPath, '确实切过去了')
  ok(
    typeof tokens === 'number' && tokens > budget.emergency,
    `用量在两条线之上（${tokens} > ${budget.emergency}）—— 否则这条探针证明不了什么`,
    `试过 ${candidates.length} 条`
  )
  ok(st.session?.compaction === undefined, '切换本身没有开始压缩（“看一眼”不动刀）')
  ok(st.session?.isCompacting !== true, '运行实例没有因为这次切换变成“忙”')
  ok((st.session?.lastCompaction ?? null) === before, '也没有产生一条新的压缩记录')

  log('')
  log('=== 2. 切换之后立刻新建会话 ===')
  const btn = q('[data-testid="rail-new"]')
  ok(!!btn, '有「新对话」按钮')
  click(btn)
  let cleared = false
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    if (qa('.msg').length === 0 && S().messages.length === 0) {
      cleared = true
      break
    }
  }
  ok(cleared, `新建会话没有被压缩挡住（现在 ${qa('.msg').length} 条）`)

  return out.join('\n')
})()
