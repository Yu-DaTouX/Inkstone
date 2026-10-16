;(async () => {
  const out = []
  const ok = (cond, label, extra = '') => {
    out.push(`  ${cond ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
    return Boolean(cond)
  }
  const log = (s) => out.push(String(s))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const early = (msg) => {
    out.push(msg)
    return out.join('\n')
  }
  if (!store || !window.yan?.runBash) return early('  ✗ 没有 window.__yanStore / runBash（探针没被注入）')

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
      }
    }
    return null
  }

  const readJsonFile = async (path) => {
    const res = await runCli(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${path}"`)
    try {
      return JSON.parse(res.output)
    } catch {
      return null
    }
  }

  log('=== discover → prepare → mcp-native-only；不调模型、不登记服务 ===')

  try {
    let ready = false
    for (let i = 0; i < 60; i++) {
      if (store.getState().conn === 'ready') {
        ready = true
        break
      }
      await sleep(500)
    }
    if (!ok(ready, '宿主已就绪（conn=ready）')) return out.join('\n')

    log('--- 1. discover（本地目录 fixture） ---')
    const discover = await runCli('yan capabilities discover --query-text "fixture remote service"')
    const dRec = lastJson(discover.output)
    log('  回执：' + JSON.stringify(dRec && dRec.summary))
    ok(dRec && dRec.ok === true, 'discover 成功（exit 0）')
    const dFull = await readJsonFile(dRec && dRec.resultFile)
    const candidates = (dFull && dFull.candidates) || []
    const candidate = candidates.find((c) => c.installKind === 'remote')
    ok(!!candidate, '目录里检索到远程 MCP 候选', JSON.stringify(candidates.map((c) => c.candidateId)))
    if (!candidate) return out.join('\n')
    ok(
      String(candidate.remoteUrl || '').includes('/mcp'),
      '候选带明确的 remoteUrl（不从 sourceUrls 里猜端点）',
      String(candidate.remoteUrl)
    )
    ok(
      candidate.verification === 'metadata-only',
      '候选如实标注 verification=metadata-only（目录只是线索）',
      String(candidate.verification)
    )

    log('--- 2. prepare ---')
    const prep = await runCli(`yan capabilities prepare --candidate '${candidate.candidateId}'`)
    const pRec = lastJson(prep.output)
    const pFull = await readJsonFile(pRec && pRec.resultFile)
    ok(pRec && pRec.ok === true, 'prepare 成功（exit 0）')
    ok(!!(pFull && pFull.plan && pFull.plan.planId), '拿到 planId')
    if (!pFull?.plan) return out.join('\n')
    const planId = pFull.plan.planId
    ok(
      pFull.plan.policyResult === 'needs-authorization',
      '目录候选默认停在 needs-authorization（不自动登记）',
      String(pFull.plan.policyResult)
    )
    ok(pFull.executable === false, 'prepare 本身不执行（executable=false）')

    const before = JSON.stringify((await window.yan.capabilities.snapshot()).mcpServers)
    for (const authorize of [false, true, true]) {
      const result = await runCli(`yan capabilities acquire --plan ${planId}${authorize ? ' --authorize' : ''}`)
      const receipt = lastJson(result.output)
      const full = await readJsonFile(receipt?.resultFile)
      ok(receipt?.ok === true, '停用分支给出正常回执而非崩溃')
      ok(full?.state === 'mcp-native-only' && full.executable === false, '无论授权或重放都不能登记旧宿主 MCP', JSON.stringify(full && { state: full.state, executable: full.executable }))
      ok(/pi.*原生/.test(String(full?.notice || '')), '引导 pi 原生入口而非 --authorize')
      ok(!full?.serverId && !full?.tools && !full?.authorization, '不冒充已连接、已授权或已登记')
      ok(receipt?.summary?.executed === false, '摘要如实声明未执行')
    }
    const after = JSON.stringify((await window.yan.capabilities.snapshot()).mcpServers)
    ok(before === after, '兼容服务快照未被获取分支改写')
  } catch (error) {
    log('探针异常：' + String((error && error.stack) || error))
    ok(false, '探针本身没抛异常')
  }

  return out.join('\n')
})()
