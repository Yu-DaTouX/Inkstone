/**
 * `yan capabilities discover / prepare / acquire` 的**宿主链路 + 真实目录检索**（实施-04 S5，cost 0）。
 *
 * ── 这一条为什么必须真连网 ──
 *   §12 S5 的出口原文是「**真实目录检索证据**（不能只用 fixture 断言排名）」。
 *   单测能把排名 / 截断 / 失败处理钉死，但它永远证明不了「今天这两个目录真的能查到东西」——
 *   而那正是本片交付的核心。所以这里真的发请求，并断言回执的**来源与可信度标注**。
 *
 * ── 离线怎么办 ──
 *   两个源都失败时**不算通过也不算失败**：明确打印「离线，跳过」。
 *   理由与 `probe:chrome`（无 Chrome 时跳过）一致：网络不是本仓库的可控前提，
 *   但「编造一次成功」更糟。在线时则按强断言验。
 *
 * 依赖：宿主已就绪（YAN_CLI_* 注入 pi 子进程），见 capability-cli.js 的同一套做法。
 */
;(async () => {
  const out = []
  const ok = (cond, label, extra = '') => {
    out.push(`  ${cond ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
    return Boolean(cond)
  }
  const log = (s) => out.push(String(s))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  if (!store || !window.yan?.runBash) {
    out.push('✗ 没有 window.__yanStore / runBash（探针没被注入）')
    return out.join('\n')
  }

  const runCli = async (command, waitMs = 60_000) => {
    const raced = await Promise.race([
      window.yan
        .runBash(command)
        .then((v) => ({ done: 'ok', v }))
        .catch((e) => ({ done: 'err', v: String((e && e.message) || e) })),
      sleep(waitMs).then(() => ({ done: 'timeout' }))
    ])
    if (raced.done !== 'ok') {
      return { ok: false, exitCode: null, output: '', error: `命令未在 ${waitMs}ms 内结束（${raced.done}）` }
    }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(120)
      const msgs = store.getState().messages.filter((m) => m.role === 'bash')
      const last = msgs[msgs.length - 1]
      const call = last && last.toolCalls && last.toolCalls[0]
      if (last && call && call.status !== 'running' && call.status !== 'pending') {
        return { ok: true, exitCode: last.bash ? last.bash.exitCode : null, output: call.output ?? '' }
      }
    }
    return { ok: false, exitCode: null, output: '', error: '等工具行完成超时' }
  }

  const lastJson = (text) => {
    const lines = String(text)
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('{'))
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i])
      } catch {
        /* 继续往前找 */
      }
    }
    return null
  }

  /** 渲染端拿不到任意文件读，直执行 shell 可以。 */
  const readJsonFile = async (path) => {
    const res = await runCli(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${path}"`)
    try {
      return JSON.parse(res.output)
    } catch {
      return null
    }
  }

  /*
   * 回执可能**落盘**：stdout 只给摘要（`{ok, summary, resultFile}`），
   * 完整 data 在 `resultFile` 里。候选多的时候必定走这条（大结果不灌进上下文）。
   */
  const readReceipt = async (output) => {
    const summary = lastJson(output)
    if (!summary) return null
    if (summary.resultFile) {
      const full = await readJsonFile(summary.resultFile)
      if (full) return { ...full, __summary: summary }
    }
    return summary
  }

  const readyDeadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < readyDeadline) {
    if (store.getState().conn === 'ready') {
      ready = true
      break
    }
    await sleep(250)
  }
  if (!ok(ready, '宿主已就绪（conn=ready）')) return out.join('\n')

  log('--- 1. 真实目录检索（联网） ---')

  /*
   * 检索词选一个**通用单词**：`filesystem` 在两边都有真实结果（2026-09-19 实测）。
   * 一开始用 `filesystem storage tools` 时 MCP Registry 返回 0 条 —— 它的 search
   * 是偏精确的匹配，长句会搜不到东西。所以这里用一个词，才能真正证明**两条路径**都通。
   */
  const discovered = await runCli('yan capabilities discover --query-text "filesystem"')
  const receipt = await readReceipt(discovered.output)

  if (!receipt) {
    out.push('✗ discover 没有回执')
    out.push(discovered.output.slice(0, 800))
    return out.join('\n')
  }

  const sources = Array.isArray(receipt.sources) ? receipt.sources : []
  const candidates = Array.isArray(receipt.candidates) ? receipt.candidates : []
  const okSources = sources.filter((s) => s.ok)
  const online = okSources.length > 0
  log('  回执 keys: ' + JSON.stringify(Object.keys(receipt)))

  log(`  脱敏后的检索词：${JSON.stringify(receipt.query)}`)
  log(`  源：${JSON.stringify(sources.map((s) => ({ id: s.sourceId, ok: s.ok, pages: s.pages, n: s.candidateCount, error: s.error ?? null })))}`)
  log(`  候选数：${candidates.length}`)
  log(`  候选 ID：${JSON.stringify(candidates.slice(0, 6).map((c) => c.candidateId))}`)

  if (!online) {
    /* 离线：如实跳过，不假装验过（与 probe:chrome 同一口径）。 */
    log('  ⤺ 跳过：两个目录源都不可用（离线环境）；失败原因已如实记录')
    ok(sources.length === 2, '离线时仍记录了两个源的状态', JSON.stringify(sources.map((s) => s.sourceId)))
    ok(candidates.length === 0, '离线时不编造候选（返回空）')
    ok(/暂时无法搜索/.test(String(receipt.reason ?? '')), '离线时给出「暂时无法搜索」这个可读原因')
    return out.join('\n')
  }

  ok(okSources.length >= 1, '至少一个目录源真实可用（这是 S5 的真实检索证据）', okSources.map((s) => s.sourceId).join(','))
  ok(
    okSources.some((s) => s.kind === 'mcp-registry' && s.candidateCount > 0),
    '**MCP** 目录路径也真的返回了候选（两条路径都不能只是「源可达」）',
    JSON.stringify(okSources.map((s) => ({ k: s.kind, n: s.candidateCount })))
  )
  ok(
    okSources.some((s) => s.kind === 'npm-registry' && s.candidateCount > 0),
    '**npm** 目录路径也真的返回了候选'
  )
  ok(candidates.length > 0, '真实目录返回了候选', String(candidates.length))
  ok(candidates.length <= 8, '候选被截到八项（§7.2 上限）', String(candidates.length))
  ok(
    candidates.every((c) => c.verification === 'metadata-only'),
    '候选一律标 metadata-only（目录元数据 ≠ 已验证）'
  )
  ok(
    candidates.every((c) => Array.isArray(c.sourceUrls) && c.sourceUrls.length > 0),
    '每条候选都有可回溯的原始来源链接'
  )
  ok(
    candidates.every((c) => /^(npm|mcp-registry):/.test(String(c.candidateId))),
    '候选 ID 形状正确（来源前缀 + 确切版本）',
    String(candidates[0]?.candidateId)
  )
  ok(
    candidates.every((c) => Array.isArray(c.requirements) && c.requirements.length > 0),
    '每条候选都写清了运行要求 / 未核实项'
  )
  ok(
    sources.filter((s) => !s.ok).every((s) => typeof s.error === 'string' && s.error.length > 0),
    '失败的源带具体错误（不是笼统「不可用」）'
  )
  ok(/脱敏|metadata-only/.test(String(receipt.notice ?? '')), '回执里有能力边界说明（模型不该把目录当已验证）')

  log('--- 2. 接入计划（prepare，只生成不执行）---')

  const firstId = candidates[0].candidateId
  const prepared = await runCli(`yan capabilities prepare --candidate "${firstId}"`)
  const planReceipt = await readReceipt(prepared.output)
  log(`  prepare(${firstId}) → ${JSON.stringify(planReceipt && planReceipt.plan)}`)
  ok(Boolean(planReceipt) && Boolean(planReceipt.plan), 'prepare 生成了接入计划')
  ok(planReceipt?.plan?.policyResult !== undefined, '计划带 policyResult（策略判定）', String(planReceipt?.plan?.policyResult))
  ok(planReceipt?.plan?.pinnedSource === firstId, '计划固定到确切来源（不因搜索第一名就自动执行）')
  ok(planReceipt?.plan?.planId?.length > 0, '计划有稳定 ID', String(planReceipt?.plan?.planId))
  ok(planReceipt?.executable === false, '计划明确「不执行」（S5 边界：真正接入是 S6）')

  const unknown = await runCli('yan capabilities prepare --candidate "npm:definitely-not-a-cached-candidate@0.0.0"')
  log(`  未知候选 → 退出码 ${unknown.exitCode}`)
  ok(unknown.exitCode !== 0, '未知候选 ID 不报成功', String(unknown.exitCode))
  ok(/candidate_unknown|没有这个候选/.test(unknown.output), '未知候选给可读原因（不是堆栈）')
  ok(!/\n\s+at\s+\S/.test(unknown.output), '未知候选不吐 Node 堆栈')

  log('--- 3. acquire 已接通：策略判定 + 受管事务（实施-04 S6a）---')

  /*
   * 这一节原来验的是「S6 之前，acquire 必须回 not_implemented」。
   * S6a 落地后它变成**假要求**（功能做出来了却被判失败）。
   * 换成同一意图（**不许静默成功**、错误要可分支、不能假装装好了）的当前事实：
   * 形状合法但不存在的计划 → 非零退出 + 可读原因；缺 --plan → 参数层直接拒。
   */
  const acquire = await runCli('yan capabilities acquire --plan 000000000000000000000000')
  log(`  acquire(未知计划) → 退出码 ${acquire.exitCode}`)
  ok(acquire.exitCode !== 0, 'acquire 未知计划不报成功', String(acquire.exitCode))
  ok(
    /plan_unknown|没有这个计划/.test(acquire.output),
    'acquire 未知计划给可读原因（不是 not_implemented，也不是堆栈）'
  )
  ok(!/\n\s+at\s+\S/.test(acquire.output), 'acquire 不吐 Node 堆栈')

  const acquireNoPlan = await runCli('yan capabilities acquire')
  log(`  acquire(缺 --plan) → 退出码 ${acquireNoPlan.exitCode}`)
  ok(acquireNoPlan.exitCode !== 0, 'acquire 缺 --plan 不报成功', String(acquireNoPlan.exitCode))
  ok(/--plan|计划/.test(acquireNoPlan.output), 'acquire 缺 --plan 明确说要计划 ID')

  void q /* 保留 DOM 入口备用，避免未使用告警 */
  return out.join('\n')
})()
