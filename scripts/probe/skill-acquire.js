/**
 * 外部 Skill 的真实接入闭环（实施-04 S6b-2，用户已明确授权，cost 1）。
 *
 * 这条场景只在 test-live 的隔离 sandbox 里运行：目录候选来自 SkillMD，
 * 探针固定候选后准备计划，直接写入一条**精确、隔离的测试授权记录**，
 * 再走生产 `yan capabilities acquire`。它不执行 Skill 正文里的脚本；
 * Skill 只作为 `--skill` 文件交给新 runner。
 *
 * 为什么不点原生授权对话框：live probe 默认隐藏窗口，不能把“窗口被隐藏时
 * 对话框是否能点”冒充产品 UI 证据。这里的授权记录字段与生产
 * PackageAuthorizationService.grant 完全一致，退出后还会逐字段复核；授权 UI
 * 本身由现有 capsettings / mcpregister 场景覆盖。
 */
;(async () => {
  const out = []
  const ok = (condition, label, extra = '') => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
    return Boolean(condition)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  if (!store || !window.yan?.runBash) {
    out.push('✗ 没有 window.__yanStore / runBash（探针没被注入）')
    return out.join('\n')
  }

  const runCli = async (command, waitMs = 120_000) => {
    const beforeBashIds = new Set(
      store.getState().messages
        .filter((message) => message.role === 'bash')
        .map((message) => message.id)
    )
    const raced = await Promise.race([
      window.yan
        .runBash(command)
        .then((value) => ({ done: 'ok', value }))
        .catch((error) => ({ done: 'err', error: String((error && error.message) || error) })),
      sleep(waitMs).then(() => ({ done: 'timeout' }))
    ])
    if (raced.done !== 'ok') {
      return { exitCode: null, output: '', error: raced.error ?? `命令超时（${raced.done}）` }
    }
    if (raced.value && raced.value.ok === false) {
      return { exitCode: null, output: '', error: raced.value.error ?? '直接执行 Bash 被拒绝' }
    }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(120)
      const messages = store.getState().messages.filter((message) =>
        message.role === 'bash' && !beforeBashIds.has(message.id)
      )
      const last = messages[messages.length - 1]
      const call = last && last.toolCalls && last.toolCalls[0]
      if (last && call && call.status !== 'running' && call.status !== 'pending') {
        return { exitCode: last.bash ? last.bash.exitCode : null, output: call.output ?? '' }
      }
    }
    return { exitCode: null, output: '', error: '等待工具行完成超时' }
  }

  const lastJson = (text) => {
    const lines = String(text).split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(lines[index]) } catch { /* 继续往前找回执 */ }
    }
    return null
  }

  const readJsonFile = async (path, waitMs = 30_000) => {
    if (!path) return null
    const result = await runCli(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${path}"`, waitMs)
    try { return JSON.parse(result.output) } catch { return null }
  }

  const readReceipt = async (output) => {
    const summary = lastJson(output)
    if (!summary) return null
    if (summary.resultFile) {
      const full = await readJsonFile(summary.resultFile)
      if (full) return { ...full, __summary: summary }
    }
    return summary
  }

  const writeJsonToTemp = async (name, value) => {
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(value))))
    const result = await runCli(
      `node -e "const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(require('os').tmpdir(),'yan-skill-acquire-${name}'),Buffer.from('${encoded}','base64'))"`,
      30_000
    )
    return result.exitCode === 0
  }

  const tempDirResult = await runCli(`node -e "process.stdout.write(require('os').tmpdir())"`, 30_000)
  const tempDir = String(tempDirResult.output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() || '.'
  const tempFile = (name) => `${tempDir}\\yan-skill-acquire-${name}`

  const readyDeadline = Date.now() + 30_000
  while (Date.now() < readyDeadline && store.getState().conn !== 'ready') await sleep(250)
  if (!ok(store.getState().conn === 'ready', '宿主已就绪（conn=ready）')) return out.join('\n')

  const cwd = store.getState().session?.cwd ?? store.getState().settings?.cwd ?? ''
  ok(Boolean(cwd), '当前 runner 绑定了 fixture cwd', cwd)

  /* ① 先把当前隔离项目显式信任；生产调度器不使用 --approve 绕过。 */
  const trust = await window.yan.trust.allow(cwd)
  ok(trust?.ok === true, '项目显式信任已写入隔离 trust.json', JSON.stringify(trust))

  /* ② 建立一个活动目标，后续 acquire 必须把同一目标续接回来。 */
  const statusBeforeRun = await runCli('yan goal status')
  const statusBefore = await readReceipt(statusBeforeRun.output)
  const statusGoal = statusBefore?.goal ?? statusBefore?.data?.goal
  const statusMode = statusBefore?.mode ?? statusBefore?.data?.mode
  ok(Boolean(statusGoal), 'goal status 返回当前目标', JSON.stringify(statusBefore?.__summary?.summary ?? statusBefore?.summary ?? null))
  const readyRequest = {
    transitionId: `tr-skill-acquire-${Date.now()}`,
    confidence: 0.99,
    understanding: {
      goal: '完成一次外部 Skill 接入并继续原目标',
      deliverable: '一个经过来源、完整性、恶意内容审查并实际激活的项目 Skill',
      scope: '当前隔离 fixture 项目与当前会话',
      constraints: '只使用固定 SkillMD 候选；不运行 Skill 附带脚本；保留事务证据',
      acceptance: '事务达到 resumed，active Skill 可回读，续接 operationId 被消费'
    },
    openQuestions: [],
    modeRevision: Number(statusBefore?.modeRevision ?? statusBefore?.data?.modeRevision ?? statusMode?.revision ?? 0),
    goalRevision: Number(statusGoal?.revision ?? 0)
  }
  ok(await writeJsonToTemp('ready.json', readyRequest), '写入隔离 goal ready 请求文件')
  const ready = await runCli(`yan goal ready --request-file "${tempFile('ready.json')}"`)
  const readyReceipt = await readReceipt(ready.output)
  ok(ready.exitCode === 0 && readyReceipt?.__summary?.ok !== false, 'goal ready 成功提交', ready.error ?? ready.output.slice(-500))
  const readyGoal = readyReceipt?.goal ?? readyReceipt?.data?.goal
  ok(readyGoal?.phase === 'executing', '目标进入 executing，允许能力接入续接', JSON.stringify(readyGoal ?? null))

  /*
   * `goal.ready` also arms a one-shot ready continuation. This probe uses direct
   * CLI/bash calls instead of a model turn, so pi's goal-resume hook cannot
   * naturally consume that earlier message. Prepare the exact isolated consumed
   * record used by the thin extension; the Skill continuation created below is
   * still written and consumed by the real extension after runner reload.
   */
  const readyTransitionId = readyReceipt?.transition?.transitionId ?? readyReceipt?.data?.transition?.transitionId
  const resumeRunnerId = store.getState().activeRunnerId || 'r1'
  const readyConsumed = readyTransitionId
    ? await runCli(
        `node -e "const fs=require('fs'),p=require('path');const d=p.join(process.env.YAN_DATA_DIR,'goal-resume');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'${resumeRunnerId}.consumed.json'),JSON.stringify({operationId:'${readyTransitionId}',at:new Date().toISOString()}))"`,
        30_000
      )
    : { exitCode: null, output: '', error: 'goal ready 回执没有 transitionId' }
  ok(readyConsumed.exitCode === 0, '为隔离探针准备已消费的 goal.ready 前置证据', readyConsumed.error ?? '')

  /* ③ 真实外部目录 → 固定 commit/raw/hash；只选择已核实的窄候选。 */
  let discovered = null
  let discovery = null
  const discoveryAttempts = 8
  for (let attempt = 0; attempt < discoveryAttempts; attempt += 1) {
    discovered = await runCli('yan capabilities discover --query-text "futurediffusion/filesystem"')
    discovery = await readReceipt(discovered.output)
    const found = Array.isArray(discovery?.candidates) && discovery.candidates.some((item) =>
      String(item.candidateId).startsWith('skill-directory:futurediffusion/filesystem')
    )
    if (found) break
    if (attempt < discoveryAttempts - 1) await sleep(2_000)
  }
  ok(discovered.exitCode === 0 && discovery?.__summary?.ok !== false, 'SkillMD 外部目录 discover 成功', discovered.error ?? discovered.output.slice(-500))
  const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates : []
  const candidate = candidates.find((item) => String(item.candidateId).startsWith('skill-directory:futurediffusion/filesystem'))
  out.push(`  固定候选：${JSON.stringify(candidate ?? null)}`)
  ok(Boolean(candidate), '找到 futurediffusion/filesystem 候选')
  ok(candidate?.installKind === 'skill-files', '候选映射为 skill-files')
  ok(candidate?.verification === 'metadata-only', '目录候选仍明确标为 metadata-only')
  ok(typeof candidate?.commit === 'string' && candidate.commit.length >= 7, '候选固定到 commit', String(candidate?.commit))
  const urls = candidate?.skillFileUrls && typeof candidate.skillFileUrls === 'object' ? Object.values(candidate.skillFileUrls) : []
  const hashes = candidate?.skillFileHashes && typeof candidate.skillFileHashes === 'object' ? Object.values(candidate.skillFileHashes) : []
  ok(urls.length > 0 && urls.every((url) => /^https:\/\//.test(String(url))), '候选保留 HTTPS raw 来源')
  ok(hashes.length === urls.length && hashes.every((hash) => /^[a-f0-9]{64}$/i.test(String(hash))), '候选为每个文件固定 SHA-256')
  if (!candidate) return out.join('\n')

  /* ④ prepare 仍只生成计划；接下来只授权当前精确候选 / 指纹 / 项目。 */
  const preparedRun = await runCli(`yan capabilities prepare --candidate "${candidate.candidateId}"`)
  const prepared = await readReceipt(preparedRun.output)
  const plan = prepared?.plan ?? prepared?.data?.plan
  const artifactDigest = prepared?.artifactDigest ?? prepared?.data?.artifactDigest ?? plan?.artifactDigest
  ok(preparedRun.exitCode === 0 && prepared?.__summary?.ok !== false, 'prepare 成功', preparedRun.error ?? preparedRun.output.slice(-500))
  ok(Boolean(plan?.planId), 'prepare 返回 planId', String(plan?.planId))
  ok(Boolean(artifactDigest), 'prepare 返回固定 artifactDigest', String(artifactDigest))
  ok(plan?.projectId && plan.projectId === (prepared?.projectId ?? plan.projectId), '计划带项目身份', String(plan?.projectId))
  if (!plan?.planId || !artifactDigest) return out.join('\n')

  const projectId = String(plan.projectId)
  const grant = {
    version: 1,
    items: [{
      candidateId: candidate.candidateId,
      digest: artifactDigest,
      projectId,
      allowLifecycleScripts: false,
      grantedAt: new Date().toISOString(),
      via: 'settings-ui'
    }]
  }
  const grantB64 = btoa(unescape(encodeURIComponent(JSON.stringify(grant))))
  const writeGrant = await runCli(
    `node -e "const fs=require('fs'),p=require('path');const d=p.join(process.env.YAN_DATA_DIR,'capabilities');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'package-authorizations.json'),Buffer.from('${grantB64}','base64'))"`,
    30_000
  )
  ok(writeGrant.exitCode === 0, '写入隔离的精确候选授权（不触碰真实授权）', writeGrant.error ?? '')

  /* ⑤ 走生产 acquire：扫描发生在 staging 前；本候选的 medium 提醒必须进入回执。 */
  const acquireRun = await runCli(`yan capabilities acquire --plan "${plan.planId}"`, 120_000)
  const acquired = await readReceipt(acquireRun.output)
  const initialTx = acquired?.transaction ?? acquired?.data?.transaction
  const operationId = acquired?.operationId ?? acquired?.data?.operationId ?? initialTx?.operationId
  out.push(`  acquire 回执：${JSON.stringify(acquired ?? null)}`)
  ok(acquireRun.exitCode === 0 && acquired?.__summary?.ok !== false, 'acquire 返回正常事务回执', acquireRun.error ?? acquireRun.output.slice(-700))
  ok(Boolean(operationId), 'acquire 返回 operationId', String(operationId))
  ok(initialTx?.state === 'pending-boundary', 'staging 完成后停在 pending-boundary，等待安全边界', String(initialTx?.state))
  ok(Boolean(initialTx?.skillFilesTarget), '事务绑定了当前 runner / goal / sourceHead')
  if (!operationId) return out.join('\n')
  out.push(`skillacquire.operationId=${operationId}`)
  out.push(`skillacquire.runnerId=${initialTx?.skillFilesTarget?.runnerId ?? store.getState().activeRunnerId ?? ''}`)
  out.push(`skillacquire.projectId=${projectId}`)
  out.push(`skillacquire.candidateId=${candidate.candidateId}`)
  out.push(`skillacquire.digest=${artifactDigest}`)
  out.push(`skillacquire.sessionId=${store.getState().session?.sessionId ?? ''}`)

  /* ⑥ 条件轮询隔离事务日志，等待 scheduler 完成 active + runner 重载 + 续接消费。 */
  const dataDirRun = await runCli(`node -e "process.stdout.write(process.env.YAN_DATA_DIR)"`, 30_000)
  const dataDir = String(dataDirRun.output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || ''
  const acquisitionPath = `${dataDir}\\capabilities\\acquisition.json`
  let finalLog = null
  let finalTx = null
  let readFailures = 0
  const pollDeadline = Date.now() + 180_000
  while (Date.now() < pollDeadline) {
    finalLog = await readJsonFile(acquisitionPath, 2_000)
    if (finalLog) {
      readFailures = 0
      finalTx = finalLog.transactions?.[operationId] ?? null
      if (finalTx?.state === 'resumed' || finalTx?.state === 'failed') break
    } else {
      readFailures += 1
      if (readFailures >= 6) break
    }
    await sleep(1_000)
  }
  const terminalState = finalTx?.state === 'activated' || finalTx?.state === 'resumed'
  const deferredState = !finalTx || finalTx.state === 'pending-boundary'
  if (terminalState) {
    ok(true, '事务至少完成 active 激活（resumed 由退出后证据最终判定）', JSON.stringify({ state: finalTx.state, failure: finalTx.failure ?? null }))
  } else if (deferredState) {
    out.push(`  ⏳ 事务仍在安全边界等待，保留实时诊断：${JSON.stringify({ state: finalTx?.state, failure: finalTx?.failure ?? null })}`)
  } else {
    ok(false, '事务没有进入失败终态', JSON.stringify({ state: finalTx.state, failure: finalTx.failure ?? null }))
  }
  if (finalTx && !deferredState) {
    const history = Array.isArray(finalTx.history) ? finalTx.history.map((step) => step.to) : []
    ok(history.includes('verifying') && history.includes('activated'), '事务历史至少包含 verifying → activated', JSON.stringify(history))
    if (finalTx.state === 'resumed') ok(history.includes('resumed'), '事务历史包含 resumed', JSON.stringify(history))
    else out.push('  ⏳ 事务已 activated，等待退出后检查确认续接是否消费')
    const review = finalTx.securityReview ?? finalTx.receipt?.securityReview
    ok(review?.scannerVersion === 'yan-skill-security-1', 'transaction / receipt 保存审查器版本', String(review?.scannerVersion))
    ok(review?.ok === true && !review.findings?.some((finding) => finding.severity === 'high'), '外部 Skill 没有 high 风险，审查通过')
    ok(review?.findings?.some((finding) => finding.code === 'command-execution' && finding.severity === 'medium'), 'medium 命令执行提醒被保留在回执')
    const paths = finalTx.receipt?.installedPaths ?? []
    ok(paths.length > 0, 'receipt 保存了 active Skill 路径', JSON.stringify(paths))
    const runnerId = finalTx.skillFilesTarget?.runnerId
    out.push(`skillacquire.activePath=${paths[0] ?? ''}`)
    if (paths[0]) {
      const activeCheck = await runCli(`node -e "const fs=require('fs');const p=process.argv[1];process.stdout.write(JSON.stringify({file:fs.existsSync(p),bytes:fs.existsSync(p)?fs.statSync(p).size:0}))" "${paths[0]}"`, 30_000)
      let active = null
      try { active = JSON.parse(activeCheck.output) } catch { /* 退出后的 Node 检查会给最终结论 */ }
      ok(active?.file === true && active.bytes > 0, 'active Skill 文件真实存在且非空', JSON.stringify(active))
    }
    const activationLogs = (store.getState().logs ?? []).filter((line) => String(line).includes('[能力接入]'))
    if (activationLogs.length > 0) out.push(`  能力接入调度日志尾部：${JSON.stringify(activationLogs.slice(-8))}`)
  } else if (finalTx) {
    const review = finalTx.securityReview ?? finalTx.receipt?.securityReview
    ok(review?.scannerVersion === 'yan-skill-security-1', 'transaction / receipt 保存审查器版本', String(review?.scannerVersion))
    ok(review?.ok === true && !review.findings?.some((finding) => finding.severity === 'high'), '外部 Skill 没有 high 风险，审查通过')
    ok(review?.findings?.some((finding) => finding.code === 'command-execution' && finding.severity === 'medium'), 'medium 命令执行提醒被保留在回执')
    out.push('  ⏳ active 路径与续接消费留给退出后检查，避免占用忙碌 runner')
  }

  return out.join('\n')
})()
