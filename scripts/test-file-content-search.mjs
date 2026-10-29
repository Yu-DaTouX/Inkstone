import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fakeGrep(corpus) {
  return async (job) => {
    const caseless = job.query.startsWith('(?i)')
    const source = caseless ? job.query.slice(4) : job.query
    const flags = caseless || job.smartCase ? 'iu' : 'u'
    const pattern = job.mode === 'regex' ? new RegExp(source, flags) : new RegExp(escapeRegExp(source), flags)
    const lines = []
    for (const file of corpus) {
      file.text.split('\n').forEach((text, index) => {
        pattern.lastIndex = 0
        if (pattern.test(text)) lines.push({ path: file.path, line: index + 1, text })
      })
    }
    return { lines, filesSearched: corpus.length, totalFiles: corpus.length, filteredFiles: corpus.length, nextCursor: null }
  }
}

export async function runFileContentSearchTests(ok, { searchFileContents, compileContentMatcher, matchContentLines }) {
  const root = await mkdtemp(join(tmpdir(), 'yan-content-search-'))
  try {
    await mkdir(join(root, 'src'), { recursive: true })
    const optsText = 'const Foo = foo_bar + foobar\nfoo(Foo)\n' + ' '.repeat(300) + 'deepfoo tail\n'
    const corpus = [
      { path: 'notes.txt', text: 'alpha\nlintarget here\nomega\n' },
      { path: 'src/case.md', text: 'MiXeDcAsE value\n' },
      { path: 'src/cjk.md', text: '中文命中行 foo\n' },
      { path: 'opts.ts', text: optsText }
    ]
    await writeFile(join(root, 'notes.txt'), corpus[0].text)
    await writeFile(join(root, 'src', 'case.md'), corpus[1].text)
    await writeFile(join(root, 'src', 'cjk.md'), corpus[2].text)
    await writeFile(join(root, 'opts.ts'), corpus[3].text)
    const grep = fakeGrep(corpus)
    const search = (request, extra = {}) => searchFileContents(request, { grep, ...extra })
    const context = { cwd: root, projectId: 'project-test', generation: 7 }

    const lineHit = await search({ ...context, requestId: 'c1', query: 'lintarget' })
    ok(lineHit.status === 'ok' && lineHit.hits.length === 1, '内容搜索命中单个文本行')
    const hit = lineHit.hits[0]
    ok(hit && hit.path === 'notes.txt' && hit.name === 'notes.txt', '内容搜索返回相对路径与文件名')
    ok(hit && hit.line === 2 && hit.text === 'lintarget here', '内容搜索行号从 1 起且文本正确')
    ok(hit && hit.column === 1 && JSON.stringify(hit.ranges) === JSON.stringify([[0, 9]]), '内容搜索返回 1 起的列号与字符区间')
    ok(lineHit.request.requestId === 'c1' && lineHit.request.cwd === root, '内容搜索回显请求身份与 cwd')

    const caseHit = await search({ ...context, requestId: 'c2', query: 'mixedcase' })
    ok(caseHit.status === 'ok' && caseHit.hits.some((h) => h.path === 'src/case.md'), '内容搜索大小写不敏感')

    const empty = await search({ ...context, requestId: 'c8', query: '   ' })
    ok(empty.status === 'empty' && empty.hits.length === 0, '内容搜索空查询返回 empty')

    const literal = await search({ ...context, requestId: 'o1', query: 'foo' })
    const literalLines = literal.hits.filter((h) => h.path === 'opts.ts')
    ok(literalLines.length === 3, '内容搜索默认不区分大小写，每个匹配行一条')
    ok(literalLines[0].column === 7 && JSON.stringify(literalLines[0].ranges) === JSON.stringify([[6, 9], [12, 15], [22, 25]]), '内容搜索返回首个匹配列号与全部匹配区间')
    ok(literalLines[2].text.length < 300 && literalLines[2].text.slice(literalLines[2].ranges[0][0], literalLines[2].ranges[0][1]) === 'foo', '长行片段从匹配前 160 字截取且区间换算正确')

    const cased = await search({ ...context, requestId: 'o2', query: 'Foo', matchCase: true })
    const casedLines = cased.hits.filter((h) => h.path === 'opts.ts')
    ok(casedLines.length === 2 && JSON.stringify(casedLines[0].ranges) === JSON.stringify([[6, 9]]), '区分大小写只命中大小写一致的文本')

    const whole = await search({ ...context, requestId: 'o3', query: 'foo', wholeWord: true })
    const wholeLines = whole.hits.filter((h) => h.path === 'opts.ts')
    ok(wholeLines.length === 2 && JSON.stringify(wholeLines[0].ranges) === JSON.stringify([[6, 9]]), '全字匹配不命中 foo_bar、foobar、deepfoo')

    const cjk = await search({ ...context, requestId: 'o9', query: 'foo' })
    const cjkHit = cjk.hits.find((h) => h.path === 'src/cjk.md')
    ok(cjkHit && JSON.stringify(cjkHit.ranges) === JSON.stringify([[6, 9]]), '非 ASCII 行返回的区间按字符计而不是按字节计')

    const regex = await search({ ...context, requestId: 'o4', query: 'foo\\(\\w+\\)', regexp: true })
    ok(regex.hits.some((h) => h.path === 'opts.ts' && h.line === 2 && JSON.stringify(h.ranges) === JSON.stringify([[0, 8]])), '正则模式按正则匹配')

    const literalParen = await search({ ...context, requestId: 'o5', query: 'foo(' })
    ok(literalParen.status === 'ok' && literalParen.hits.some((h) => h.path === 'opts.ts' && h.line === 2), '非正则模式把特殊字符当字面量')

    const badRegex = await search({ ...context, requestId: 'o6', query: 'foo(', regexp: true })
    ok(badRegex.status === 'pattern' && badRegex.hits.length === 0, '非法正则返回 pattern 状态而不抛错')

    const emptyMatch = await search({ ...context, requestId: 'o7', query: 'x*', regexp: true })
    ok(emptyMatch.status !== 'pattern', '可匹配空串的正则不会死循环')

    const capped = await search({ ...context, requestId: 'c7', query: 'foo', limit: 2 })
    ok(capped.hits.length === 2 && capped.truncated, '内容搜索对命中数量设上限并报告截断')
    ok(capped.truncation?.includes('result-limit'), '命中上限时截断原因为 result-limit')

    const escaped = await search({ cwd: '..', projectId: 'project-test', generation: 1, requestId: 'c9', query: 'lintarget' })
    ok(escaped.status === 'invalid' && escaped.hits.length === 0, '内容搜索拒绝相对越界 cwd')
    const traversed = await search({ ...context, cwd: `${root}/..`, requestId: 'c10', query: 'lintarget' })
    ok(traversed.status === 'invalid' && traversed.hits.length === 0, '内容搜索拒绝带 .. 的 cwd')
    const missing = await search({ ...context, cwd: join(root, 'nope'), requestId: 'c11', query: 'lintarget' })
    ok(missing.status === 'missing' || missing.status === 'invalid', '内容搜索对不存在的 cwd 给出明确状态')

    const aborted = new AbortController()
    aborted.abort('superseded')
    const cancelled = await search({ ...context, requestId: 'a1', query: 'lintarget' }, { signal: aborted.signal })
    ok(cancelled.status === 'cancelled' && cancelled.hits.length === 0, '内容搜索响应 AbortSignal 取消')

    const exploding = await searchFileContents(
      { ...context, requestId: 'a2', query: '(a+)+b', regexp: true },
      { grep: async () => { throw new Error('timeout') } }
    )
    ok(exploding.truncation?.includes('timeout') === true, '匹配超时记为 timeout 截断而不是挂住')
    ok(exploding.hits.length === 0 && exploding.status !== 'ok', '匹配超时后不返回半截命中')

    let ticks = 0
    const expired = await search({ ...context, requestId: 'a3', query: 'lintarget' }, { now: () => (ticks += 1) * 9000 })
    ok(expired.truncation?.includes('timeout') === true, '总期限到达后按 timeout 截断')

    const pages = [
      { lines: [{ path: 'notes.txt', line: 2, text: 'lintarget here' }], filesSearched: 1, totalFiles: 3, filteredFiles: 3, nextCursor: { _offset: 1 } },
      { lines: [{ path: 'notes.txt', line: 3, text: 'lintarget again' }], filesSearched: 1, totalFiles: 3, filteredFiles: 3, nextCursor: null }
    ]
    let pageIndex = 0
    const paged = await search(
      { ...context, requestId: 'p1', query: 'lintarget' },
      { grep: async () => pages[Math.min(pageIndex++, pages.length - 1)] }
    )
    ok(paged.hits.length === 2 && pageIndex === 2, '内容搜索按游标翻页直到拿到够用的命中')
    ok(paged.scannedFiles === 2 && paged.skippedFiles === 0, '内容搜索累加已扫描与跳过文件数')

    const fallback = await search(
      { ...context, requestId: 'p2', query: 'foo(?=_)', regexp: true },
      { grep: async () => ({ lines: [], filesSearched: 1, totalFiles: 3, filteredFiles: 3, nextCursor: null, regexFallback: 'look-around' }) }
    )
    ok(fallback.status === 'pattern', '原生引擎不支持的正则报 pattern 而不是给出错误结果')

    const skipped = await search(
      { ...context, requestId: 'p3', query: 'lintarget' },
      { grep: async () => ({ lines: [], filesSearched: 2, totalFiles: 5, filteredFiles: 2, nextCursor: null }) }
    )
    ok(skipped.skippedFiles === 3 && skipped.status === 'empty', '被过滤掉的文件计入 skippedFiles')

    const matcher = compileContentMatcher('ab', { wholeWord: true })
    ok(JSON.stringify(matcher.match('ab abc xab')) === JSON.stringify([[0, 2]]), '共享的行匹配器仍然可用')
    const outcome = matchContentLines(compileContentMatcher('ab'), ['ab\nab'], 1)
    ok(outcome.limitReached && outcome.matches.length === 1, '共享的行匹配器仍然按上限停止')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
