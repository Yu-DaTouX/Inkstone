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
    searchSummary
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
    ok(normalizeQuery({ text: 'x', sources: ['nope'] }).code === 'no_source', '全是未知来源 → no_source')
    const clamped = normalizeQuery({ text: 'x', limitPerSource: 999, limitTotal: 0, timeoutMs: 10 })
    ok(clamped.ok && clamped.limitPerSource === SEARCH_LIMIT_PER_SOURCE_MAX, '每来源条数被夹到上限')
    ok(clamped.ok && clamped.limitTotal === 1, '总条数至少 1')
    ok(clamped.ok && clamped.timeoutMs === 1000, '超时至少 1s')
  }

  /* ---- 文本清洗 ---- */
  {
    ok(decodeEntities('&quot;砚&quot; &amp; &#65;') === '"砚" & A', 'HTML 实体解码（含数字实体）')
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

    const totalCap = aggregate(
      [
        { source: 'wikipedia', rows: many, elapsedMs: 1 },
        { source: 'arxiv', rows: many, elapsedMs: 1 }
      ],
      { limitPerSource: 10, limitTotal: 5 }
    )
    ok(totalCap.items.length === 5, '总数上限生效')
    ok(totalCap.truncated === true, '被总数上限裁过 → truncated')

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

    /* 用系统的 node 当「后端」：它拿不到合法 JSON，会走 bad_output 分支（同样是可区分状态） */
    const bad = await createOpencliRunner('node')(SEARCH_SOURCES[0], 'q', { limit: 1, timeoutMs: 8000 })
    ok(bad.rows === null && !!bad.error, '输出不是 JSON 数组 → 不当作空结果')
    ok(bad.error.code !== 'timeout', '不是超时就不要写成超时')
  }
}
