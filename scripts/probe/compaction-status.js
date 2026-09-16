/**
 * 压缩可观测性（N21-2）—— 真实触发 + 文案矩阵。
 *
 * 三件事要在这里钉住：
 *   ① **真实**触发一次自动压缩（阈值）后，「最近一次」显示原因与结局；
 *   ② **真实**的手动压缩失败**不许静默**（pi 的原文要能看见）；
 *   ③ 进行中与已结束**同时**存在时互不覆盖；reason 认不出时显示原文而不是「未知」。
 *
 * ① ② 会真调模型（cost 1）：本场景跑在 `piSettings` 把阈值压到 0 的隔离环境里
 * （见 test-live 的 `piSettings`），所以第一轮结束就会压缩 —— 否则要把上下文填到
 * 「窗口 − 16384」才触发，那是几十万 token 的额度。
 *
 * ③ 用注入状态验（分支多、且「正在压缩」只有几百毫秒的窗口，不可能稳定抓拍）。
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
  await sleep(500)
  store.getState().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 24; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}），本场景要真的压缩一次`

  const sec = q('[data-testid="rp-context"]')
  if (!sec) return '✗ 找不到上下文分区'
  const openDetails = async () => {
    const btn = q('[data-testid="ctx-details-toggle"]')
    if (btn && btn.getAttribute('aria-expanded') !== 'true') {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(200)
    }
  }
  await openDetails()

  /* ---------------- 1. 真实的阈值触发 ---------------- */
  log('=== 1. 真实自动压缩（阈值）===')
  const ta = q('[data-testid="composer"]')
  if (!ta) return '✗ 找不到输入框'
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '回复「好」，不要用工具。')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)
  q('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  let last = null
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    last = S().session?.lastCompaction
    if (last && last.status !== 'running') break
  }
  log('  主进程记录: ' + JSON.stringify(S().session?.lastCompaction ?? null))
  ok(!!last, '真实压缩后主进程给出了「最近一次」记录')
  if (!last) return out.join('\n')
  ok(last.status === 'completed', `真实自动压缩结局是 completed（实际 ${last.status}）`)
  ok(last.reason === 'threshold', `真实自动压缩原因是 threshold（实际 ${last.reason}）`)
  ok(typeof last.endedAt === 'number', '带 endedAt（能算出耗时）')
  ok(typeof last.beforeTokens === 'number' && typeof last.afterTokens === 'number', '带压缩前 / 后的估算 token')

  await openDetails()
  const row = q('[data-testid="ctx-last-compaction"]')
  ok(!!row, '详情里出现「最近一次」')
  const rowText = row?.textContent ?? ''
  log('  界面文案: ' + JSON.stringify(rowText))
  ok(/已达阈值/.test(rowText), '「最近一次」显示原因「已达阈值」')
  ok(/已完成/.test(rowText), '「最近一次」显示结局「已完成」')
  ok(!/err\b/.test(row?.querySelector('.rp-v')?.className ?? ''), '已完成不是错误色')
  const tok = text('[data-testid="ctx-last-compaction-tokens"]')
  log('  token 段: ' + JSON.stringify(tok))
  ok(/→/.test(tok), '给出压缩前后 token（形如 1.6k → 160）')
  ok(!q('[data-testid="ctx-last-compaction-error"]'), '成功时不显示错误行')
  ok(!q('[data-testid="ctx-last-compaction-note"]'), '成功时不显示“已跳过”的解释行')

  /*
   * 阈值被压到 0 时进度条上**不能**画触发线：
   * 画在 0% 或负数位置等于告诉用户「马上就要压缩了」——那是假的。
   */
  ok(!q('[data-testid="ctx-threshold-mark"]'), '阈值为 0 时不画触发线（不撒谎）')

  /* ---------------- 1b. 项目级设置被 pi 忽略时要说明（D21） ---------------- */
  log('')
  log('=== 1b. 项目 .pi/settings.json 未生效（D21）===')
  const info = await window.yan.compactionInfo(200000)
  log('  compactionInfo: ' + JSON.stringify(info))
  /*
   * fixture 的项目文件写的是 reserveTokens=4096 / enabled=false；
   * 全局（隔离 pi 目录）写的是 900000 / true。
   * pi 不会读未信任项目的 .pi/settings.json —— 所以生效值必须是全局那份。
   */
  ok(info.reserveTokens === 900000, '生效的 reserveTokens 来自全局设置（项目级那份被忽略）')
  ok(info.enabled === true, '生效的 enabled 也是全局的（项目里写的是 false）')
  ok(info.scope === 'global', `明确标出生效来源是全局（scope=${info.scope}）`)
  ok(info.projectIgnored === true, '标记出项目级设置未生效')
  await openDetails()
  ok(!!q('[data-testid="ctx-project-ignored"]'), '界面上说明了项目设置未生效（不拿它画触发线）')

  /* ---------------- 2. 真实的手动压缩失败：不许静默 ---------------- */
  log('')
  log('=== 2. 真实手动压缩失败要看得见 ===')
  const btn = q('[data-testid="rp-compact-now"]')
  ok(!!btn, '存在「压缩上下文」按钮')
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  let failed = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    failed = S().session?.lastCompaction
    if (failed && failed.status === 'failed') break
  }
  log('  主进程记录: ' + JSON.stringify(S().session?.lastCompaction ?? null))
  ok(failed?.status === 'failed', `手动重复压缩被记为 failed（实际 ${failed?.status}）`)
  ok(failed?.reason === 'manual', `原因是 manual（实际 ${failed?.reason}）`)
  ok(!!failed?.error, '带上了 pi 的原文（errorMessage）')
  await openDetails()
  const errRow = q('[data-testid="ctx-last-compaction-error"]')
  ok(!!errRow, '失败在详情里有专门一行（不静默）')
  const errText = errRow?.textContent ?? ''
  log('  错误文案: ' + JSON.stringify(errText))
  ok(/Compaction failed|Already compacted|Nothing to compact/.test(errText), '错误行是 pi 的原文，没有被吞掉')

  /* ---------------- 3. 关掉自动压缩 → 真实的手动压缩成功 ---------------- */
  log('')
  log('=== 3. 关掉自动压缩后手动压缩（真实成功）===')
  const sw = q('[data-testid="rp-auto-compact"]')
  ok(!!sw, '存在自动压缩开关')
  if (sw?.getAttribute('aria-checked') !== 'false') {
    sw.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(800)
  }
  ok(S().session?.autoCompactionEnabled === false, '开关真的关上了（pi 侧状态已回落）')

  const endedBefore = S().session?.lastCompaction?.endedAt
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '再回复「好」，不要用工具。')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)
  q('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  /* 等这一轮真的跑完：isAgentRunning 从 true 回到 false */
  let sawRunning = false
  for (let i = 0; i < 90; i++) {
    await sleep(500)
    const s = S().session
    if (s?.isAgentRunning) sawRunning = true
    if (sawRunning && !s?.isAgentRunning && !s?.isStreaming) break
  }
  await sleep(2500)
  /*
   * 关掉自动压缩后**不应该**再出现自动压缩：
   * 否则“开关”只是个装饰（上一轮就是靠它才在第一轮结束就压了一次，对比明显）。
   */
  ok(
    S().session?.lastCompaction?.endedAt === endedBefore,
    '关掉开关后不再自动压缩（最近一次的结束时间未变）'
  )

  const btn2 = q('[data-testid="rp-compact-now"]')
  /*
   * 拿上一次记录的 startedAt 当基准：
   * 只看 `reason==='manual' && status!=='running'` 会**立刻**命中上一轮那次失败，
   * 于是根本没等新一次压缩（踩过：三条断言全 ✗，看上去像功能坏了）。
   */
  const prevStartedAt = S().session?.lastCompaction?.startedAt
  btn2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  let manualOk = null
  for (let i = 0; i < 90; i++) {
    await sleep(500)
    const cur = S().session?.lastCompaction
    if (cur && cur.startedAt !== prevStartedAt && cur.status !== 'running') {
      manualOk = cur
      break
    }
  }
  log('  主进程记录: ' + JSON.stringify(manualOk))
  ok(manualOk?.status === 'completed', `真实手动压缩成功（实际 ${manualOk?.status}）`)
  ok(manualOk?.reason === 'manual', '原因是 manual')
  await openDetails()
  const okRow = text('[data-testid="ctx-last-compaction"]')
  log('  界面文案: ' + JSON.stringify(okRow))
  ok(/手动/.test(okRow) && /已完成/.test(okRow), '界面显示「手动 · 已完成」')
  ok(!q('[data-testid="ctx-last-compaction-error"]'), '成功后错误行消失')
  ok(/→/.test(text('[data-testid="ctx-last-compaction-tokens"]')), '成功后有压缩前后 token')

  /* 把开关恢复回开（不把它当成“测试遗留”）：注入断言不依赖它，但界面应当回得去 */
  if (q('[data-testid="rp-auto-compact"]')?.getAttribute('aria-checked') === 'false') {
    q('[data-testid="rp-auto-compact"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(800)
  }

  /* ---------------- 4. 注入：其余分支 + 并存 ---------------- */
  log('')
  log('=== 4. 进行中 / 已跳过 / 已取消 / 未知原因（注入）===')
  const setSession = async (patch) => {
    store.setState({ session: { ...S().session, ...patch } })
    await sleep(250)
  }
  await setSession({
    isCompacting: true,
    compaction: { status: 'running', reason: 'threshold', startedAt: Date.now() },
    lastCompaction: { status: 'completed', reason: 'manual', endedAt: Date.now() }
  })
  const running = text('[data-testid="ctx-compacting-reason"]')
  log('  进行中: ' + JSON.stringify(running))
  ok(/压缩中/.test(running) && /已达阈值/.test(running), '进行中带原因：「压缩中 · 已达阈值」')
  ok(!!q('[data-testid="ctx-last-compaction"]'), '进行中时上一次的结果仍在（两条互不覆盖）')
  ok(/手动/.test(text('[data-testid="ctx-last-compaction"]')), '并存时「最近一次」仍是上一次的原因')
  /* 同一句不能同时出现两遍（D10 那类重复的回归网） */
  ok((sec.textContent.match(/已达阈值/g) ?? []).length === 1, '同一句提示只出现一次')

  await setSession({ compaction: { status: 'running', reason: 'overflow', startedAt: Date.now() } })
  ok(/上下文溢出/.test(text('[data-testid="ctx-compacting-reason"]')), 'reason=overflow → 「上下文溢出」')

  await setSession({ compaction: { status: 'running', reasonRaw: 'task-boundary', startedAt: Date.now() } })
  const raw = text('[data-testid="ctx-compacting-reason"]')
  log('  未知原因: ' + JSON.stringify(raw))
  ok(/task-boundary/.test(raw), '认不出的原因显示上游原文')
  ok(!/未知/.test(raw), '不把它显示成「未知」')

  await setSession({
    isCompacting: false,
    compaction: undefined,
    lastCompaction: { status: 'declined', reason: 'threshold', endedAt: Date.now() }
  })
  await openDetails()
  const declined = text('[data-testid="ctx-last-compaction"]')
  log('  已跳过: ' + JSON.stringify(declined))
  ok(/已跳过/.test(declined), 'declined 显示「已跳过」（不写成失败）')
  ok(!/失败/.test(declined), 'declined 不写成失败')
  ok(!!q('[data-testid="ctx-last-compaction-note"]'), 'declined 给出解释行（为什么没压）')

  await setSession({ lastCompaction: { status: 'cancelled', reason: 'manual', endedAt: Date.now() } })
  const cancelled = text('[data-testid="ctx-last-compaction"]')
  log('  已取消: ' + JSON.stringify(cancelled))
  ok(/已取消/.test(cancelled), 'cancelled 显示「已取消」')
  ok(!q('[data-testid="ctx-last-compaction-error"]'), '取消不是失败，没有错误行')

  await setSession({ lastCompaction: { status: 'failed', reason: 'manual', error: 'Compaction failed: 注入的原因' } })
  ok(!!q('[data-testid="ctx-last-compaction-error"]'), '失败：注入的原文也进错误行')
  ok(/注入的原因/.test(text('[data-testid="ctx-last-compaction-error"]')), '错误行显示原文')

  /* 收尾：把注入的状态清掉，不影响后面的场景/截图 */
  await setSession({ isCompacting: false, compaction: undefined, lastCompaction: undefined })

  return out.join('\n')
})()
