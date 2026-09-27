import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 联网搜索的单元测试（实施-27 S1/S2）—— 纯逻辑 + 替身后端，不装 OpenCLI。
 *
 * 主要钉住三件事：
 *   ① 来源级状态：`empty` 与 `unavailable` / `timeout` / `error` 必须分得开；
 *   ② 合并规则：跨来源去重、每来源上限、总数上限与截断标记；
 *   3  后端调用的边界：找不到可执行文件 → unavailable；错误码可从 YAML 里抠出来。
 */

export async function runSearchTests(ok, mod) {
  const {
    SEARCH_SOURCES,
    SEARCH_LIMIT_PER_SOURCE_MAX,
    normalizeQuery,
    normalizeRow,
    normalizeUrlForDedupe,
    aggregate,
    decodeEntities,
    cleanText,
    summarizeSources,
    runSearch,
    parseBackendError,
    createOpencliRunner,
    searchSummary,
    resolveJsRuntime,
    resolveBackendTarget,
    searchDoctor,
    findNodeOnPath
  } = mod

  const T0 = 1_000_000

  /* ---- 契约：来源白名单 ---- */
  {
    ok(SEARCH_SOURCES.length === 3, '首批三个来源')
    ok(SEARCH_SOURCES.every((s) => !s.needsBrowser), '首批来源都不需要浏览器扩展（HTTP 直连）')
    ok(new Set(SEARCH_SOURCES.map((s) => s.id)).size === 3, '来源 id 不重复')
  }

  /* ---- 查询解析 ---- */
  {
    ok(normalizeQuery({ text: '   ' }).code === 'empty_query', '空查询被拒（不是发出去等空结果）')
    const q = normalizeQuery({ text: '  flash attention  ' })
    ok(q.ok && q.text === 'flash attention', '查询词去首尾空白')
    ok(q.sources.length === 3, '不指定来源时查全部三个')
    const only = normalizeQuery({ text: 'x', sources: ['arxiv'] })
    ok(only.ok && only.sources.length === 1 && only.sources[0].id === 'arxiv', '只查指定来源')
    const bogus = normalizeQuery({ text: 'x', sources: ['arxiv', 'nope', 'arxiv'] })
    ok(bogus.ok && bogus.sources.length === 1, '未知来源丢掉、重复来源去掉')
    ok(bogus.ok && bogus.ignoredSources.join(',') === 'nope', '被丢掉的来源名原样带回（不能静默）')
    ok(normalizeQuery({ text: 'x', sources: ['nope'] }).code === 'no_source', '全是未知来源 → no_source')
    const allUnknown = normalizeQuery({ text: 'x', sources: ['nope'] })
    ok(allUnknown.ignoredSources.join(',') === 'nope', '失败路径也点名被忽略的来源')
    const dupUnknown = normalizeQuery({ text: 'x', sources: ['nope', 'nope'] })
    ok(dupUnknown.ignoredSources.length === 1, '重复的未知来源只报一次')
    ok(normalizeQuery({ text: 'x' }).ignoredSources.length === 0, '没写来源时没有「被忽略」的东西')
    const clamped = normalizeQuery({ text: 'x', limitPerSource: 999, limitTotal: 0, timeoutMs: 10 })
    ok(clamped.ok && clamped.limitPerSource === SEARCH_LIMIT_PER_SOURCE_MAX, '每来源条数被夹到上限')
    ok(clamped.ok && clamped.limitTotal === 1, '总条数至少 1')
    ok(clamped.ok && clamped.timeoutMs === 1000, '超时至少 1s')
  }

  /* ---- 文本清洗 ---- */
  {
    ok(decodeEntities('&quot;砚&quot; &amp; &#65;') === '"砚" & A', 'HTML 实体解码（含数字实体）')
    ok(decodeEntities('&#39;quoted&#39;') === "'quoted'", '数字实体 &#39; 仍能解码（实体表里删掉它不影响）')
    ok(cleanText('  a\n\n b  ') === 'a b', '压平空白')
    ok(cleanText('x'.repeat(400)).length === 280, '超长摘要截断到上限')
    ok(cleanText('x'.repeat(400)).endsWith('…'), '截断有明确标记')
    ok(cleanText('   ') === undefined, '全空白 → undefined（不产出空摘要）')
    ok(cleanText(42) === undefined, '非字符串 → undefined')
  }

  /* ---- URL 判重 ---- */
  {
    const a = normalizeUrlForDedupe('https://Example.com/a/?utm_source=x&b=1#frag')
    const b = normalizeUrlForDedupe('https://example.com/a?b=1')
    ok(a === b, '大小写 host / 跟踪参数 / hash / 尾斜杠都归一')
    ok(normalizeUrlForDedupe('not a url') === 'not a url', '非 URL 原样返回（不抛）')
  }

  /* ---- 行归一化 ---- */
  {
    const w = normalizeRow('wikipedia', { title: 'Inkstone', snippet: 'a &quot;stone&quot;', url: 'https://en.wikipedia.org/wiki/Inkstone' })
    ok(w && w.title === 'Inkstone' && w.snippet === 'a "stone"', 'wikipedia 三字段映射')
    const ar = normalizeRow('arxiv', { title: 'Flash', published: '2025-12-07', authors: 'A, B', primary_category: 'cs.LG', url: 'https://arxiv.org/abs/1' })
    ok(ar && ar.published === '2025-12-07', 'arxiv 带 published')
    ok(ar && ar.meta.authors === 'A, B' && ar.meta.category === 'cs.LG', 'arxiv 其余字段进 meta')
    const hn = normalizeRow('hackernews', { id: 123, title: 'Ask HN', score: 42, comments: 7, author: 'bob' })
    ok(hn && hn.url === 'https://news.ycombinator.com/item?id=123', 'hackernews 用 id 拼链接')
    ok(hn && hn.meta.score === 42, 'hackernews score 进 meta')
    ok(normalizeRow('hackernews', { title: 'no id' }) === null, '缺 id 丢一条（不给死链）')
    ok(normalizeRow('wikipedia', { title: '', url: 'x' }) === null, '空标题丢一条')
    ok(normalizeRow('arxiv', null) === null, 'null 行丢一条')
  }

  /* ---- 合并：状态必须分得开 ---- */
  {
    const runs = [
      { source: 'wikipedia', rows: [{ title: 'W1', url: 'https://w/1' }], elapsedMs: 10 },
      { source: 'arxiv', rows: [], elapsedMs: 20 },
      { source: 'hackernews', rows: null, error: { code: 'BROWSER_CONNECT', message: '扩展没连' }, elapsedMs: 30 }
    ]
    const out = aggregate(runs, { limitPerSource: 6, limitTotal: 12 })
    ok(out.sources.length === 3, '三个来源三条状态')
    ok(out.sources[0].status === 'ok' && out.sources[0].count === 1, '有结果的来源 = ok')
    ok(out.sources[1].status === 'empty', '返回空数组 = empty（不是 error）')
    ok(out.sources[2].status === 'error' && out.sources[2].code === 'BROWSER_CONNECT', '后端报错 = error + 错误码')
    ok(out.items.length === 1, '只有成功来源的条目进结果')

    const to = aggregate([{ source: 'arxiv', rows: null, timedOut: true, elapsedMs: 5 }], { limitPerSource: 6, limitTotal: 12 })
    ok(to.sources[0].status === 'timeout', '超时 = timeout（与 empty / error 都不同）')
    const un = aggregate([{ source: 'arxiv', rows: null, unavailable: true, elapsedMs: 5 }], { limitPerSource: 6, limitTotal: 12 })
    ok(un.sources[0].status === 'unavailable', '后端不可用 = unavailable')
    ok(un.sources[0].code === 'backend_unavailable', '不可用带明确错误码')
  }

  /* ---- 合并：去重与上限 ---- */
  {
    const dup = aggregate(
      [
        { source: 'wikipedia', rows: [{ title: 'A', url: 'https://x/a?utm_source=q' }], elapsedMs: 1 },
        { source: 'arxiv', rows: [{ title: 'A again', url: 'https://x/a' }], elapsedMs: 1 }
      ],
      { limitPerSource: 6, limitTotal: 12 }
    )
    ok(dup.items.length === 1, '跨来源按 URL 去重（先到先得）')
    ok(dup.items[0].title === 'A', '保留先出现的那个')

    const many = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `https://x/${i}` }))
    const perSource = aggregate([{ source: 'arxiv', rows: many, elapsedMs: 1 }], { limitPerSource: 3, limitTotal: 12 })
    ok(perSource.items.length === 3, '每来源条数上限生效')
    ok(perSource.truncated === true, '被每来源上限裁过 → truncated')

    /* 两个来源用不同 URL：否则跨来源去重会把第二个来源的行全吃掉（那测的是去重，不是上限） */
    const manyA = Array.from({ length: 10 }, (_, i) => ({ title: `a${i}`, url: `https://a/${i}` }))
    const manyB = Array.from({ length: 10 }, (_, i) => ({ title: `b${i}`, url: `https://b/${i}` }))
    const totalCap = aggregate(
      [
        { source: 'wikipedia', rows: manyA, elapsedMs: 1 },
        { source: 'arxiv', rows: manyB, elapsedMs: 1 }
      ],
      { limitPerSource: 10, limitTotal: 5 }
    )
    ok(totalCap.items.length === 5, '总数上限生效')
    ok(totalCap.truncated === true, '被总数上限裁过 → truncated')
    /* 被总数上限挤掉的来源不能被写成「没有结果」（否则 count 0 会被读成 empty） */
    ok(totalCap.sources[0].droppedByLimit === 5, '吃满份额后被上限截断：标出剩余未处理条数')
    ok(
      totalCap.sources[1].droppedByLimit === 10 && totalCap.sources[1].count === 0,
      '后面被挡在门外的来源：count 0 但带回 droppedByLimit'
    )
    ok(
      totalCap.sources[1].status === 'ok',
      '它仍是 ok（有结果，只是没收进来）—— 不是 empty'
    )
    ok(/被总数上限截断/.test(summarizeSources(totalCap.sources)), '摘要里说清是被上限截断，而不是干脏的「0 条」')
    /* 不会被总数上限碰到的来源不应带这个字段 */
    ok(perSource.sources[0].droppedByLimit === undefined, '没被总数上限碰到的来源不标 droppedByLimit')

    const noElapsed = aggregate([{ source: 'arxiv', rows: [{ title: 'x', url: 'https://x/1' }] }], {
      limitPerSource: 6,
      limitTotal: 12
    })
    ok(Number.isFinite(noElapsed.sources[0].elapsedMs), 'runner 没给 elapsedMs 时不写 NaN（JSON 里会变 null）')

    const dirty = aggregate(
      [{ source: 'wikipedia', rows: [{ title: 'ok', url: 'https://x/1' }, { nope: true }], elapsedMs: 1 }],
      { limitPerSource: 6, limitTotal: 12 }
    )
    ok(dirty.sources[0].status === 'ok', '脏行不算来源失败')
    ok(/跳过/.test(dirty.sources[0].message ?? '') , '脏行数如实写进状态说明')
  }

  /* ---- 错误解析 ---- */
  {
    const e = parseBackendError('ok: false\nerror:\n  code: BROWSER_CONNECT\n  message: Browser Bridge extension not connected\n')
    ok(e.code === 'BROWSER_CONNECT', '从 YAML 里抠出 code')
    ok(/extension/.test(e.message ?? ''), '抠出 message')
    ok(parseBackendError('纯文本错误').message === '纯文本错误', '抠不出来就原样给文本（不吞）')
  }

  /* ---- runSearch：并发、顺序、摘要 ---- */
  {
    const calls = []
    const deps = {
      now: () => T0,
      runner: async (source, query, opts) => {
        calls.push({ id: source.id, query, limit: opts.limit })
        if (source.id === 'hackernews') return { source: 'hackernews', rows: null, timedOut: true, elapsedMs: 3 }
        return { source: source.id, rows: [{ title: source.id, url: `https://${source.id}/1` }], elapsedMs: 1 }
      }
    }
    const out = await runSearch({ text: 'a "quoted" ; query' }, deps)
    ok(calls.length === 3, '三个来源都发起了调用')
    ok(calls.every((c) => c.query === 'a "quoted" ; query'), '查询词原样传给后端（不经过 shell 解释）')
    ok(out.sources.map((s) => s.source).join(',') === 'wikipedia,arxiv,hackernews', '来源顺序 = 注册顺序（不按返回快慢）')
    ok(out.items.length === 2, '两条成功结果')
    ok(/hackernews 超时/.test(searchSummary(out)), '摘要里如实写超时')
    ok(searchSummary(out).includes('2 条结果'), '摘要先给条数')

    const onlyArxiv = await runSearch({ text: 'x', sources: ['arxiv'] }, deps)
    ok(calls.length === 4, '只查指定来源时只发一次调用')
    ok(onlyArxiv.sources.length === 1, '只汇报被查的来源')

    const empty = await runSearch({ text: '  ' }, deps)
    ok(empty.items.length === 0 && empty.sources.length === 0, '空查询不发调用、不编状态')

    const withIgnored = await runSearch({ text: 'x', sources: ['arxiv', 'nope'] }, deps)
    ok(withIgnored.ignoredSources?.join(',') === 'nope', 'runSearch 把被忽略的来源带进结果')
    ok(/已忽略未知来源：nope/.test(searchSummary(withIgnored)), '摘要里点名被忽略的来源')
    const errIgnored = await runSearch({ text: 'x', sources: ['nope'] }, deps)
    ok(
      errIgnored.error?.code === 'no_source' && errIgnored.ignoredSources?.join(',') === 'nope',
      '查询根本没发出去时也带上被忽略的来源'
    )
  }

  /* ---- 真实 spawn 的两个边界（不依赖 opencli 存在） ---- */
  {
    const missing = await createOpencliRunner('yan-opencli-does-not-exist')(SEARCH_SOURCES[0], 'q', {
      limit: 2,
      timeoutMs: 3000
    })
    ok(missing.unavailable === true, '可执行文件不存在 → unavailable')
    ok(missing.error.code === 'backend_unavailable', '错误码是 backend_unavailable')
    ok(/找不到/.test(missing.error.message ?? ''), '错误信息能读懂（说的是找不到后端）')
    ok(!/ENOENT/i.test(missing.error.message ?? ''), 'ENOENT 不再原样丢出来（归一到可读文案）')
    ok(/yan-opencli-does-not-exist/.test(missing.error.message ?? ''), '文案里带上是哪个命令找不到')

    /* 用系统的 node 当「后端」：它拿不到合法 JSON，会走 bad_output 分支（同样是可区分状态） */
    const bad = await createOpencliRunner('node')(SEARCH_SOURCES[0], 'q', { limit: 1, timeoutMs: 8000 })
    ok(bad.rows === null && !!bad.error, '输出不是 JSON 数组 → 不当作空结果')
    ok(bad.error.code !== 'timeout', '不是超时就不要写成超时')
  }

  /* ---- 运行环境：Electron 下必须换成真实 node（回归） ---- */
  {
    /*
     * 背景：OpenCLI 用 commander 解析参数，而 commander 一看到
     * `process.versions.electron` 就改按 Electron 语义切参数；在
     * ELECTRON_RUN_AS_NODE 下 `argv[1]` 是入口脚本路径，于是子命令全部错位
     * （`error: unknown command '…/main.js'`）—— 而 `--version` 走 OpenCLI
     * 自己的快路径照样成功，doctor 会假绿。这两块都钉在这里。
     */
    const inElectronFound = resolveJsRuntime(() => 'C:\\nodejs\\node.exe', 'C:\\electron\\electron.exe', true)
    ok(inElectronFound.file === 'C:\\nodejs\\node.exe', 'Electron 下跑 JS 入口改用 PATH 里的真实 node')
    ok(!inElectronFound.error, '找到真实 node 时不报错')

    const inElectronMissing = resolveJsRuntime(() => null, 'C:\\electron\\electron.exe', true)
    ok(!!inElectronMissing.error, 'Electron 下找不到真实 node → 如实报错（不拿 Electron 硬跑）')
    ok(/commander|参数/.test(inElectronMissing.error ?? ''), '错误说明能指出 commander / 参数解析这个真实原因')
    ok(!/YAN_OPENCLI_JS/.test(inElectronMissing.error ?? ''), '不再把 YAN_OPENCLI_JS 说成能指定 node（它指的是 OpenCLI 入口）')

    /* 显式指定 node：GUI 启动的 PATH 常常没有 node 时的唯一出路 */
    const viaNodeBin = resolveJsRuntime(() => null, 'C:\\electron\\electron.exe', true, process.execPath)
    ok(viaNodeBin.file === process.execPath && !viaNodeBin.error, 'YAN_NODE_BIN 指定存在文件时优先用它')
    const badNodeBin = resolveJsRuntime(
      () => 'C:\\nodejs\\node.exe',
      'C:\\electron\\electron.exe',
      true,
      'C:\\definitely-missing\\node.exe'
    )
    ok(!!badNodeBin.error && /YAN_NODE_BIN/.test(badNodeBin.error), 'YAN_NODE_BIN 指向不存在的文件 → 如实报错')
    const nodeBinOnlyWhenElectron = resolveJsRuntime(() => null, '/usr/bin/node', false, 'C:\\definitely-missing\\node.exe')
    ok(nodeBinOnlyWhenElectron.file === '/usr/bin/node', '非 Electron 运行时不受 YAN_NODE_BIN 影响')

    const plain = resolveJsRuntime(() => null, '/usr/bin/node', false)
    ok(plain.file === '/usr/bin/node' && !plain.error, '非 Electron 运行时直接用自身 Node')

    const targetFound = resolveBackendTarget('C:\\some\\main.js', inElectronFound)
    ok(targetFound.file === 'C:\\nodejs\\node.exe', '显式 YAN_OPENCLI_JS 指向 .js 时也用真实 node 跑')
    ok(targetFound.prefix[0] === 'C:\\some\\main.js' && !targetFound.error, '入口路径仍在参数数组里（不过 shell）')
    const targetBlocked = resolveBackendTarget('C:\\some\\main.js', inElectronMissing)
    ok(!!targetBlocked.error, '没有真实 node 时把不可用原因写进 target.error')

    const healthy = await searchDoctor({
      runner: async (args) =>
        args[0] === '--version'
          ? { code: 0, stdout: '1.8.8\n', stderr: '' }
          : { code: 0, stdout: 'opencli v1.8.8 doctor (node v24)\n[OK] Daemon: running\n', stderr: '' }
    })
    ok(healthy.available === true && healthy.version === '1.8.8', '--version 与 doctor 都正常 → available')
    ok(healthy.sources.every((s) => s.ready === true), '后端可用 → 来源 ready')

    const fakeGreen = await searchDoctor({
      runner: async (args) =>
        args[0] === '--version'
          ? { code: 0, stdout: '1.8.8\n', stderr: '' }
          : { code: 2, stdout: "error: unknown command 'C:\\…\\main.js'\nUsage: opencli [options] [command]\n", stderr: '' }
    })
    ok(fakeGreen.available === false, '--version 成功但 doctor 跑不起来 → 不再报「已就绪」（假绿回归）')
    ok(fakeGreen.code === 'backend_unusable', '假绿时的错误码是 backend_unusable')
    ok(/unknown command/.test(fakeGreen.detail), '原始输出原样留在 detail 里（便于排查）')
    ok(fakeGreen.sources.every((s) => s.ready === false), '后端不可用 → 来源不再报 ready（口径一致）')

    /*
     * 超时也是假绿：doctor 已经打出头部但没跑完（daemon / 浏览器卡住）。
     * 只凭「有输出」判不了「跑完了没」，所以探针必须把 timedOut 带回来。
     */
    const timedOut = await searchDoctor({
      runner: async (args) =>
        args[0] === '--version'
          ? { code: 0, stdout: '1.8.8\n', stderr: '' }
          : { code: -1, stdout: 'opencli v1.8.8 doctor (node v24.19.0)\n', stderr: '', timedOut: true }
    })
    ok(timedOut.available === false, 'doctor 探针超时（哪怕已打出头部）→ 不报「已就绪」')
    ok(timedOut.code === 'backend_unusable', '超时也归入 backend_unusable')
    ok(/超时/.test(timedOut.detail), 'detail 里写明是超时，而不是含糊的「跑不起来」')

    /* --version 自己超时也要与「没装」分开：否则会误报「未检测到」 */
    const versionTimeout = await searchDoctor({
      runner: async (args) =>
        args[0] === '--version'
          ? { code: -1, stdout: '', stderr: '', timedOut: true }
          : { code: 0, stdout: 'opencli v1.8.8 doctor\n[OK] Daemon: running\n', stderr: '' }
    })
    ok(versionTimeout.available === false, '--version 探针超时 → 不报可用')
    ok(/超时/.test(versionTimeout.detail), '--version 超时也说清是超时（不是「未安装」）')

    /* YAN_NODE_BIN 填成 Electron → 提前拦下（否则正好踩回 commander 的 electron 分支） */
    const binDir = mkdtempSync(join(tmpdir(), 'yan-nodebin-'))
    const fakeElectron = join(binDir, 'electron.exe')
    writeFileSync(fakeElectron, 'not-really-electron')
    const electronAsNode = resolveJsRuntime(() => null, 'C:\\electron\\electron.exe', true, fakeElectron)
    ok(!!electronAsNode.error && /Electron/.test(electronAsNode.error), 'YAN_NODE_BIN 指向 Electron → 如实拦下')

    /* 未安装时的 detail 必须是可读中文：设置页现在会直接把它展示出来 */
    const savedPath = process.env.PATH
    try {
      process.env.PATH = ''
      const noBackend = await searchDoctor()
      ok(noBackend.available === false, 'PATH 里没有 opencli → 不可用')
      ok(/找不到/.test(noBackend.detail) && !/ENOENT/i.test(noBackend.detail), '未安装时的 detail 是可读中文，不是 ENOENT')
    } finally {
      process.env.PATH = savedPath
    }
  }

  /* ---- 找 node 的过滤规则（注入 dirs / probe，离线可测） ---- */
  {
    const shim = join('/fake/shim')
    const real = join('/fake/real')
    const files = {
      [join(shim, 'node.cmd')]: { isFile: true, size: 40 },
      [join(shim, 'node.exe')]: { isFile: true, size: 0 },
      [join(real, 'node.exe')]: { isFile: true, size: 80_000_000 }
    }
    const probe = (p) => files[p] ?? { isFile: false, size: -1 }
    ok(findNodeOnPath([shim], probe, 'win32') === null, 'Windows 上 .cmd shim 与 0 字节 node.exe 都不选')
    ok(findNodeOnPath([shim, real], probe, 'win32') === join(real, 'node.exe'), '跳过坏候选，选到后面的正常 node.exe')
    ok(findNodeOnPath([shim, real], probe, 'linux') === null, '非 Windows 不把 node.exe 当候选')
    const dirProbe = () => ({ isFile: false, size: 0 })
    ok(findNodeOnPath([shim], dirProbe, 'win32') === null, '目录不算可执行文件')
  }
}
