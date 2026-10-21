import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  {
    ok(SEARCH_SOURCES.map(s => s.id).join(',') === 'wikipedia,arxiv,hackernews,brave,tavily,deepseek,bing,ddg,so360', '登记原有三个来源与六个网页来源')
    ok(SEARCH_SOURCES.every((s) => !s.needsBrowser), '已登记来源均不需要浏览器扩展')
    ok(new Set(SEARCH_SOURCES.map((s) => s.id)).size === SEARCH_SOURCES.length, '来源 id 不重复')
  }

  {
    ok(normalizeQuery({ text: '   ' }).code === 'empty_query', '空查询被拒（不是发出去等空结果）')
    const q = normalizeQuery({ text: '  flash attention  ' })
    ok(q.ok && q.text === 'flash attention', '查询词去首尾空白')
    ok(q.sources.map(s => s.id).join(',') === 'wikipedia,arxiv,hackernews', '不指定来源时保留默认三个来源')
    const web = normalizeQuery({ text: 'x', sources: ['brave', 'bing', 'ddg', 'so360'] })
    ok(web.ok && web.sources.map(s => s.id).join(',') === 'brave,bing,ddg,so360', '四个网页来源可显式选择且保持请求顺序')
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

  {
    ok(decodeEntities('&quot;砚&quot; &amp; &#65;') === '"砚" & A', 'HTML 实体解码（含数字实体）')
    ok(decodeEntities('&#39;quoted&#39;') === "'quoted'", '数字实体 &#39; 仍能解码（实体表里删掉它不影响）')
    ok(cleanText('  a\n\n b  ') === 'a b', '压平空白')
    ok(cleanText('x'.repeat(400)).length === 280, '超长摘要截断到上限')
    ok(cleanText('x'.repeat(400)).endsWith('…'), '截断有明确标记')
    ok(cleanText('   ') === undefined, '全空白 → undefined（不产出空摘要）')
    ok(cleanText(42) === undefined, '非字符串 → undefined')
  }

  {
    const a = normalizeUrlForDedupe('https://Example.com/a/?utm_source=x&b=1#frag')
    const b = normalizeUrlForDedupe('https://example.com/a?b=1')
    ok(a === b, '大小写 host / 跟踪参数 / hash / 尾斜杠都归一')
    ok(normalizeUrlForDedupe('not a url') === 'not a url', '非 URL 原样返回（不抛）')
  }

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
    ok(totalCap.items.map((i) => i.title).join(',') === 'a0,b0,a1,b1,a2', '各来源按排名交错合并，不再让前一个来源占满名额')
    ok(totalCap.sources[0].count === 3 && totalCap.sources[0].droppedByLimit === 7, '被总数上限截掉的条数按来源标出')
    ok(totalCap.sources[1].count === 2 && totalCap.sources[1].droppedByLimit === 8, '后面的来源也能进结果')
    ok(totalCap.sources[1].status === 'ok', '被截过的来源仍是 ok —— 不是 empty')

    const crowdA = Array.from({ length: 6 }, (_, i) => ({ title: `x${i}`, url: `https://x/${i}` }))
    const crowdB = [{ title: 'only b', url: 'https://b/only' }, { title: 'x3 from b', url: 'https://x/3', snippet: 'b 的摘要' }]
    const fused = aggregate(
      [
        { source: 'tavily', rows: crowdA, elapsedMs: 1 },
        { source: 'bing', rows: crowdB, elapsedMs: 1 }
      ],
      { limitPerSource: 6, limitTotal: 12 }
    )
    ok(fused.items[0].url === 'https://x/3', '两个来源都搜到的网址排到最前')
    ok(fused.items[0].title === 'x3' && fused.items[0].snippet === 'b 的摘要', '保留靠前来源的标题，缺摘要时用另一个来源补上')
    ok(fused.items.length === 7 && fused.sources[1].count === 1, '重复网址只算一次，计在靠前的来源名下')
    const sameSourceDup = aggregate(
      [{ source: 'bing', rows: [{ title: 'a', url: 'https://a/1' }, { title: 'a dup', url: 'https://a/1#x' }], elapsedMs: 1 }],
      { limitPerSource: 6, limitTotal: 12 }
    )
    ok(sameSourceDup.items.length === 1 && sameSourceDup.sources[0].count === 1, '同一来源内的重复网址去掉')
    const withContent = aggregate(
      [{ source: 'deepseek', rows: [{ title: 'c', url: 'https://c/1', content: '正文\r\n\r\n\r\n第二段' + '字'.repeat(4000) }], elapsedMs: 1 }],
      { limitPerSource: 6, limitTotal: 12 }
    )
    ok(withContent.items[0].content.startsWith('正文\n\n第二段') && withContent.items[0].content.length === 3000, '正文保留段落、压掉多余空行，截到 3000 字')
    const siteRows = [
      { title: 'junk1', url: 'https://outlook.com/a' },
      { title: 'gh1', url: 'https://github.com/a' },
      { title: 'junk2', url: 'https://myGov.au/b' },
      { title: 'gh2', url: 'https://gist.github.com/b' }
    ]
    const siteOut = aggregate([{ source: 'bing', rows: siteRows, elapsedMs: 1 }], { limitPerSource: 6, limitTotal: 12, sites: ['github.com'] })
    ok(siteOut.items.map((i) => i.title).join(',') === 'gh1,gh2', '限定站点时去掉站外结果（含子域名的保留）')
    ok(/2 条不在指定站点/.test(siteOut.sources[0].message ?? ''), '去掉了几条写进来源状态')
    const allOff = aggregate([{ source: 'bing', rows: siteRows.filter((r) => r.title.startsWith('junk')), elapsedMs: 1 }], { limitPerSource: 6, limitTotal: 12, sites: ['github.com'] })
    ok(allOff.sources[0].status === 'empty' && allOff.items.length === 0, '全是站外结果 → empty，不把垃圾交给模型')
    const longSite = aggregate([{ source: 'bing', rows: [...siteRows, ...Array.from({ length: 8 }, (_, i) => ({ title: `g${i}`, url: `https://github.com/x${i}` }))], elapsedMs: 1 }], { limitPerSource: 6, limitTotal: 12, sites: ['github.com'] })
    ok(longSite.items.length === 6 && longSite.truncated, '先去站外结果再按每来源上限取，不因站外结果占名额而变少')
    const timeNote = aggregate([{ source: 'so360', rows: [{ title: 't', url: 'https://t/1' }], elapsedMs: 1 }, { source: 'ddg', rows: [{ title: 'd', url: 'https://d/1' }], elapsedMs: 1 }], { limitPerSource: 6, limitTotal: 12, recent: 'day' })
    ok(/不支持按时间过滤/.test(timeNote.sources[0].message ?? '') && !timeNote.sources[1].message, '不支持时间范围的来源如实标注，支持的不标')
    const skipped = aggregate([{ source: 'bing', rows: null, skipped: true, elapsedMs: 5 }], { limitPerSource: 6, limitTotal: 12 })
    ok(skipped.sources[0].status === 'skipped' && /提前停止/.test(summarizeSources(skipped.sources)), '提前停止的来源标 skipped，摘要写清')
    ok(/被总数上限截断/.test(summarizeSources(totalCap.sources)), '摘要里说清是被上限截断，而不是干脏的「0 条」')
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

  {
    const e = parseBackendError('ok: false\nerror:\n  code: BROWSER_CONNECT\n  message: Browser Bridge extension not connected\n')
    ok(e.code === 'BROWSER_CONNECT', '从 YAML 里抠出 code')
    ok(/extension/.test(e.message ?? ''), '抠出 message')
    ok(parseBackendError('纯文本错误').message === '纯文本错误', '抠不出来就原样给文本（不吞）')
  }

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

  {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const rows = (id, n) => Array.from({ length: n }, (_, i) => ({ title: `${id}${i}`, url: `https://${id}/${i}` }))
    const policy = { primary: ['tavily'], reserve: ['brave', 'so360'], enoughRows: 3, graceMs: 30 }
    const deps = (impl) => {
      const calls = []
      return {
        calls,
        now: () => Date.now(),
        runner: async (source, query, opts) => {
          calls.push({ id: source.id, opts })
          return impl(source.id, opts)
        }
      }
    }

    let aborted = false
    const fast = deps(async (id, opts) => {
      if (id === 'tavily') return { source: id, rows: rows(id, 6), elapsedMs: 5 }
      opts.signal.addEventListener('abort', () => { aborted = true })
      await wait(2000)
      return { source: id, rows: rows(id, 6), elapsedMs: 2000 }
    })
    const started = Date.now()
    const early = await runSearch({ text: 'q', sources: ['tavily', 'bing'], recent: 'week', sites: ['tavily'] }, fast, policy)
    ok(Date.now() - started < 1000, '付费来源够用后，网页引擎在宽限期后被提前停止')
    ok(aborted, '停止时通知了网页引擎（关掉隐藏窗口）')
    ok(early.sources.find((s) => s.source === 'bing')?.status === 'skipped', '被停掉的来源标 skipped')
    ok(early.items.length === 6 && fast.calls.length === 2, '没有动用后备来源')
    ok(fast.calls[0].opts.recent === 'week' && fast.calls[0].opts.sites?.[0] === 'tavily', '时间范围与站点限定传给每个来源')

    const quick = deps(async (id) => {
      if (id === 'tavily') return { source: id, rows: rows(id, 6), elapsedMs: 5 }
      await wait(10)
      return { source: id, rows: rows(id, 2), elapsedMs: 10 }
    })
    const both = await runSearch({ text: 'q', sources: ['tavily', 'bing'] }, quick, policy)
    ok(both.sources.every((s) => s.status === 'ok') && both.items.length === 8, '宽限期内返回的网页引擎结果照样合并')

    const failing = deps(async (id) => {
      if (id === 'tavily') return { source: id, rows: null, error: { code: 'rate_limited', message: '额度用尽' }, elapsedMs: 5 }
      if (id === 'brave') return { source: id, rows: rows(id, 4), elapsedMs: 5 }
      return { source: id, rows: rows(id, 3), elapsedMs: 5 }
    })
    const fallback = await runSearch({ text: 'q', sources: ['tavily', 'bing'] }, failing, policy)
    ok(failing.calls.map((c) => c.id).join(',') === 'tavily,bing,brave', '付费来源出错 → 换下一个付费来源，不碰最后的网页后备')
    ok(fallback.sources.map((s) => `${s.source}:${s.status}`).join(',') === 'tavily:error,bing:ok,brave:ok', '出错的来源照实汇报，后备来源排在后面')

    const allPaidFail = deps(async (id) =>
      id === 'bing' ? { source: id, rows: rows(id, 3), elapsedMs: 5 } : { source: id, rows: null, error: { code: 'http_error' }, elapsedMs: 5 })
    await runSearch({ text: 'q', sources: ['tavily', 'bing'] }, allPaidFail, policy)
    ok(allPaidFail.calls.map((c) => c.id).join(',') === 'tavily,bing,brave,so360', '付费来源都失败 → 用上第二个网页引擎')

    const noPolicy = deps(async (id) => {
      await wait(id === 'bing' ? 60 : 5)
      return { source: id, rows: rows(id, 6), elapsedMs: 5 }
    })
    const explicit = await runSearch({ text: 'q', sources: ['tavily', 'bing'] }, noPolicy)
    ok(explicit.sources.every((s) => s.status === 'ok'), '点名来源（没有策略）时等所有来源返回')
  }

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

    const bad = await createOpencliRunner('node')(SEARCH_SOURCES[0], 'q', { limit: 1, timeoutMs: 8000 })
    ok(bad.rows === null && !!bad.error, '输出不是 JSON 数组 → 不当作空结果')
    ok(bad.error.code !== 'timeout', '不是超时就不要写成超时')
  }

  {
    const dir = mkdtempSync(join(tmpdir(), 'yan-opencli-wire-'))
    const fake = (name, body) => {
      const file = join(dir, name)
      writeFileSync(file, body)
      return file
    }
    const source = SEARCH_SOURCES[0]
    const run = (file, timeoutMs = 15_000) => createOpencliRunner(file)(source, 'q', { limit: 2, timeoutMs })

    const envelope = fake(
      'envelope.mjs',
      'console.log(JSON.stringify({ ok: true, data: [{ title: "W", url: "https://w/1", snippet: "s" }] }))\n'
    )
    const wrapped = await run(envelope)
    ok(wrapped.rows?.length === 1 && wrapped.rows[0].title === 'W', 'opencli 2.0 的 {ok,data} 外壳能取出结果数组')
    ok(!wrapped.error, '{ok:true,data:[…]} 不再被当成后端错误')

    const nested = fake('nested.mjs', 'console.log(JSON.stringify({ ok: true, data: { results: [{ title: "R" }] } }))\n')
    const nestedRun = await run(nested)
    ok(nestedRun.rows?.length === 1 && nestedRun.rows[0].title === 'R', '外壳里的 results / items 容器也认')

    const bare = fake('bare.mjs', 'console.log(JSON.stringify([{ title: "B" }]))\n')
    const bareRun = await run(bare)
    ok(bareRun.rows?.length === 1 && bareRun.rows[0].title === 'B', '直接输出数组的旧格式仍然可用')

    const emptyData = fake('empty.mjs', 'console.log(JSON.stringify({ ok: true, data: [] }))\n')
    const emptyRun = await run(emptyData)
    ok(Array.isArray(emptyRun.rows) && emptyRun.rows.length === 0 && !emptyRun.error, '外壳里是空数组 → empty，不是错误')

    const failed = fake(
      'failed.mjs',
      'console.log(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "No articles found" } }))\nprocess.exitCode = 1\n'
    )
    const failure = await run(failed)
    ok(failure.rows === null && failure.error?.code === 'NOT_FOUND', '外壳里的失败码照实上报（不是 backend_error）')
    ok(/No articles found/.test(failure.error?.message ?? ''), '外壳里的失败说明照实上报（不是整段 JSON）')

    const huge = fake('huge.mjs', 'process.stdout.write("[" + "1,".repeat(400000))\n')
    const hugeRun = await run(huge)
    ok(hugeRun.rows === null && hugeRun.error?.code === 'output_too_large', '超出输出上限 → output_too_large')
  }

  {
    const inElectronFound = resolveJsRuntime(() => 'C:\\nodejs\\node.exe', 'C:\\electron\\electron.exe', true)
    ok(inElectronFound.file === 'C:\\nodejs\\node.exe', 'Electron 下跑 JS 入口改用 PATH 里的真实 node')
    ok(!inElectronFound.error, '找到真实 node 时不报错')

    const inElectronMissing = resolveJsRuntime(() => null, 'C:\\electron\\electron.exe', true)
    ok(!!inElectronMissing.error, 'Electron 下找不到真实 node → 如实报错（不拿 Electron 硬跑）')
    ok(/commander|参数/.test(inElectronMissing.error ?? ''), '错误说明能指出 commander / 参数解析这个真实原因')
    ok(!/YAN_OPENCLI_JS/.test(inElectronMissing.error ?? ''), '不再把 YAN_OPENCLI_JS 说成能指定 node（它指的是 OpenCLI 入口）')

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

    const timedOut = await searchDoctor({
      runner: async (args) =>
        args[0] === '--version'
          ? { code: 0, stdout: '1.8.8\n', stderr: '' }
          : { code: -1, stdout: 'opencli v1.8.8 doctor (node v24.19.0)\n', stderr: '', timedOut: true }
    })
    ok(timedOut.available === false, 'doctor 探针超时（哪怕已打出头部）→ 不报「已就绪」')
    ok(timedOut.code === 'backend_unusable', '超时也归入 backend_unusable')
    ok(/超时/.test(timedOut.detail), 'detail 里写明是超时，而不是含糊的「跑不起来」')

    const versionTimeout = await searchDoctor({
      runner: async (args) =>
        args[0] === '--version'
          ? { code: -1, stdout: '', stderr: '', timedOut: true }
          : { code: 0, stdout: 'opencli v1.8.8 doctor\n[OK] Daemon: running\n', stderr: '' }
    })
    ok(versionTimeout.available === false, '--version 探针超时 → 不报可用')
    ok(/超时/.test(versionTimeout.detail), '--version 超时也说清是超时（不是「未安装」）')

    const binDir = mkdtempSync(join(tmpdir(), 'yan-nodebin-'))
    const fakeElectron = join(binDir, 'electron.exe')
    writeFileSync(fakeElectron, 'not-really-electron')
    const electronAsNode = resolveJsRuntime(() => null, 'C:\\electron\\electron.exe', true, fakeElectron)
    ok(!!electronAsNode.error && /Electron/.test(electronAsNode.error), 'YAN_NODE_BIN 指向 Electron → 如实拦下')

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
