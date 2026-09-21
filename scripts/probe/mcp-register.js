/**
 * 远程 MCP 的**自动登记闭环**（实施-04 S6b-1，cost 0）—— 不调模型。
 *
 * 验的是「从确认未配置开始」的完整路径，四段缺一不可：
 *   ① `discover` 从一个**真目录服务**（本地 fixture，MCP Registry 形状）拿到远程候选；
 *   ② 未授权时 `acquire` **不登记**（如实停在 `needs-authorization`）；
 *   ③ `--authorize` 请求并由隔离 test fixture 模拟主进程确认之后，真的核验端点并写受管配置；
 *   ④ 登记完**当场**能在能力目录里看到、并且 `yan mcp call` 真的调得通 —— 不需要重启。
 *   ⑤ 同一计划重放不重复登记（幂等）。
 *
 * 两个服务都由 test-live 在 Node 侧起（探针在渲染进程起不了服务）：
 *   · 目录 fixture：`YAN_MCP_REGISTRY_URL` 指向它（npm 源同样指向本地，避免真联网）；
 *   · MCP HTTP fixture：`scripts/lib/mcp-http-fixture.mjs`（官方 SDK，真握手）。
 * 服务配置写进 sandbox（`YAN_MCP_SERVERS_FILE`），**不碰用户真实配置**。
 */
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
   * 请求文件写进**系统临时目录**：探针跑在项目根下，相对路径会把
   * `mcp-reg-call.json` 这类中间文件留在仓库里（首次跑就污染了工作区）。
   * 路径由 node 自己算 —— `$TEMP` 在 pi 的 bash 通道里不一定会展开。
   */
  const writeJson = async (name, value) => {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(value))))
    const res = await runCli(
      `node -e "const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(require('os').tmpdir(),'yan-mcpreg-probe-${name}'),Buffer.from('${b64}','base64'))"`
    )
    return res.exitCode === 0
  }

  const tmpDirRes = await runCli(`node -e "process.stdout.write(require('os').tmpdir())"`)
  const TMPDIR =
    String(tmpDirRes.output)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() || '.'
  const tmpFile = (name) => `${TMPDIR}\\yan-mcpreg-probe-${name}`

  log('=== yan capabilities discover → 主进程确认授权 → 能力目录 → mcp call（cost 0）===')

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

    /* ---- 1. discover：从真目录服务拿到远程候选 ---- */
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

    /* ---- 2. prepare：生成计划，默认需要授权 ---- */
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

    /* ---- 3. 未授权 acquire：一个字节都不该写 ---- */
    log('--- 3. acquire（未授权） ---')
    const acq1 = await runCli(`yan capabilities acquire --plan ${planId}`)
    const a1Rec = lastJson(acq1.output)
    const a1Full = await readJsonFile(a1Rec && a1Rec.resultFile)
    ok(a1Rec && a1Rec.ok === true, 'acquire 未授权时仍是正常回执（不是崩溃）')
    ok(
      a1Full && a1Full.state === 'needs-authorization' && a1Full.executable === false,
      '未授权：停在 needs-authorization，executable=false',
      JSON.stringify(a1Full && { state: a1Full.state, executable: a1Full.executable })
    )
    ok(
      /--authorize/.test(String((a1Full && a1Full.notice) || '')),
      '回执告诉模型下一步怎么做（--authorize）'
    )

    /* ---- 4. --authorize 只请求确认；隔离 live fixture 代替人工点击 ---- */
    log('--- 4. acquire --authorize（确认由主进程授权边界处理） ---')
    const acq2 = await runCli(`yan capabilities acquire --plan ${planId} --authorize`)
    const a2Rec = lastJson(acq2.output)
    const a2Full = await readJsonFile(a2Rec && a2Rec.resultFile)
    log('  回执：' + JSON.stringify(a2Rec && a2Rec.summary))
    ok(a2Rec && a2Rec.ok === true, '授权后的 acquire 成功（exit 0）')
    ok(
      a2Full && a2Full.state === 'resumed' && a2Full.executable === true,
      '授权后真的登记并进入 resumed',
      JSON.stringify(a2Full && { state: a2Full.state, executable: a2Full.executable })
    )
    const tools = (a2Full && a2Full.tools) || []
    ok(
      tools.includes('echo') && tools.includes('boom'),
      '核验时真的连上并枚举到 fixture 的工具',
      JSON.stringify(tools)
    )
    ok(!!(a2Full && a2Full.authorization && a2Full.authorization.host), '回执带回持久授权记录（只记 host）')
    ok(
      !/password|token|secret/i.test(JSON.stringify(a2Full && a2Full.authorization)),
      '授权记录里不含凭证'
    )
    const serverId = a2Full && a2Full.serverId
    ok(!!serverId, '回执给出 serverId', String(serverId))
    if (!serverId) return out.join('\n')

    /* ---- 5. 当场可见：不需要重启就能在能力目录里查到 ---- */
    log('--- 5. capabilities search（当场可见） ---')
    const search = await runCli('yan capabilities search --query-text "echo"')
    const sRec = lastJson(search.output)
    const sFull = await readJsonFile(sRec && sRec.resultFile)
    const hit = ((sFull && sFull.hits) || []).find((h) => h.id === `mcp:${serverId}/echo`)
    ok(!!hit, '登记后能力目录当场可见（无需重启）', JSON.stringify(((sFull && sFull.hits) || []).map((h) => h.id)))
    if (hit) {
      ok(hit.availability === 'ready', 'availability 是 ready', String(hit.availability))
      ok(hit.kind === 'mcp-tool', 'kind 是 mcp-tool', String(hit.kind))
      ok(hit.effect === 'unknown', 'effect 不由目录 / 服务自报（unknown）', String(hit.effect))
    }

    /* ---- 6. 真的能用：mcp call 走的是新登记的服务 ---- */
    log('--- 6. mcp call ---')
    const wroteCall = await writeJson('mcp-reg-call.json', {
      serverId,
      toolName: 'echo',
      arguments: { text: 'hello-register' }
    })
    ok(wroteCall, '写好调用请求文件')
    const call = await runCli(`yan mcp call --request-file "${tmpFile('mcp-reg-call.json')}"`)
    const cRec = lastJson(call.output)
    const cFull = await readJsonFile(cRec && cRec.resultFile)
    ok(cRec && cRec.ok === true, 'mcp call 成功（exit 0）')
    ok(
      cRec && cRec.summary && cRec.summary.toolError === false,
      '调用不是工具级错误',
      JSON.stringify(cRec && cRec.summary)
    )
    ok(
      JSON.stringify(cFull || {}).includes('http:hello-register'),
      '返回值真的来自 fixture（不是编的）'
    )

    /* ---- 7. 幂等：同一计划重放不重复登记 ---- */
    log('--- 7. 重放同一计划 ---')
    const acq3 = await runCli(`yan capabilities acquire --plan ${planId} --authorize`)
    const a3Full = await readJsonFile(lastJson(acq3.output)?.resultFile)
    ok(a3Full && a3Full.replayed === true, '同一计划重放：只复核，不重复写配置', JSON.stringify(a3Full && a3Full.replayed))
  } catch (error) {
    log('探针异常：' + String((error && error.stack) || error))
    ok(false, '探针本身没抛异常')
  }

  return out.join('\n')
})()
