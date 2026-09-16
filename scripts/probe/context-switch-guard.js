/**
 * 工作集策略的**触发时机**（N21-3）：只看一眼旧会话不该被动刀（cost 0）。
 *
 * ── 这条探针来自一个真实回归 ──
 * 最初把判定挂在「每次刷新用量」上。切到一个很大的旧会话也会刷新用量 ——
 * 实测那个会话已经 276k tokens（超过 262k 的窗口），于是切过去的瞬间就发起
 * 压缩、运行实例变「忙」，紧接着「新对话」被拒：
 * `同一工作目录已有运行中的会话`。用户只是想看一眼那个会话，不该被压一次。
 * 现在的规则：只有**回合结束**（`agent_settled`）那条路允许按工作集动手。
 *
 * ── 怎么让这条判定不空洞 ──
 * 用 `YAN_CONTEXT_POLICY` 把工作集压到很小（见 test-live 的 env），
 * 这样切过去之后**用量必然在线上**（否则“没触发压缩”什么也证明不了），
 * 然后断言：压缩没有开始、上次压缩记录没变、并且「新对话」仍然能正常完成。
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

  /* 挑一条不是当前选中、且名字不是路径的会话 */
  const pathOf = (el) => el?.closest('.srow-wrap')?.getAttribute('data-session-path') ?? ''
  const cur = S().session?.sessionFile ?? ''
  const candidates = rows.map(pathOf).filter((x) => x && x !== cur).slice(0, 8)
  const before = S().session?.lastCompaction ?? null

  log('')
  log('=== 1. 切到一个“超线”的旧会话 ===')
  /*
   * 这条探针的前提是"切过去的那个会话用量在两条线之上"。会话是按左栏顺序挑的，
   * 而 fixture 里既有几十万 token 的真实会话，也有几乎空的合成会话 ——
   * 挑到小的那 条时前提不成立，探针会假失败（2026-09-17 全量门槛实测到一次：
   * 切到一条只有 4 token 的会话）。所以**按顺序找第一条真的超线的**，
   * 找不到才算这条探针不成立（并且要说清是哪种情况）。
   */
  let targetPath = ''
  let tokens = null
  for (const cand of candidates) {
    const row = rows.find((r) => pathOf(r) === cand)
    if (!row) continue
    click(row)
    /* 等它真的铺上消息（peekSession 读文件，不等 pi） */
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
