/**
 * `yan capabilities search` / `yan skill read` 的**宿主链路**（实施-04 S2）—— 不调模型。
 *
 * ── 与 `capsearch`（cost 1）的分工 ──
 *   `capsearch` 验的是「模型会不会自己走发现链」；实测它读完技能正文靠的是 pi 原生
 *   `read` 工具（system prompt 里就给了 SKILL.md 的绝对路径），**不会**主动去敲
 *   `yan skill read`。这是官方设计，不是缺陷 —— 但那样就没人验 `yan skill read` 本身了。
 *   所以这里直连宿主：真 CLI → 真 `CapabilityServer` → 真技能文件，确定性地验
 *   发现 / 读取 / 内容 hash / 错误可分支四条。
 *
 * ── 为什么能 cost 0 ──
 *   砚有一条不经模型的直执行通道（`window.yan.runBash` → pi 的 `bash` RPC），
 *   它继承 pi 子进程的环境：PATH 前置了 `yan` 启动器、`YAN_CLI_*` 身份也在里面。
 *
 * 依赖：专属 piDir（含 `yan-capability-probe` 技能），见 test-live.mjs 的 sandbox 准备区。
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

  const runCli = async (command, waitMs = 20000) => {
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
  /** 渲染端拿不到任意文件读，直执行 shell 可以。 */
  const readJsonFile = async (path) => {
    const res = await runCli(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${path}"`)
    try {
      return JSON.parse(res.output)
    } catch {
      return null
    }
  }
  /**
   * 临时请求文件必须写进**系统临时目录**，不能写当前工作目录。
   *
   * 探针跑在项目根下：相对路径会把 `cap-*.json` 这类中间文件留在仓库里
   * （实测已经把 `cap-query.json` / `cap-scope.json` 提交进工作区）。
   * 路径由 node 自己算：`$TEMP` 在 pi 的 bash 通道里不一定展开。
   * （与 `mcp-cli.js` 同一处置，先修正的那次注释在那边。）
   */
  const writeJson = async (name, value) => {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(value))))
    const res = await runCli(
      `node -e "const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(require('os').tmpdir(),'yan-cap-probe-${name}'),Buffer.from('${b64}','base64'))"`
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
  const tmpFile = (name) => `${TMPDIR}\\yan-cap-probe-${name}`
  log(`  临时目录：${TMPDIR}`)

  log('=== yan capabilities search / yan skill read（宿主链路，cost 0）===')

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

    const SKILL_ID = 'skill:yan-capability-probe'
    const MARK = 'YAN-CAPABILITY-PROBE-OK 7f3a91'

    /* ---- 1. 发现：按目标检索到技能 ---- */
    log('--- 1. capabilities search ---')
    const wrote = await writeJson('cap-query.json', { queryText: '能力探测回执', limit: 10 })
    ok(wrote, '写好查询文件')
    const search = await runCli(`yan capabilities search --query-file "${tmpFile('cap-query.json')}"`)
    const searchReceipt = lastJson(search.output)
    log('  回执：' + JSON.stringify(searchReceipt && searchReceipt.summary))
    ok(searchReceipt && searchReceipt.ok === true, 'capabilities search 成功（exit 0）')
    const ids = (searchReceipt && searchReceipt.summary && searchReceipt.summary.ids) || []
    ok(ids.includes(SKILL_ID), '检索结果里包含已加载技能', JSON.stringify(ids))
    ok(ids.some((id) => String(id).startsWith('builtin:')), '检索结果里也包含内置能力（目录是两者的合并）')

    const searchFull = await readJsonFile(searchReceipt && searchReceipt.resultFile)
    const hit = searchFull && (searchFull.hits || []).find((h) => h.id === SKILL_ID)
    ok(!!hit, '完整结果文件里有这条命中（stdout 只是摘要）')
    if (hit) {
      ok(hit.kind === 'skill', 'kind 是 skill', String(hit.kind))
      ok(hit.availability === 'ready', 'availability 是真实可用性 ready', String(hit.availability))
      ok(hit.owner === 'user', '来源由宿主赋予（owner=user）', String(hit.owner))
      ok(hit.effect === 'read', '技能是只读材料，不是可调用 API', String(hit.effect))
      ok(/SKILL\.md$/i.test(String(hit.location)), '给出了 SKILL.md 的绝对路径', String(hit.location))
    }

    /* ---- 2. 读取：按需拿正文 + 内容 hash ---- */
    log('--- 2. skill read ---')
    const read = await runCli(`yan skill read --id ${SKILL_ID}`)
    const readReceipt = lastJson(read.output)
    log('  回执：' + JSON.stringify(readReceipt && readReceipt.summary))
    ok(readReceipt && readReceipt.ok === true, 'skill read 成功（exit 0）')
    const hash = readReceipt && readReceipt.summary && readReceipt.summary.contentHash
    ok(/^[0-9a-f]{64}$/.test(String(hash || '')), '回执带 sha256 内容 hash', String(hash || '').slice(0, 12))
    const readFull = await readJsonFile(readReceipt && readReceipt.resultFile)
    ok(!!readFull && String(readFull.body || '').includes(MARK), '正文真的读到了（含技能里独有的标记）')
    ok(
      !!readFull && !/^\s*---/.test(String(readFull.body || '')),
      '正文已去 frontmatter'
    )

    /* ---- 3. 错误要可读、可分支，不许变成堆栈 ---- */
    log('--- 3. 错误路径 ---')
    const missing = await runCli('yan skill read --id skill:does-not-exist')
    const missingReceipt = lastJson(missing.output)
    ok(missing.exitCode !== 0, '不存在的技能：非零退出')
    ok(missingReceipt && missingReceipt.ok === false, '回执 ok:false')
    ok(/skill_unavailable/.test(String(missingReceipt && missingReceipt.code)), '带可分支的错误码 skill_unavailable')
    ok(!looksLikeStack(missing.output), '不吐 Node 堆栈')

    await writeJson('cap-scope.json', { queryText: '回执', scope: 'browse' })
    const badScope = await runCli(`yan capabilities search --query-file "${tmpFile('cap-scope.json')}"`)
    const badScopeReceipt = lastJson(badScope.output)
    ok(/capability_scope_unsupported/.test(String(badScopeReceipt && badScopeReceipt.code)), '不支持的 scope 有专属错误码')

    /*
     * 这一条原来验的是「S2 时期 discover 还没实现，必须回 not_implemented」。
     * 实施-04 S5 落地后 `capabilities discover` **真的实现了**（联网检索的行为由
     * `discnet` 场景覆盖），旧的“必须 not_implemented”已经变成**假要求** ——
     * 继续留着它只会把“功能已经做出来”当成失败。
     *
     * 换成同一意图（**不许静默成功**、错误要可分支）的另一条本地校验：
     * `capabilities prepare` 缺 `--candidate` 时必须回 `candidate_required`。
     */
    const noCandidate = await runCli('yan capabilities prepare')
    const noCandidateReceipt = lastJson(noCandidate.output)
    ok(noCandidate.exitCode !== 0, 'prepare 缺 --candidate：非零退出')
    ok(
      noCandidateReceipt &&
        noCandidateReceipt.ok === false &&
        /candidate/.test(String(noCandidateReceipt.error ?? noCandidateReceipt.code ?? '')),
      'prepare 缺 --candidate 明确报错（参数层直接拒，不静默成功）',
      JSON.stringify(noCandidateReceipt?.error ?? noCandidateReceipt?.code ?? '(空)')
    )

    /*
     * 实施-04 S6a：`capabilities acquire` 已接通（不再是 not_implemented）。
     * 缺 `--plan` → 参数层报错；给一个不存在的计划 → 如实报未知计划。
     * 两条都只走参数 / 缓存校验：**不联网、不装包**（下载器是 S6b）。
     */
    const noPlan = await runCli('yan capabilities acquire')
    const noPlanReceipt = lastJson(noPlan.output)
    ok(noPlan.exitCode !== 0, 'acquire 缺 --plan：非零退出')
    ok(
      noPlanReceipt &&
        noPlanReceipt.ok === false &&
        /plan/.test(String(noPlanReceipt.error ?? noPlanReceipt.code ?? '')),
      'acquire 缺 --plan 明确报错（参数层直接拒，不静默成功）',
      JSON.stringify(noPlanReceipt?.error ?? noPlanReceipt?.code ?? '(空)')
    )
    const ghostPlan = await runCli('yan capabilities acquire --plan 000000000000000000000000')
    const ghostReceipt = lastJson(ghostPlan.output)
    ok(ghostPlan.exitCode !== 0, 'acquire 给不存在的计划：非零退出')
    ok(
      ghostReceipt &&
        ghostReceipt.ok === false &&
        !/not_implemented/.test(JSON.stringify(ghostReceipt)) &&
        (/plan_unknown/.test(String(ghostReceipt.code ?? '')) || /计划/.test(String(ghostReceipt.error ?? ''))),
      'acquire 已接通（不再是 not_implemented），未知计划如实报错',
      JSON.stringify(ghostReceipt?.error ?? ghostReceipt?.code ?? '(空)')
    )

    const typo = await runCli('yan capabilities frobnicate')
    ok(typo.exitCode === 2, '打错的子命令走用法退出码 2', String(typo.exitCode))
    ok(/未知的 capabilities 子命令/.test(typo.output), '给中文可读提示')
    ok(!looksLikeStack(typo.output), '打错子命令不吐堆栈')
  } catch (error) {
    log('探针异常：' + String((error && error.stack) || error))
    ok(false, '探针本身没抛异常')
  }

  return out.join('\n')
})()
