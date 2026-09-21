/**
 * `yan mcp describe` / `yan mcp call` 的**宿主链路**（实施-04 S3）—— 不调模型。
 *
 * 真 CLI → 真 `CapabilityServer` → 真 `McpConnectionManager` → **真 MCP 服务**
 * （官方 SDK 的 stdio server，见 `scripts/lib/mcp-stdio-fixture.mjs`）。
 *
 * 验四类会让模型「能不能自己纠错」的决定性行为：
 *   ① describe 给 schemaRevision；② 正常 call 回结果；
 *   ③ **工具级失败**是 `toolError:true` 的结果，不是崩溃；
 *   ④ 参数不合 / revision 过期回**可重试**的错（`invalid_arguments` / `schema-changed`），
 *      而不是拿旧参数硬调或吐一个堆栈。
 *
 * 服务配置来自 `YAN_MCP_SERVERS_FILE`（test-live 生成），不碰用户配置。
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
  if (!store) return early('  ⤺ 跳过：没有 window.__yanStore（探针没被注入）')

  const runCli = async (command, waitMs = 30000) => {
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
  const looksLikeStack = (text) => /\n\s+at\s+\S/.test(text) || /\bat\s+\S+\s+\(\S+:\d+:\d+\)/.test(text)
  const readJsonFile = async (path) => {
    const res = await runCli(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${path}"`)
    try {
      return JSON.parse(res.output)
    } catch {
      return null
    }
  }
  /*
   * 临时文件路径由 **node 自己算**，不依赖 shell 变量：
   * `$TEMP` 在 pi 的 bash 通道里不一定会被展开（实测直接失败），
   * 而路径里带反斜杠又很难安全拼进命令行。
   * 写到系统临时目录（而不工作区）是硬要求：探针跑在项目根下，
   * 相对路径会把 `mcp-*.json` 这类中间文件留在仓库里（首次跑就污染了工作区）。
   */
  const writeJson = async (name, value) => {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(value))))
    const res = await runCli(
      `node -e "const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(require('os').tmpdir(),'yan-mcp-probe-${name}'),Buffer.from('${b64}','base64'))"`
    )
    return res.exitCode === 0
  }

  log('=== yan mcp describe / call（宿主链路 + 真 MCP 服务，cost 0）===')

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

    const tmpDirRes = await runCli(`node -e "process.stdout.write(require('os').tmpdir())"`)
    const tmpLines = String(tmpDirRes.output)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const TMPDIR = tmpLines[tmpLines.length - 1] || '.'
    const tmpFile = (name) => `${TMPDIR}\\yan-mcp-probe-${name}`
    log(`  临时目录：${TMPDIR}`)

    /* ---- 1. describe ---- */
    log('--- 1. mcp describe ---')
    const described = await runCli('yan mcp describe --server fixture --tool add')
    const descReceipt = lastJson(described.output)
    log('  回执：' + JSON.stringify(descReceipt && descReceipt.summary))
    ok(descReceipt && descReceipt.ok === true, 'describe 成功（真连上了 fixture 服务）')
    const revision = descReceipt && descReceipt.summary && descReceipt.summary.schemaRevision
    ok(/^[0-9a-f]{8}$/.test(String(revision || '')), 'describe 给出 schemaRevision', String(revision || ''))
    const descFull = await readJsonFile(descReceipt && descReceipt.resultFile)
    ok(
      !!descFull && descFull.inputSchema && descFull.inputSchema.properties && descFull.inputSchema.properties.a,
      '结果文件里有完整 inputSchema（模型据此构造参数）'
    )

    /* ---- 2. 正常调用 ---- */
    log('--- 2. mcp call（正常）---')
    const wroteAdd = await writeJson('add.json', {
      serverId: 'fixture',
      toolName: 'add',
      arguments: { a: 2, b: 3 },
      schemaRevision: revision
    })
    ok(wroteAdd, '写好请求文件（临时目录）')
    const added = await runCli(`yan mcp call --request-file "${tmpFile('add.json')}"`)
    const addReceipt = lastJson(added.output)
    log('  回执：' + JSON.stringify(addReceipt && addReceipt.summary))
    if (!addReceipt || addReceipt.ok !== true) {
      log('  DEBUG add raw: ' + String(added.output).slice(0, 400).replace(/\s+/g, ' '))
      log('  DEBUG add path: ' + tmpFile('add.json'))
    }
    ok(addReceipt && addReceipt.ok === true, 'call 成功')
    ok(addReceipt && addReceipt.summary && addReceipt.summary.toolError === false, '正常调用 toolError:false')
    const addFull = await readJsonFile(addReceipt && addReceipt.resultFile)
    ok(!!addFull && String(addFull.text) === '5', '结果文本是 5（服务真的算出来了）')

    /* ---- 3. 工具级失败是结果，不是崩溃 ---- */
    log('--- 3. 工具级失败 ---')
    await writeJson('fail.json', { serverId: 'fixture', toolName: 'fail', arguments: {} })
    const failed = await runCli(`yan mcp call --request-file "${tmpFile('fail.json')}"`)
    const failReceipt = lastJson(failed.output)
    ok(failed.exitCode === 0 && failReceipt && failReceipt.ok === true, '工具自己失败时命令仍然「成功执行」（不是 CLI 崩溃）')
    ok(failReceipt && failReceipt.summary && failReceipt.summary.toolError === true, '回执用 toolError:true 表达工具失败')
    ok(!looksLikeStack(failed.output), '工具失败不吐堆栈')

    /* ---- 4. 可重试的两类错 ---- */
    log('--- 4. 可重试错误 ---')
    await writeJson('badargs.json', { serverId: 'fixture', toolName: 'add', arguments: { a: 2 } })
    const badArgs = await runCli(`yan mcp call --request-file "${tmpFile('badargs.json')}"`)
    const badArgsReceipt = lastJson(badArgs.output)
    ok(/invalid_arguments/.test(String(badArgsReceipt && badArgsReceipt.code)), '漏必填参数回 invalid_arguments')

    await writeJson('stale.json', {
      serverId: 'fixture',
      toolName: 'add',
      arguments: { a: 1, b: 1 },
      schemaRevision: 'deadbeef'
    })
    const stale = await runCli(`yan mcp call --request-file "${tmpFile('stale.json')}"`)
    const staleReceipt = lastJson(stale.output)
    ok(/schema-changed/.test(String(staleReceipt && staleReceipt.code)), 'revision 过期回 schema-changed（可重试）')
    ok(!looksLikeStack(stale.output), 'schema-changed 不吐堆栈')

    const noTool = await runCli('yan mcp describe --server fixture --tool nope')
    const noToolReceipt = lastJson(noTool.output)
    ok(/tool_not_found/.test(String(noToolReceipt && noToolReceipt.code)), '不存在的工具回 tool_not_found')

    /* ---- 5. 大结果落盘 ---- */
    log('--- 5. 大结果 ---')
    await writeJson('big.json', { serverId: 'fixture', toolName: 'big', arguments: { bytes: 100000 } })
    const big = await runCli(`yan mcp call --request-file "${tmpFile('big.json')}"`)
    const bigReceipt = lastJson(big.output)
    ok(
      bigReceipt && bigReceipt.summary && bigReceipt.summary.resultFile && bigReceipt.summary.bytes >= 100000,
      '大结果落盘且回执里给出 resultFile 与字节数',
      String(bigReceipt && bigReceipt.summary && bigReceipt.summary.bytes)
    )

    /* ---- 6. 未登记的服务要可读 ---- */
    const unknown = await runCli('yan mcp describe --server nope --tool add')
    const unknownReceipt = lastJson(unknown.output)
    ok(/mcp_unavailable/.test(String(unknownReceipt && unknownReceipt.code)), '未登记的服务回 mcp_unavailable')
    ok(!looksLikeStack(unknown.output), '未登记服务不吐堆栈')
  } catch (error) {
    log('探针异常：' + String((error && error.stack) || error))
    ok(false, '探针本身没抛异常')
  }

  return out.join('\n')
})()
