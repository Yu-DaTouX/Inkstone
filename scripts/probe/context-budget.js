/**
 * 上下文工作集（N21-3）—— 预算数值 + 界面把工作集当主值。
 *
 * 三件事在这里钉住（cost 0：不发消息）：
 *   ① **预算公式的参考值**：64k → 40k、128k → 88k、256k → 179.2k、1M → 240k
 *      （方案 §5 的验算表；小窗口与大窗口都在内）。窗口小到装不下预留与余量时
 *      必须**没有预算**，而不是给出一条 ≤ 0 的压缩线（那会让每一轮都压）。
 *   ② **界面上的数就是砚用来做决定的数**：会话状态里推来的 `contextPolicy.budget`
 *      与 `window.yan.contextBudget(窗口)` 完全一致 —— 这一块出过 D21/D22
 *      （界面数字 ≠ 实际生效值），所以“同源”要单独断言。
 *   ③ **工作集视角**：主值/进度条刻度/「下一步」/图例/详情都在，
 *      未接管的阶段（清理、折叠）画成虚线且标 `data-active=0`，
 *      关掉「自动压缩」开关后整个视角退回物理窗口（不展示没生效的策略）。
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

  /* ---------------- 1. 预算公式（参考值） ---------------- */
  log('=== 1. 工作集预算（方案 §5 的验算表）===')
  const cases = [
    /* emergency = min(90% 窗口, 窗口 − 预留)：小窗口下由预留决定（§12 修改 1 / D31） */
    { win: 64000, reserve: 16000, margin: 8000, workingSet: 40000, emergency: 48000 },
    { win: 128000, reserve: 32000, margin: 8000, workingSet: 88000, emergency: 96000 },
    { win: 256000, reserve: 32000, margin: 8000, workingSet: 179200, emergency: 224000 },
    { win: 1000000, reserve: 32000, margin: 20000, workingSet: 240000, emergency: 900000 }
  ]
  for (const c of cases) {
    const r = await window.yan.contextBudget(c.win)
    const b = r?.budget
    log(`  窗口 ${c.win} → ${JSON.stringify(b)}`)
    ok(b?.workingSet === c.workingSet, `窗口 ${c.win}：工作集 ${c.workingSet}（实际 ${b?.workingSet}）`)
    ok(b?.responseReserve === c.reserve, `窗口 ${c.win}：输出预留 ${c.reserve}`)
    ok(b?.safetyMargin === c.margin, `窗口 ${c.win}：安全余量 ${c.margin}`)
    ok(
      b?.emergency === c.emergency,
      `窗口 ${c.win}：物理兜底 ${c.emergency}（实际 ${b?.emergency}，= min(90% 窗口, 窗口 − 预留)）`
    )
    ok(
      (b?.emergency ?? 0) <= c.win - c.reserve,
      `窗口 ${c.win}：兜底线不吃输出预留（≤ ${c.win - c.reserve}）`
    )
    ok((b?.emergency ?? 0) > (b?.triggers.compact ?? 0), `窗口 ${c.win}：兜底线仍高于压缩线`)
    ok(
      b?.triggers.compact === c.workingSet && b?.triggers.sweep === Math.round(c.workingSet * 0.7),
      `窗口 ${c.win}：三阶段刻度（70% / 85% / 100% 工作集）`
    )
  }
  const tiny = await window.yan.contextBudget(20000)
  ok(tiny?.budget === null, '窗口小到装不下预留与余量时没有预算（不当成“随时压缩”）')
  const policy = (await window.yan.contextBudget(128000))?.policy
  ok(
    Array.isArray(policy?.kinds) && policy.kinds.join(',') === 'tool-sweep,recall,compaction',
    `默认接管清理 + 召回 + 压缩（实际 ${JSON.stringify(policy?.kinds)}）`
  )
  ok(!(policy?.kinds ?? []).includes('episode-fold'), '折叠仍不在接管范围内（要状态生成器）')
  log(`  生效策略：${JSON.stringify(policy)}`)

  /* ---------------- 2. 界面与主进程同源 ---------------- */
  log('')
  log('=== 2. 界面上的数 = 砚用来判断的数 ===')
  for (let i = 0; i < 40; i++) {
    if (S().conn === 'ready' && S().session?.model?.contextWindow) break
    await sleep(500)
  }
  const win = S().session?.model?.contextWindow
  if (!win) return out.join('\n') + '\n  ⤺ 跳过：没有模型窗口（conn=' + S().conn + '）'
  const fromIpc = (await window.yan.contextBudget(win))?.budget
  const pushed = S().session?.contextPolicy
  log(`  当前模型窗口 ${win}；推送的视图 ${JSON.stringify(pushed)}`)
  ok(!!pushed, '会话状态里带了工作集视图')
  ok(pushed?.budget.workingSet === fromIpc?.workingSet, '推送的工作集 = IPC 算出来的（同一个策略对象）')
  ok(pushed?.budget.emergency === fromIpc?.emergency, '推送的物理兜底也一致')
  /*
   * 兜底线（§12.1 / D31）：真实模型窗口上再验一次"不吃输出预留"。
   * 窗口 ≤ 320k 时会被预留卡住（用户的 262144 就是这种），所以要打印两个数 ——
   * 只看 90% 会以为公式没生效。
   */
  const ratio90 = Math.round(win * 0.9)
  log(
    `  兜底线：${pushed?.budget.emergency}（90% 窗口是 ${ratio90}，预留边界 ${win - (pushed?.budget.responseReserve ?? 0)}）`
  )
  ok(
    (pushed?.budget.emergency ?? Infinity) <= win - (pushed?.budget.responseReserve ?? 0),
    '兜底线不吃输出预留（≤ 窗口 − 预留）'
  )
  ok(
    (pushed?.budget.emergency ?? 0) > (pushed?.budget.triggers.compact ?? 0),
    '兜底线仍高于压缩线（不是摆设）'
  )
  ok(pushed?.budget.workingSet <= 240000, '工作集不超过 240k 天花板')
  ok(pushed?.budget.workingSet < win, '工作集严格小于物理窗口（否则“比物理窗口早”是假的）')

  /* ---------------- 3. 工作集视角的界面 ---------------- */
  log('')
  log('=== 3. 工作集视角 ===')
  const main = q('[data-testid="ctx-main"]')
  ok(main?.getAttribute('data-mode') === 'working-set', `主值切到工作集视角（data-mode=${main?.getAttribute('data-mode')}）`)
  const tokensText = text('[data-testid="ctx-tokens"]')
  const fmtK = (n) => `${Math.round(n / 1000)}k`
  ok(tokensText.endsWith(`/ ${fmtK(pushed.budget.workingSet)}`), `主值分母是工作集（实际 ${JSON.stringify(tokensText)}）`)

  /* 三条阶段标记：只有压缩会真的触发 */
  const marks = qa('[data-testid="ctx-stage-mark"]')
  ok(marks.length === 3, `进度条上有三条阶段刻度（实际 ${marks.length}）`)
  const kindOf = (el) => el.getAttribute('data-kind')
  const activeOf = (el) => el.getAttribute('data-active')
  for (const kind of ['tool-sweep', 'episode-fold', 'compaction']) {
    const el = marks.find((m) => kindOf(m) === kind)
    ok(!!el, `有 ${kind} 刻度`)
    if (!el) continue
    const shouldBeActive = pushed.kinds.includes(kind)
    ok(activeOf(el) === (shouldBeActive ? '1' : '0'), `${kind} 的接管状态与实际一致（active=${activeOf(el)}）`)
  }
  ok(activeOf(marks.find((m) => kindOf(m) === 'compaction')) === '1', '压缩标记是“真的会触发”的那条')
  ok(activeOf(marks.find((m) => kindOf(m) === 'tool-sweep')) === '1', '清理标记已接管（默认开）')
  ok(activeOf(marks.find((m) => kindOf(m) === 'episode-fold')) === '0', '折叠标记未接管（要状态生成器）')
  ok(!!marks.find((m) => kindOf(m) === 'episode-fold')?.className.includes('planned'), '未接管的刻度用虚线样式')

  /* 刻度位置真的按比例（不是随便摆三条线） */
  const meter = q('.rp-meter')
  const mr = meter?.getBoundingClientRect()
  const ratios = { 'tool-sweep': 0.7, 'episode-fold': 0.85, compaction: 1 }
  for (const [kind, ratio] of Object.entries(ratios)) {
    const el = marks.find((m) => kindOf(m) === kind)
    if (!el || !mr) continue
    const r = el.getBoundingClientRect()
    const expect = mr.left + mr.width * ratio
    ok(Math.abs(r.left - expect) <= 3, `${kind} 刻度画在 ${Math.round(ratio * 100)}% 处（偏差 ${Math.round(r.left - expect)}px）`)
  }

  /* 「下一步」只预报真的会执行的阶段，而且取**最先到的那条** */
  const next = q('[data-testid="ctx-next-stage"]')
  ok(!!next, '有「下一步」说明行')
  /*
   * 清理默认接管（用户 2026-09-17 拍板）后，最先到线的是清理而不是压缩 ——
   * 阶段刻度 70% / 85% / 100%，只接管压缩时才会预报压缩。
   */
  ok(next?.getAttribute('data-kind') === 'tool-sweep', `下一步预报的是清理（实际 ${next?.getAttribute('data-kind')}）`)
  log(`  下一步文案：${JSON.stringify(text('[data-testid="ctx-next-stage"]'))}`)
  ok(/下一步/.test(text('[data-testid="ctx-next-stage"]')), '文案以「下一步」开头')

  /* 图例：三格，默认接管格里“清理 + 压缩”两格，折叠仍待状态生成器 */
  const chips = qa('[data-testid="ctx-stage-chip"]')
  ok(chips.length === 3, `阶段图例三格（实际 ${chips.length}）`)
  const activeChips = chips.filter((c) => c.getAttribute('data-active') === '1')
  ok(activeChips.length === 2, `图例里两格已接管（清理 + 压缩，实际 ${activeChips.length}）`)
  ok(
    activeChips.every((c) => ['tool-sweep', 'compaction'].includes(c.getAttribute('data-kind'))),
    '已接管的两格确实是清理与压缩'
  )

  /* 详情：预算的每个数都能在界面里对上 */
  const toggle = q('[data-testid="ctx-details-toggle"]')
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(250)
  }
  const nf = new Intl.NumberFormat('en-US')
  ok(text('[data-testid="ctx-working-set"]').includes(nf.format(pushed.budget.workingSet)), '详情里的工作集 = 推送值')
  ok(text('[data-testid="ctx-safety-margin"]').includes(nf.format(pushed.budget.safetyMargin)), '详情里的安全余量 = 推送值')
  ok(text('[data-testid="ctx-emergency"]').includes(nf.format(pushed.budget.emergency)), '详情里的物理兜底 = 推送值')
  ok(text('[data-testid="ctx-reserve-computed"]').includes(nf.format(pushed.budget.responseReserve)), '详情里的输出预留 = 推送值')
  const thresholdRow = qa('.rp-kv').find((r) => /pi 原生触发线/.test(r.textContent ?? ''))
  ok(!!thresholdRow, '工作集模式下 pi 自己那条线标明是“pi 原生触发线”（不是砚的工作集）')

  /* ---------------- 4. 关掉开关就退回物理窗口 ---------------- */
  log('')
  log('=== 4. 关掉「自动压缩」后不留工作集视角 ===')
  const sw = q('[data-testid="rp-auto-compact"]')
  ok(!!sw, '找到自动压缩开关')
  sw.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  for (let i = 0; i < 40; i++) {
    if (S().session?.autoCompactionEnabled === false) break
    await sleep(250)
  }
  ok(S().session?.autoCompactionEnabled === false, '开关已关（pi 侧确认）')
  ok(!S().session?.contextPolicy, '关掉后不再推送工作集视图（不展示没生效的策略）')
  ok(!q('[data-testid="ctx-stage-mark"]'), '关掉后进度条上没有阶段刻度')
  ok(!q('[data-testid="ctx-next-stage"]'), '关掉后没有「下一步」行')
  ok(q('[data-testid="ctx-main"]')?.getAttribute('data-mode') === 'window', '主值退回物理窗口')
  const backText = text('[data-testid="ctx-tokens"]')
  ok(backText.endsWith(`/ ${fmtK(win)}`), `主值分母回到物理窗口（实际 ${JSON.stringify(backText)}）`)

  /* 再打开，工作集视角回来（探针不留副作用） */
  q('[data-testid="rp-auto-compact"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  for (let i = 0; i < 40; i++) {
    if (S().session?.autoCompactionEnabled !== false) break
    await sleep(250)
  }
  ok(!!S().session?.contextPolicy, '重新打开后工作集视角回来')
  ok(q('[data-testid="ctx-main"]')?.getAttribute('data-mode') === 'working-set', '主值又切回工作集')

  /* ---------------- 5. 几何：不横向溢出 ---------------- */
  log('')
  log('=== 5. 几何 ===')
  const sec = q('[data-testid="rp-context"]')
  if (sec) {
    const overflow = sec.scrollWidth - sec.clientWidth
    ok(overflow <= 1, `上下文分区不横向溢出（溢出 ${overflow}px）`)
    const stages = q('[data-testid="ctx-stages"]')
    if (stages) {
      const sr = stages.getBoundingClientRect()
      const pr = sec.getBoundingClientRect()
      ok(sr.right <= pr.right + 1, '阶段图例不超出分区右边界（窄栏会换行）')
    }
  }

  /* ---------------- 6. 操作行：一行高 + 与标题对齐（用户截图报的问题） ---------------- */
  log('')
  log('=== 6. 压缩按钮：一行高、与「自动压缩」对齐 ===')
  /*
   * 为什么连宽度都要测：右栏最窄可以到 PANEL_MIN(220px)，而
   * 「自动压缩」+ 开关 + 「压缩上下文」按钮加起来接近这个宽度 ——
   * 之前按钮文字被挤成两行（“压缩上 / 下文”），行高跟着变，看起来也没对齐。
   */
  const checkRow = async (width, label) => {
    await S().setPanelWidth({ panelWidth: width })
    await sleep(500)
    const row = q('[data-testid="rp-context-actions"]')
    const lab = row?.querySelector('.rp-k')
    const btn = q('[data-testid="rp-compact-now"]')
    const txt = btn?.querySelector('span')
    if (!row || !lab || !btn || !txt) return ok(false, `${label}：找不到操作行/按钮`)
    const rr = row.getBoundingClientRect()
    const lr = lab.getBoundingClientRect()
    const br = btn.getBoundingClientRect()
    const tr = txt.getBoundingClientRect()
    log(
      `  ${label}：行 ${Math.round(rr.width)}px｜按钮 ${Math.round(br.width)}×${Math.round(br.height)}｜文字 ${Math.round(tr.height)}px 高`
    )
    ok(br.height <= 26, `${label}：按钮一行高（${Math.round(br.height)}px）`)
    /*
     * 单行文字在 --fs-sm 下约 18px（实测），折成两行是 36px ——
     * 不能用“与标签比”，因为窄栏下标签自己也会被挤成两行（两边一起变高就测不出来了）。
     */
    ok(tr.height <= 22, `${label}：按钮文字没有被折行（${Math.round(tr.height)}px 高）`)
    ok(lr.height <= 22, `${label}：「自动压缩」没有被挤成两行（${Math.round(lr.height)}px 高）`)
    ok(Math.abs((lr.top + lr.bottom) / 2 - (br.top + br.bottom) / 2) <= 3, `${label}：按钮与「自动压缩」同一中线`)
    ok(br.right <= rr.right + 1, `${label}：按钮不越出这一行`)
    ok(txt.scrollWidth <= txt.clientWidth + 1, `${label}：按钮文字完整（没有被省略号截断）`)
    ok(rr.height <= 30, `${label}：整行只有一行高（${Math.round(rr.height)}px）`)
  }
  await checkRow(260, '默认宽度 260px')
  await checkRow(220, '最窄 220px')
  await S().setPanelWidth({ panelWidth: 260 })
  await sleep(300)

  /* ---------------- 7. 阈值设置：改了当场生效、界面数 = 主进程数（N21-7） ---------------- */
  log('')
  log('=== 7. 上下文设置（可配置化 + 生效来源）===')
  const savedPolicy = S().settings?.contextPolicy
  /* 与设置面板同一条 IPC（store.patchSettings → main） */
  await S().patchSettings({ contextPolicy: { workingSetCap: 500_000, windowRatio: 0.25 } })
  for (let i = 0; i < 40; i++) {
    if (S().session?.contextPolicy?.source === 'user') break
    await sleep(250)
  }
  const view2 = S().session?.contextPolicy
  ok(view2?.source === 'user', `来源变成“用户设置”（实际 ${view2?.source}）`)
  ok((view2?.overridden ?? []).includes('workingSetCap'), '覆盖字段被点名（可解释：哪些值不是默认）')

  const ipc2 = await window.yan.contextBudget(win)
  ok(ipc2?.policy.workingSetCap === 500_000, 'IPC 策略读到了同一份用户设置')
  ok(ipc2?.source === 'user' && ipc2?.overridden.includes('windowRatio'), 'IPC 也报告了来源与覆盖字段')
  ok(
    view2?.budget.workingSet === ipc2?.budget.workingSet,
    `改完设置后界面工作集仍 = 主进程算的（${view2?.budget.workingSet} vs ${ipc2?.budget.workingSet}）`
  )
  const tokens2 = text('[data-testid="ctx-tokens"]')
  ok(
    tokens2.endsWith(`/ ${fmtK(ipc2.budget.workingSet)}`),
    `用量条分母跟着设置改（实际 ${JSON.stringify(tokens2)}）`
  )

  /* 设置面板里的来源与回填（打开上下文 tab） */
  S().openSettings?.('context')
  await sleep(500)
  const src = q('[data-testid="ctx-source"]')
  ok(!!src, '设置面板有「生效来源」')
  ok(/用户设置/.test(src?.textContent ?? ''), `来源文案显示用户设置（实际 ${JSON.stringify(src?.textContent)}）`)
  const capInput = q('[data-testid="ctx-cap"]')
  ok(capInput?.value === '500000', `设置面板回填了当前覆盖（实际 ${JSON.stringify(capInput?.value)}）`)
  ok(!!q('[data-testid="ctx-preset"]'), '有预设分段控件')
  S().closeSettings?.()
  await sleep(200)

  /* 恢复默认：探针不留副作用（下一次跑要看到干净的默认值） */
  await S().patchSettings({ contextPolicy: savedPolicy })
  for (let i = 0; i < 40; i++) {
    if (S().session?.contextPolicy?.source === 'default') break
    await sleep(250)
  }
  ok(S().session?.contextPolicy?.source === 'default', '恢复默认后来源回到“默认值”')
  ok(
    (await window.yan.contextBudget(win))?.policy.workingSetCap === 240_000,
    '恢复默认后工作集上限回到 240k'
  )

  return out.join('\n')
})()
